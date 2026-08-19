import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useProjects } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { isTaskOwner, isAgentAssignedTask } from "../lib/taskOwner";
import { useAgents } from "../api/agents";
import {
  todayStr,
  addDays,
  partitionOverdueToday,
  formatDueLabel,
  MONTHS_SHORT,
} from "../lib/date";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { TaskRow } from "../components/TaskRow";
import {
  DayHours,
  DayColumnsHeader,
  type DayColumnData,
} from "../components/DayHours";
import { RescheduleSheet } from "../components/RescheduleSheet";
import { ActionsMenu } from "../components/ActionsMenu";
import {
  TaskFilterButton,
  TaskFilterSheet,
} from "../components/TaskFilterSheet";
import {
  DEFAULT_TASK_FILTERS,
  filterTasks,
  countActiveTaskFilters,
  buildProjectOptions,
  buildLabelOptions,
  buildAssigneeOptions,
  type TaskFilters,
} from "../lib/taskFilters";
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
  // Для исключения агентских задач из календарной развёртки часов —
  // см. hourDays ниже и isAgentAssignedTask.
  const { data: agents = [] } = useAgents();
  const navigate = useNavigate();
  const today = todayStr();
  const layout = useAppStore((s) => s.taskLayout.today);
  // Цвет блока в сетке часов берётся от проекта задачи (см. DayHours).
  const { data: projects = [] } = useProjects();
  // Назначение времени перетаскиванием в сетке часов (19.08.2026).
  const updateTask = useUpdateTask();
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);
  // 1 день / 3 дня — тумблер внутри самого вида «по часам», см. store/index.ts.
  const hoursSpan = useAppStore((s) => s.hoursSpan);
  const setHoursSpan = useAppStore((s) => s.setHoursSpan);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Single source for "просрочено vs. сегодня" — shared by both layouts
  // (see lib/date.ts) so the list and the board can never quietly disagree
  // about which task belongs where. These are the *raw* sets, before both
  // the "Ждут вас" dedup below AND the project/label/assignee filter — the
  // "…All" suffix marks that: they're what "Сегодня" would show with every
  // filter cleared, used below to tell "genuinely nothing due" (trueEmpty)
  // apart from "filters hid everything" (filteredEmpty).
  const { overdue: rawOverdueAll, todayTasks: rawTodayAll } = useMemo(
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
  const waitingTasksAll = useMemo(() => {
    if (!currentUser) return [];
    return allTasks
      .filter(
        (t) =>
          t.status === "active" &&
          // Владелец трекера принимает и то, что агент завёл сам, —
          // см. lib/taskOwner.ts (правило по роли, 18.08.2026).
          isTaskOwner(currentUser, t) &&
          (t.agent_state === "blocked" || t.agent_state === "review"),
      )
      .sort((a, b) => {
        const rank = (t: ApiTask) => (t.agent_state === "blocked" ? 0 : 1);
        return rank(a) - rank(b);
      });
  }, [allTasks, currentUser]);

  // Filter options built from the full pre-filter screen universe (every
  // task that could ever appear here across all three blocks) — same rule
  // as Inbox/ActivityScreen. The three raw arrays overlap (a waiting task
  // can also be overdue) but build*Options dedups by id/project/label
  // internally, so a plain concat is enough.
  const screenTaskUniverse = useMemo(
    () => [...waitingTasksAll, ...rawOverdueAll, ...rawTodayAll],
    [waitingTasksAll, rawOverdueAll, rawTodayAll],
  );
  const projectFilterOptions = useMemo(
    () => buildProjectOptions(screenTaskUniverse),
    [screenTaskUniverse],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelOptions(screenTaskUniverse),
    [screenTaskUniverse],
  );
  const assigneeFilterOptions = useMemo(
    () => buildAssigneeOptions(screenTaskUniverse),
    [screenTaskUniverse],
  );
  const activeFilterCount = countActiveTaskFilters(filters);

  // Дедуп по приоритету блока: «Ждут вас» → «Просрочено» → «Сегодня». Одна
  // и та же задача рисуется РОВНО один раз, в самом верхнем блоке, которому
  // подходит — владелец явно попросил не видеть повтор строки на экране
  // (предыдущая версия добавляла "Ждут вас" поверх полных списков, отсюда и
  // дубль на скриншоте). Смысл при этом не теряется: TaskRow ниже получает
  // `overdue` по фактической дате задачи, а не по тому, в каком блоке она
  // оказалась, так что плашка «Просрочено» остаётся на строке, ушедшей
  // наверх. Дедуп бежит ПОСЛЕ фильтра (waitingTasks/rawOverdueTasks/
  // rawTodayTasks — уже отфильтрованные по проекту/метке/исполнителю), так
  // что задача, которую фильтр убрал из «Ждут вас», не утаскивает за собой
  // свою же строку в «Просрочено»/«Сегодня» — там она снова проверяется на
  // соответствие фильтру самостоятельно. overdueTasks/todayTasks — уже и
  // отфильтрованные, и вычищенные множества; именно они и есть источник
  // правды для счётчиков в заголовках (пункт "предыдущий агент откатил
  // дедуп из-за разъехавшихся чисел" — здесь числа и списки берутся из
  // одного и того же массива).
  const waitingTasks = useMemo(
    () => filterTasks(waitingTasksAll, filters),
    [waitingTasksAll, filters],
  );
  const rawOverdueTasks = useMemo(
    () => filterTasks(rawOverdueAll, filters),
    [rawOverdueAll, filters],
  );
  const rawTodayTasks = useMemo(
    () => filterTasks(rawTodayAll, filters),
    [rawTodayAll, filters],
  );
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

  // Данные для DayHours — по дням. Первый день («сегодня») собирает те же
  // три блока экрана, что и списочный вид, включая «Ждут вас»: списочный
  // вид разносит задачу ровно по одному блоку (дедуп по waitingIds выше),
  // и без этого дедупа здесь задача, ждущая приёмки, из сетки исчезала бы
  // — а время у неё чаще всего как раз проставлено. Следующие два дня (в
  // 3-дневном виде) — просто задачи с этой датой, без «просрочено/ждут»:
  // эти статусы имеют смысл только у сегодняшнего дня.
  //
  // Агентские задачи в сетку НЕ идут вовсе (19.08.2026, владелец: «нахуя
  // агентские задачи в календаре, они точно уж там не должны находиться»)
  // — в отличие от списочного вида ниже, где они остаются как обычное
  // текстовое напоминание, как было раньше.
  const hourDays: DayColumnData[] = useMemo(() => {
    const withoutAgent = (t: ApiTask) => !isAgentAssignedTask(t, agents);
    const days: DayColumnData[] = [
      {
        date: today,
        tasks: Array.from(
          new Map(
            [...waitingTasks, ...todayTasks, ...overdueTasks].map((t) => [
              t.id,
              t,
            ]),
          ).values(),
        ).filter(withoutAgent),
        isToday: true,
      },
    ];
    if (hoursSpan === 3) {
      for (let i = 1; i <= 2; i++) {
        const date = addDays(today, i);
        days.push({
          date,
          tasks: allTasks.filter((t) => t.due_date === date && withoutAgent(t)),
          isToday: false,
        });
      }
    }
    return days;
  }, [
    today,
    hoursSpan,
    waitingTasks,
    todayTasks,
    overdueTasks,
    allTasks,
    agents,
  ]);

  // trueEmpty (unaffected by filters — from the "…All" sets) still drives
  // the big illustration screen below: it means there's genuinely nothing
  // due today, not that a filter is hiding everything. filteredEmpty is
  // the new, lighter case — something's due, the current filter just
  // doesn't match any of it.
  const trueEmpty =
    !isLoading &&
    !isLoadingUser &&
    !isError &&
    waitingTasksAll.length === 0 &&
    rawOverdueAll.length === 0 &&
    rawTodayAll.length === 0;
  const filteredEmpty =
    !trueEmpty &&
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
      // w-full — только под экран-иллюстрацию (он центрирует содержимое по
      // колонке), а он остался лишь у списка: на доске пустой день рисует
      // обычную доску, и шапка там ведёт себя как всегда.
      className={trueEmpty && layout === "list" ? "w-full" : ""}
      // Owner 2026-08-13 (десятый заход): leading-иконка убрана — только
      // «Сегодня» её имела, все остальные разделы (Входящие, Предстоящее,
      // Обзор) показывают просто текстовый заголовок. Владелец: разное
      // оформление одного и того же элемента навигации выглядело как
      // непоследовательность, не как акцент.
      title="Сегодня"
      // Подписи дней 3-дневной сетки живут ВНУТРИ шапки, а не отдельной
      // строкой под ней (Максим 19.08.2026: «чтобы даты были приклеены к
      // верхней шапке, и уже с них работало затухание, а то сейчас это
      // отдельная плашка, и через промежуток видно таблицу»).
      // Строка дат — в ЛЮБОМ виде «часы», не только в 3-дневном (владелец
      // 19.08.2026: «когда три дня, ты даты указал, а когда один день —
      // нигде даты нет»). Сетка одного дня без подписи не говорила, какое
      // сегодня число.
      below={
        layout === "hours" ? <DayColumnsHeader days={hourDays} /> : undefined
      }
      actions={
        <>
          <TaskFilterButton
            onClick={() => setFilterSheetOpen(true)}
            active={activeFilterCount > 0}
          />
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
              // Все четыре вида экрана — здесь, под тремя точками
              // (19.08.2026, прямое указание владельца: «под троеточие
              // спрячь вот эти вот список, доска, один день, три дня, а
              // не отдельной иконкой»). Отдельная кнопка-часы в шапке,
              // жившая тут с 18.08, этой же правкой убрана: два разных
              // входа в один и тот же выбор — лишний шум в шапке.
              // Текущий вид отмечен цветом и полужирным, как было в её
              // меню.
              {
                icon: "list",
                label: (
                  <span
                    className={
                      layout === "list" ? "font-semibold text-red" : ""
                    }
                  >
                    Список
                  </span>
                ),
                onClick: () => setTaskLayout("today", "list"),
              },
              {
                icon: "grid",
                label: (
                  <span
                    className={
                      layout === "board" ? "font-semibold text-red" : ""
                    }
                  >
                    Доска
                  </span>
                ),
                onClick: () => setTaskLayout("today", "board"),
              },
              {
                icon: "calendar",
                label: (
                  <span
                    className={
                      layout === "hours" && hoursSpan === 1
                        ? "font-semibold text-red"
                        : ""
                    }
                  >
                    Один день
                  </span>
                ),
                onClick: () => {
                  setHoursSpan(1);
                  setTaskLayout("today", "hours");
                },
              },
              {
                icon: "calendarSmall",
                label: (
                  <span
                    className={
                      layout === "hours" && hoursSpan === 3
                        ? "font-semibold text-red"
                        : ""
                    }
                  >
                    Три дня
                  </span>
                ),
                onClick: () => {
                  setHoursSpan(3);
                  setTaskLayout("today", "hours");
                },
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

  // Большая иллюстрация — только для списка. На доске пустой день обязан
  // остаться доской с колонкой «Сегодня» (см. комментарий к boardColumns
  // выше): пилюля «Добавить задачу» живёт в footer'е этой колонки, а кнопка
  // «+» на доске спрятана как раз в её пользу (Layout.tsx,
  // fabReplacedByPill). Пока этот ранний возврат срабатывал в обоих
  // раскладках, пустой день на доске оставался вообще без способа завести
  // задачу: и «+» скрыт, и пилюли нет. Найдено Максимом 14.08.2026.
  if (trueEmpty && layout === "list") {
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
      {filteredEmpty && (
        <div className="px-1 pt-2 flex items-center gap-2 flex-wrap text-[13px] text-dim">
          Под выбранные фильтры ничего не подошло
          <button
            onClick={() => setFilters(DEFAULT_TASK_FILTERS)}
            className="text-red font-medium"
          >
            Сбросить фильтры
          </button>
        </div>
      )}
      {layout === "hours" ? (
        <>
          {/* 1 день / 3 дня — больше НЕ пилюля-переключатель в теле
              экрана (19.08.2026, третий заход: «вместо бегунка сделай
              просто там, где изначально выбирается... нажимаю туда, и
              там написано один день, три дня и всё»). Выбор переехал в
              меню кнопки-часов в шапке, см. её комментарий выше —
              hoursSpan (стор) от этого не изменился, поменялся только
              способ его поменять. */}
          {/* Просроченные в сетку дня НЕ идут: вчерашняя задача на 9:00 не
              должна рисоваться в сегодняшних девяти утра. Они остаются в
              нижнем списке вместе с задачами без времени. */}
          <DayHours
            days={hourDays}
            projectColor={(t) =>
              projects.find((p) => p.id === t.project_id)?.color || "#717171"
            }
            onTaskClick={(id) => navigate(`/task/${id}`)}
            // Перетащили задачу на шкалу — сразу назначаем время. Срок при
            // этом проставляем сегодняшним, если его не было: сервер не
            // примет время без даты, а задача, которую человек кладёт в
            // сетку СЕГОДНЯШНЕГО дня, на сегодня и планируется. Работает
            // только в 1-дневном виде — см. комментарий у DayHours.interactive.
            //
            // Длительность — 15 минут (SNAP_MIN, минимальный шаг сетки),
            // если её раньше не было (19.08.2026, владелец: «должно
            // вставать минимальное количество времени — 15 минут
            // длительность»). Только когда её НЕ БЫЛО — иначе повторное
            // перетаскивание уже расписанной 2-часовой задачи молча
            // срезало бы её до 15 минут. Без этого duration_min оставался
            // null, и DayHours рисовал размытый низ («конец не задан») —
            // визуально «замылено» там, где владелец ждал ровную плашку.
            onSchedule={(id, time) => {
              const task = allTasks.find((t) => t.id === id);
              updateTask.mutate({
                id,
                start_time: time,
                ...(task?.due_date ? null : { due_date: today }),
                ...(task?.duration_min == null ? { duration_min: 15 } : null),
              });
            }}
          />
        </>
      ) : layout === "board" ? (
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
              showDueBadge={false}
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
              showDueBadge={false}
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
          {/* С числом, как заголовок колонки на доске (formatColumnDateLabel
              там же ниже) — владелец 19.08.2026: голое «Сегодня» без даты
              не читалось на фоне «Ждут вас» так же ясно, как дата в доске. */}
          {todayTasks.length > 0 &&
            (overdueTasks.length > 0 || waitingTasks.length > 0) && (
              <div className="text-[13px] font-semibold text-sub px-1 pt-3 pb-1">
                {formatDueLabel(today)}
              </div>
            )}
          {todayTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              overdue={false}
              showAgentState
              showDueBadge={false}
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

      <TaskFilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        setFilters={setFilters}
        projectOptions={projectFilterOptions}
        labelOptions={labelFilterOptions}
        assigneeOptions={assigneeFilterOptions}
      />
    </div>
  );
}
