import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useCurrentUser } from "../api/auth";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { todayStr, partitionOverdueToday, MONTHS_SHORT } from "../lib/date";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { TaskRow } from "../components/TaskRow";
import { RescheduleSheet } from "../components/RescheduleSheet";
import { ActionsMenu } from "../components/ActionsMenu";
import type { ApiTask } from "../api/types";

const WEEKDAYS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

// "10 авг. · Понедельник" — matches the "Сегодня" board column's header,
// which stands in for a project-color dot with a date instead (this
// column isn't a project, so a date is the thing that actually identifies
// it).
function formatColumnDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}. · ${WEEKDAYS_FULL[d.getDay()]}`;
}

export function TodayScreen() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const { data: currentUser, isLoading: isLoadingUser } = useCurrentUser();
  const navigate = useNavigate();
  const today = todayStr();
  const layout = useAppStore((s) => s.taskLayout.today);
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  // Single source for "просрочено vs. сегодня" — shared by both layouts
  // (see lib/date.ts) so the list and the board can never quietly disagree
  // about which task belongs where. These are the *raw* sets, before the
  // "Ждут вас" dedup below strips out whatever already surfaced there.
  const { overdue: rawOverdueTasks, todayTasks: rawTodayTasks } = useMemo(
    () => partitionOverdueToday(allTasks, today),
    [allTasks, today],
  );

  // «Ждут вас» — вычисляемая выборка, НЕ переброска assignee_id
  // (AGENT-PROTOCOL.md, "Ответственный: assignee_id не переписываем"):
  // исполнителя задачи никто не меняет, иначе агент теряет доступ к своей
  // же задаче. Я — создатель (creator_id), а агент встал (blocked) или
  // сдал на проверку (review). Заблокированные — первыми: по формулировке
  // протокола именно они "требуют действий владельца" сильнее, чем
  // готовая-к-приёмке работа.
  const waitingTasks = useMemo(() => {
    if (!currentUser) return [];
    return allTasks
      .filter(
        (t) =>
          t.status === "active" &&
          t.creator_id === currentUser.id &&
          (t.agent_state === "blocked" || t.agent_state === "review"),
      )
      .sort((a, b) => {
        const rank = (t: ApiTask) => (t.agent_state === "blocked" ? 0 : 1);
        return rank(a) - rank(b);
      });
  }, [allTasks, currentUser]);

  // Дедуп по приоритету блока: «Ждут вас» → «Просрочено» → «Сегодня». Одна
  // и та же задача рисуется РОВНО один раз, в самом верхнем блоке, которому
  // подходит — владелец явно попросил не видеть повтор строки на экране
  // (предыдущая версия добавляла "Ждут вас" поверх полных списков, отсюда и
  // дубль на скриншоте). Смысл при этом не теряется: TaskRow ниже получает
  // `overdue` по фактической дате задачи, а не по тому, в каком блоке она
  // оказалась, так что плашка «Просрочено» остаётся на строке, ушедшей
  // наверх. overdueTasks/todayTasks — теперь уже вычищенные множества;
  // именно они и есть источник правды для счётчиков в заголовках (пункт
  // "предыдущий агент откатил дедуп из-за разъехавшихся чисел" — здесь
  // числа и списки берутся из одного и того же массива).
  const waitingIds = useMemo(
    () => new Set(waitingTasks.map((t) => t.id)),
    [waitingTasks],
  );
  const overdueTasks = useMemo(
    () => rawOverdueTasks.filter((t) => !waitingIds.has(t.id)),
    [rawOverdueTasks, waitingIds],
  );
  const todayTasks = useMemo(
    () => rawTodayTasks.filter((t) => !waitingIds.has(t.id)),
    [rawTodayTasks, waitingIds],
  );

  const isEmpty =
    !isLoading &&
    !isLoadingUser &&
    !isError &&
    overdueTasks.length === 0 &&
    todayTasks.length === 0 &&
    waitingTasks.length === 0;

  // Доска «Сегодня» — НЕ по проектам (прямое решение владельца): ровно две
  // колонки, «Просрочено» и «Сегодня», тот же состав и порядок, что и в
  // списке выше. «Просрочено» колонка целиком отсутствует, когда
  // просроченных нет — половина экрана под пустую колонку выглядела бы как
  // поломка, а список рядом уже прячет свой заголовок «Просрочено» точно
  // так же в этом случае, так что оба layout'а ведут себя одинаково.
  // «Сегодня» колонка, наоборот, всегда на доске (даже пустая, с кнопкой
  // «Добавить задачу») — это тот самый экран, ради которого сюда пришли.
  const boardColumns: BoardColumn[] = useMemo(() => {
    const cols: BoardColumn[] = [];
    // Тот же принцип, что и «Просрочено»: колонка целиком отсутствует,
    // когда ждать нечего, а не висит пустой половиной экрана. BoardCard
    // (TaskBoard.tsx) рисует тот же AgentStateTag, что и список, только в
    // compact-варианте (без "· N мин назад" — тесно на 260px колонке).
    // overdueTasks и todayTasks уже вычищены от задач, ушедших в «Ждут вас»
    // (см. дедуп выше) — так что и здесь колонки не дублируют карточку, а
    // счётчик в заголовке (interpolated ниже) совпадает с длиной tasks.
    if (waitingTasks.length > 0) {
      cols.push({
        id: "waiting",
        title: `Ждут вас ${waitingTasks.length}`,
        tasks: waitingTasks,
        showProjectBadge: true,
      });
    }
    if (overdueTasks.length > 0) {
      cols.push({
        id: "overdue",
        title: `Просрочено ${overdueTasks.length}`,
        titleClassName: "text-red",
        tasks: overdueTasks,
        dueBadgeVariant: "overdue",
        showProjectBadge: true,
        headerAction: (
          <button
            onClick={() => setRescheduleOpen(true)}
            className="tap-fade shrink-0 min-h-11 px-2.5 flex items-center justify-center rounded-lg text-[12px] font-semibold text-red"
          >
            Перенести
          </button>
        ),
      });
    }
    cols.push({
      id: "today",
      title: formatColumnDateLabel(today),
      tasks: todayTasks,
      showProjectBadge: true,
      footer: (
        /* Пунктир и акцентный цвет — тот же приём, что у «Создать проект»
           и «Создать метку» в этом же приложении: заливка bg-card совпадала
           с фоном карточек задач, и кнопка сливалась со списком. */
        <button
          onClick={() => navigate("/task/new")}
          className="tap-row w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-dashed border-red/40 bg-red/5 text-[13px] font-semibold text-red"
        >
          <Icon name="plus" size={16} />
          Добавить задачу
        </button>
      ),
    });
    return cols;
  }, [waitingTasks, overdueTasks, todayTasks, today, navigate]);

  const header = (
    <ScreenHeader
      className={isEmpty ? "w-full" : ""}
      leading={
        <div className="bg-card/60 rounded-full p-2">
          <Icon name="calendarSmall" size={22} className="text-text" />
        </div>
      }
      title="Сегодня"
      actions={
        <>
          <button
            ref={menuAnchorRef}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Ещё"
            className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
          >
            <Icon name="dots" size={18} />
          </button>
          <ActionsMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={menuAnchorRef}
            items={[
              {
                icon: layout === "list" ? "grid" : "list",
                label:
                  layout === "list" ? "Показать доской" : "Показать списком",
                onClick: () =>
                  setTaskLayout("today", layout === "list" ? "board" : "list"),
              },
              {
                icon: "search",
                label: "Поиск",
                onClick: () => navigate("/search"),
              },
            ]}
          />
        </>
      }
    />
  );

  if (isEmpty) {
    return (
      <div className="px-4 pb-4 flex flex-col items-center">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center mt-8">
          <svg width="200" height="180" viewBox="0 0 200 180" className="mb-6">
            <circle cx="100" cy="80" r="48" fill="#2B2B2B" />
            <circle cx="85" cy="72" r="4" fill="white" />
            <circle cx="115" cy="72" r="4" fill="white" />
            <path
              d="M88 90 Q100 100 112 90"
              stroke="white"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <ellipse
              cx="68"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(-20 68 55)"
            />
            <ellipse
              cx="132"
              cy="55"
              rx="6"
              ry="3"
              fill="#35B8A3"
              transform="rotate(20 132 55)"
            />
            <circle
              cx="50"
              cy="130"
              r="18"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="150"
              cy="120"
              r="14"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="2"
            />
            <circle
              cx="80"
              cy="150"
              r="10"
              fill="none"
              stroke="#8FBF9F"
              strokeWidth="1.5"
            />
          </svg>
          <h3 className="text-[17px] font-semibold mb-2">
            Чёткое видение грядущего дня
          </h3>
          <p className="text-[14px] text-sub text-center px-8 leading-relaxed">
            Задачи на сегодня появятся здесь, когда вы назначите дедлайн.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      {header}
      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить задачи"
        className="mt-2"
      />
      {layout === "board" ? (
        <div className="mt-2">
          <TaskBoard
            columns={boardColumns}
            onTaskClick={(id) => navigate(`/task/${id}`)}
            isLoading={isLoading}
          />
        </div>
      ) : (
        <div className="space-y-[2px]">
          {waitingTasks.length > 0 && (
            <div className="flex items-center gap-1.5 px-1 pt-2 pb-1">
              <Icon name="bot" size={13} className="text-text" />
              <span className="text-[13px] font-semibold text-text">
                Ждут вас
              </span>
            </div>
          )}
          {waitingTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              // Дедуп прячет строку из «Просрочено», но не факт: если задача
              // и правда просрочена, красная плашка «Просрочено, …» остаётся
              // на ней и здесь, в «Ждут вас» (см. rawOverdueTasks выше).
              overdue={t.due_date !== null && t.due_date < today}
              showAgentState
              maxLabels={0}
              showDueBadge={false}
              showSubtasksBadge={false}
              showAvatar={false}
              onClick={() => navigate(`/task/${t.id}`)}
            />
          ))}
          {overdueTasks.length > 0 && (
            <div className="flex items-center gap-1.5 px-1 pt-2 pb-1">
              <span className="text-[13px] font-semibold text-red">
                Просрочено
              </span>
            </div>
          )}
          {overdueTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              overdue
              showAgentState
              maxLabels={0}
              showDueBadge={false}
              showSubtasksBadge={false}
              showAvatar={false}
              onClick={() => navigate(`/task/${t.id}`)}
            />
          ))}
          {/* Раньше проверялось только overdueTasks.length > 0 — но после
              дедупа overdueTasks может опустеть, даже когда над «Сегодня»
              всё равно есть блок («Ждут вас» в одиночку съел единственную
              просроченную задачу). Без waitingTasks в условии подпись
              «Сегодня» пропадала бы, и сегодняшние строки визуально сливались
              бы с «Ждут вас» — та же путаница с местом задачи, которую и
              просили убрать. */}
          {todayTasks.length > 0 &&
            (overdueTasks.length > 0 || waitingTasks.length > 0) && (
              <div className="text-[13px] font-semibold text-sub px-1 pt-3 pb-1">
                Сегодня
              </div>
            )}
          {todayTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              overdue={false}
              showAgentState
              maxLabels={0}
              showDueBadge={false}
              showSubtasksBadge={false}
              showAvatar={false}
              onClick={() => navigate(`/task/${t.id}`)}
            />
          ))}
        </div>
      )}

      <RescheduleSheet
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        taskIds={overdueTasks.map((t) => t.id)}
      />
    </div>
  );
}
