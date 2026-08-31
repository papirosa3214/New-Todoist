import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOpenTask } from "../lib/useOpenTask";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useProjects } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { isAgentAssignedTask, isWaitingForUser, waitingBlockedFirst } from "../lib/taskOwner";
import { useAgents } from "../api/agents";
import {
  todayStr,
  partitionOverdueToday,
  formatDueLabel,
  MONTHS_SHORT,
} from "../lib/date";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { TaskRow } from "../components/TaskRow";
import { DayHours, type DayColumnData } from "../components/DayHours";
import { AppleCalendarEvents } from "../components/AppleCalendarEvents";
import { RescheduleSheet } from "../components/RescheduleSheet";
import { ActionsMenu } from "../components/ActionsMenu";
import {
  TaskFilterButton,
  TaskFilterSheet,
} from "../components/TaskFilterSheet";
import {
  DEFAULT_TASK_FILTERS,
  filterTasks,
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

// "Четверг, 20 авг." — заголовок шапки в виде «часы», тот же порядок и
// пунктуация, что у formatDueLabel ("Сегодня, 20 авг."). Владелец
// 20.08.2026: «мы разве не можем четверг, двадцатая указывать там, где
// написано „Сегодня“, прямо в шапке» — раньше день недели+число жили ниже
// отдельной плашкой (DayColumnsHeader), а шапка молчала статичным словом
// «Сегодня»; теперь дата и есть заголовок, плашка снизу для одного дня
// больше не нужна (компонент остался — им по-прежнему пользуется
// «Предстоящее», там дней несколько).
function formatWeekdayDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${WEEKDAYS_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}.`;
}

export function TodayScreen() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const { data: currentUser, isLoading: isLoadingUser } = useCurrentUser();
  // Для исключения агентских задач из календарной развёртки часов —
  // см. hourDays ниже и isAgentAssignedTask.
  const { data: agents = [] } = useAgents();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const today = todayStr();
  const layout = useAppStore((s) => s.taskLayout.today);
  // Цвет блока в сетке часов берётся от проекта задачи (см. DayHours).
  const { data: projects = [] } = useProjects();
  // Назначение времени перетаскиванием в сетке часов (19.08.2026).
  const updateTask = useUpdateTask();
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Шаг 2 (feature/projects-decouple-planner-merge): opt-in список
  // проектов для ежедневника. Семантика «включить проект в раздел».
  // По умолчанию {} — пустой выбор = только входящие (как в Шаге 1).
  // Чтобы добавить проект в ежедневник, пользователь тапает [+] в
  // полоске чипов (PlannerProjectChips) и выбирает в picker внутри
  // TaskFilterSheet. Раннее поле hiddenDailyPlannerProjects (Шаг 0,
  // до Шага 1) имело противоположную семантику и удалено в Шаге 3.
  const visibleProjectIds = useAppStore((s) => s.plannerVisibleProjects);
  const togglePlannerVisibleProject = useAppStore(
    (s) => s.togglePlannerVisibleProject,
  );

  // Отфильтрованный по видимым проектам универсум задач — источник для
  // всего экрана (список/доска/сетка часов) ниже. Задачи без project_id
  // (Входящие) присутствуют всегда; проектные задачи попадают, только
  // если пользователь явно opt-in'нул проект в picker'е.
  const plannerTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => !t.project_id || !!visibleProjectIds[t.project_id],
      ),
    [allTasks, visibleProjectIds],
  );

  // Single source for "просрочено vs. сегодня" — shared by both layouts
  // (see lib/date.ts) so the list and the board can never quietly disagree
  // about which task belongs where. These are the *raw* sets, before both
  // the "Ждут вас" dedup below AND the project/label/assignee filter — the
  // "…All" suffix marks that: they're what "Сегодня" would show with every
  // filter cleared, used below to tell "genuinely nothing due" (trueEmpty)
  // apart from "filters hid everything" (filteredEmpty).
  const { overdue: rawOverdueAll, todayTasks: rawTodayAll } = useMemo(
    () => partitionOverdueToday(plannerTasks, today),
    [plannerTasks, today],
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
    return plannerTasks
      .filter((t) => isWaitingForUser(t, currentUser))
      .sort(waitingBlockedFirst);
  }, [plannerTasks, currentUser]);

  // «…All» raw sets (waiting/overdue/today) уже вычислены от
  // plannerTasks выше — они и есть «экран»: рендер строк списка/доски
  // и счётчики в заголовках. screenTaskUniverse, который тут раньше
  // жил как concat трёх …All, ушёл вместе с фиксом блокера 2
  // (*FilterOptions теперь берутся из полного optionUniverse, чтобы
  // секции «Проект»/«Метка»/«Исполнитель» в шторке фильтра не
  // ограничивались текущим подмножеством видимых).
  const optionUniverse = useMemo(() => allTasks, [allTasks]);
  const projectFilterOptions = useMemo(
    () => buildProjectOptions(optionUniverse),
    [optionUniverse],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelOptions(optionUniverse),
    [optionUniverse],
  );
  const assigneeFilterOptions = useMemo(
    () => buildAssigneeOptions(optionUniverse),
    [optionUniverse],
  );

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

  // Данные для DayHours — РОВНО один день («сегодня»): 3-дневная развёртка
  // отсюда переехала в «Предстоящее» 20.08.2026 (владелец: «перенести из
  // раздела „сегодня“ вид „три дня“... а из „сегодня“ его убрать»);
  // DayHours сам по себе span-агностичен (принимает days: DayColumnData[]
  // любой длины), здесь просто всегда ровно один элемент. День собирает те
  // же три блока экрана, что и списочный вид, включая «Ждут вас»:
  // списочный вид разносит задачу ровно по одному блоку (дедуп по
  // waitingIds выше), и без этого дедупа здесь задача, ждущая приёмки, из
  // сетки исчезала бы — а время у неё чаще всего как раз проставлено.
  //
  // Агентские задачи в сетку НЕ идут вовсе (19.08.2026, владелец: «нахуя
  const [hourDateOffset, setHourDateOffset] = useState(0);
  const activeHourDate = useMemo(() => {
    if (hourDateOffset === 0) return today;
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() + hourDateOffset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, [today, hourDateOffset]);

  const hourDays: DayColumnData[] = useMemo(() => {
    const withoutAgent = (t: ApiTask) => !isAgentAssignedTask(t, agents);
    const dateTasks = plannerTasks.filter((t) => t.due_date === activeHourDate);
    const combined =
      activeHourDate === today
        ? Array.from(
            new Map(
              [...waitingTasks, ...todayTasks, ...overdueTasks].map((t) => [
                t.id,
                t,
              ]),
            ).values(),
          )
        : dateTasks;
    return [
      {
        date: activeHourDate,
        tasks: combined.filter(withoutAgent),
        isToday: activeHourDate === today,
      },
    ];
  }, [
    activeHourDate,
    today,
    waitingTasks,
    todayTasks,
    overdueTasks,
    plannerTasks,
    agents,
  ]);

  // trueEmpty (unaffected by filters — from the "…All" sets) still drives
  // the big illustration screen below: it means there's genuinely nothing
  // due today, not that a filter is hiding everything. filteredEmpty is
  // the new, lighter case — something's due, the current filter just
  // doesn't match any of it.
  // Шаг 1 (фикс): trueEmpty теперь опирается на «искренние» множества от
  // allTasks целиком, а не на plannerTasks. До Шага 1 plannerTasks = всё
  // минус скрытые проекты, и условие hiddenPlannerProjectCount === 0
  // защищало иллюстрацию «ничего на сегодня» от случая «у пользователя
  // есть задачи в скрытых проектах, мы их не видим — рисовать пустой
  // экран было бы ложью». После Шага 1 plannerTasks = только входящие
  // плюс (если что-то скрыто) видимые проекты — то есть проектные
  // задачи в принципе не попадают в источник. Условие
  // hiddenPlannerProjectCount === 0 утратило смысл как маркер
  // «показываем всё», а «plannerTasks пуст» больше не равно «у юзера
  // ничего нет». Поэтому для trueEmpty берём полный allTasks,
  // отфильтрованный только по дате/agent_state — этот счётчик отвечает
  // на вопрос «у пользователя вообще есть хоть одна задача, достойная
  // ежедневника», независимо от того, в проекте она или нет.
  const { overdue: trueOverdueAll, todayTasks: trueTodayAll } = useMemo(
    () => partitionOverdueToday(allTasks, today),
    [allTasks, today],
  );
  const trueWaitingAll = useMemo(() => {
    if (!currentUser) return [];
    return allTasks
      .filter((t) => isWaitingForUser(t, currentUser))
      .sort(waitingBlockedFirst);
  }, [allTasks, currentUser]);
  const trueEmpty =
    !isLoading &&
    !isLoadingUser &&
    !isError &&
    trueWaitingAll.length === 0 &&
    trueOverdueAll.length === 0 &&
    trueTodayAll.length === 0;
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
      // Заголовок и есть дата, в любом виде (владелец 20.08.2026: «четверг,
      // двадцатая — там же, где написано „Сегодня“, прямо в шапке»; и следом
      // — «во всех представлениях, и списки, и доска»). Раньше «часы» одни
      // показывали дату (снизу отдельной плашкой), список и доска — статику.
      title={
        layout === "hours"
          ? formatWeekdayDateLabel(activeHourDate)
          : formatWeekdayDateLabel(today)
      }
      // Раньше подпись дня жила отдельной плашкой под шапкой
      // (DayColumnsHeader, история — Максим 19.08.2026: «чтобы даты были
      // приклеены к верхней шапке»). Смысл сохранён — дата приклеена к
      // шапке, просто теперь это сам заголовок, а не строка под ним;
      // отдельная плашка для одного дня стала бы повтором того же числа.
      // Компонент не удалён — им пользуется «Предстоящее» (там дней
      // несколько, заголовком одну дату не выразить).
      actions={
        <>
          {/* Кнопки «Дневник» здесь больше нет (26.08.2026): раздел
              вынесен в веер отдельным пунктом, и вход в него должен быть
              один. До этого он успел побывать пунктом под тремя точками
              и кнопкой в шапке — оба следа сняты. */}
          <TaskFilterButton onClick={() => setFilterSheetOpen(true)} />
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
              // Все виды экрана — здесь, под тремя точками (19.08.2026,
              // прямое указание владельца: «под троеточие спрячь вот эти
              // вот список, доска, один день, три дня, а не отдельной
              // иконкой»). Отдельная кнопка-часы в шапке, жившая тут с
              // 18.08, этой же правкой убрана: два разных входа в один и
              // тот же выбор — лишний шум в шапке. «Три дня» отсюда
              // переехала в «Предстоящее» 20.08.2026 — здесь у «по часам»
              // остался только один вариант, «Один день».
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
                      layout === "hours" ? "font-semibold text-red" : ""
                    }
                  >
                    Один день
                  </span>
                ),
                onClick: () => setTaskLayout("today", "hours"),
              },
              {
                icon: "search",
                label: "Поиск",
                onClick: () => navigate("/search"),
              },
              // «Дневник» отсюда убран 26.08.2026 — он теперь отдельной
              // кнопкой в шапке (см. actions выше).
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
          {/* Аудит 20.08.2026, п.10: три литерала были захардкожены — на
              светлой теме тёмный фон смайлика (#2B2B2B) торчал бы на светлом
              фоне экрана вместо card2 (#ececee). --color-green заодно
              подтягивается к актуальному значению (#15937e) — было заморожено
              на устаревшем #8FBF9F, с 18.08.2026 палитра сменилась везде,
              кроме этой иллюстрации. Белые «глаза»/«рот» — не токен цвета
              темы, оставлены буквальным white осознанно. */}
          <svg width="200" height="180" viewBox="0 0 200 180" className="mb-6">
            <circle cx="100" cy="80" r="48" fill="var(--color-card2)" />
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
              fill="var(--color-teal)"
              transform="rotate(-20 68 55)"
            />
            <ellipse
              cx="132"
              cy="55"
              rx="6"
              ry="3"
              fill="var(--color-teal)"
              transform="rotate(20 132 55)"
            />
            <circle
              cx="50"
              cy="130"
              r="18"
              fill="none"
              stroke="var(--color-green)"
              strokeWidth="2"
            />
            <circle
              cx="150"
              cy="120"
              r="14"
              fill="none"
              stroke="var(--color-green)"
              strokeWidth="2"
            />
            <circle
              cx="80"
              cy="150"
              r="10"
              fill="none"
              stroke="var(--color-green)"
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
      {/* Полоска чипов проектов с [+] убрана по просьбе Максима
          (01.09.2026): тот же выбор проектов ежедневника уже есть в шторке
          фильтров, а над списком задач он только занимал место — «это всё
          есть в фильтре, зачем это наверху». Сам компонент оставлен, выбор
          проектов никуда не делся: он в фильтре, раздел «Ежедневник». */}
      {isLoading && <Loading />}
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
          {/* Просроченные в сетку дня НЕ идут: вчерашняя задача на 9:00 не
              должна рисоваться в сегодняшних девяти утра. Они остаются в
              нижнем списке вместе с задачами без времени. */}
          <DayHours
            days={hourDays}
            projectColor={(t) =>
              projects.find((p) => p.id === t.project_id)?.color || "#717171"
            }
            onTaskClick={openTask}
            onPrevDay={() => setHourDateOffset((o) => o - 1)}
            onNextDay={() => setHourDateOffset((o) => o + 1)}
            // Перетащили задачу на шкалу — назначаем и время, и дату
            // колонки, куда отпустили (20.08.2026: раньше только время, а
            // дата ставилась сегодняшней и только если её раньше не было —
            // работало исключительно в 1-дневном виде, где колонка одна и
            // всегда «сегодня». Теперь колонок может быть три, и владелец
            // явно переносит задачу между днями — дата всегда берётся с
            // той колонки, куда отпустили, даже если у задачи уже была
            // другая: жест переноса сам по себе и есть решение сменить день.
            //
            // Длительность — 15 минут (SNAP_MIN, минимальный шаг сетки),
            // если её раньше не было (19.08.2026, владелец: «должно
            // вставать минимальное количество времени — 15 минут
            // длительность»). Только когда её НЕ БЫЛО — иначе повторное
            // перетаскивание уже расписанной 2-часовой задачи молча
            // срезало бы её до 15 минут. Без этого duration_min оставался
            // null, и DayHours рисовал размытый низ («конец не задан») —
            // визуально «замылено» там, где владелец ждал ровную плашку.
            onSchedule={(id, date, time) => {
              const task = allTasks.find((t) => t.id === id);
              updateTask.mutate({
                id,
                start_time: time,
                due_date: date,
                ...(task?.duration_min == null ? { duration_min: 15 } : null),
              });
            }}
          />
        </>
      ) : layout === "board" ? (
        <div className="mt-2">
          <TaskBoard
            columns={boardColumns}
            onTaskClick={openTask}
            isLoading={isLoading}
          />
        </div>
      ) : (
        <div className="space-y-[2px]">
          <AppleCalendarEvents dateStr={today} className="mb-2.5" />
          {waitingTasks.length > 0 && (
            /* 17px, а не 13px: заголовок раздела был МЕЛЬЧЕ строки задачи
               (15px) и читался как её подпись. Владелец 27.08.2026: «они
               сливаются с текстом, сразу не понять, что это разделы, а не
               просто текст задачи». 17px — ступень title из DESIGN.md,
               ближайшая крупнее body; промежуточных в шкале нет. */
            <div className="flex items-center gap-1.5 px-1 pt-3 pb-1.5">
              <Icon name="bot" size={16} className="text-text" />
              <span className="text-[17px] font-semibold text-text">
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
              onClick={() => openTask(t.id)}
            />
          ))}
          {overdueTasks.length > 0 && (
            <div className="flex items-center gap-1.5 px-1 pt-3 pb-1.5">
              <span className="text-[17px] font-semibold text-red">
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
              onClick={() => openTask(t.id)}
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
              <div className="text-[17px] font-semibold text-sub px-1 pt-3 pb-1.5">
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
              onClick={() => openTask(t.id)}
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
        plannerProjects={{
          projects,
          visibleProjectIds,
          onToggle: togglePlannerVisibleProject,
          // Шаг 2: при тапе по [+] в PlannerProjectChips шторка
          // открывается сразу с раскрытой секцией «Показывать в
          // разделе», чтобы пользователь не делал лишний клик.
          defaultOpenSection: "planner",
        }}
      />
    </div>
  );
}
