import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useProjects } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { useAgents } from "../api/agents";
import {
  todayStr,
  partitionOverdueToday,
  formatDueLabel,
  MONTHS_SHORT,
  addDays,
} from "../lib/date";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import {
  isAgentAssignedTask,
  isWaitingForUser,
  waitingBlockedFirst,
} from "../lib/taskOwner";
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
import { PlannerProjectChips } from "../components/PlannerProjectChips";
import {
  DEFAULT_TASK_FILTERS,
  filterTasks,
  buildProjectOptions,
  buildLabelOptions,
  buildAssigneeOptions,
  type TaskFilters,
} from "../lib/taskFilters";
import { useOpenTask } from "../lib/useOpenTask";
import type { ApiTask, ApiUser } from "../api/types";

// ═══════════ TodayScreenTimeline — полноценный Time-Thread для /today ═══════════
//
// 30.08.2026. Замена TodayScreen.tsx на вариант с тремя «зум-слоями»
// (День / Неделя / Месяц), переключаемыми свайпом по горизонтали. Полная
// логика экрана (фильтры, доска, проект-чипы, ожидающие/просроченные/
// сегодня задачи, drag-to-schedule в сетке часов) переехала сюда без
// потерь.
//
// Доступ: /today (теперь рендерит этот компонент вместо TodayScreen).
// TodayScreen.tsx оставлен на диске для быстрого отката.

type Zoom = 0 | 1 | 2;

const ZOOM_LABELS = ["Фокус дня", "Обзор недели", "Сетка месяца"] as const;

const WEEKDAYS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

function formatColumnDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}. · ${WEEKDAYS_FULL[d.getDay()]}`;
}

function formatWeekdayDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return `${WEEKDAYS_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}.`;
}

export function TodayScreenTimeline() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const { data: currentUser, isLoading: isLoadingUser } = useCurrentUser();
  const { data: agents = [] } = useAgents();
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const today = todayStr();
  const layout = useAppStore((s) => s.taskLayout.today);
  const { data: projects = [] } = useProjects();
  const updateTask = useUpdateTask();
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const visibleProjectIds = useAppStore((s) => s.plannerVisibleProjects);
  const togglePlannerVisibleProject = useAppStore(
    (s) => s.togglePlannerVisibleProject,
  );

  // Зум-слой (День/Неделя/Месяц)
  const [zoom, setZoom] = useState<Zoom>(0);

  // ── Планировщик задач (логика из TodayScreen) ──
  const plannerTasks = useMemo(
    () =>
      allTasks.filter(
        (t) => !t.project_id || !!visibleProjectIds[t.project_id],
      ),
    [allTasks, visibleProjectIds],
  );

  const { overdue: rawOverdueAll, todayTasks: rawTodayAll } = useMemo(
    () => partitionOverdueToday(plannerTasks, today),
    [plannerTasks, today],
  );

  const waitingTasksAll = useMemo(() => {
    if (!currentUser) return [];
    return plannerTasks
      .filter((t) => isWaitingForUser(t, currentUser))
      .sort(waitingBlockedFirst);
  }, [plannerTasks, currentUser]);

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

  // День для сетки часов — тот же day, что и в TodayScreen.
  const [hourDateOffset, setHourDateOffset] = useState(0);
  const activeHourDate = useMemo(() => {
    if (hourDateOffset === 0) return today;
    return addDays(today, hourDateOffset);
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

  // trueEmpty/filteredEmpty для пустого состояния.
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

  // Доска.
  const boardColumns: BoardColumn[] = useMemo(() => {
    const cols: BoardColumn[] = [];
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

  // Заголовок — единый стиль, динамический текст по слою + меню.
  const header = (
    <ScreenHeader
      className=""
      title={
        zoom === 0
          ? layout === "hours"
            ? formatWeekdayDateLabel(activeHourDate)
            : formatWeekdayDateLabel(today)
          : zoom === 1
            ? "Неделя"
            : `${MONTHS_SHORT[new Date(today + "T00:00:00").getMonth()]} ${new Date(today + "T00:00:00").getFullYear()}`
      }
      actions={
        <>
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
              {
                icon: "list",
                label: (
                  <span
                    className={
                      zoom === 0 && layout === "list"
                        ? "font-semibold text-red"
                        : ""
                    }
                  >
                    День · Список
                  </span>
                ),
                onClick: () => {
                  setZoom(0);
                  setTaskLayout("today", "list");
                },
              },
              {
                icon: "grid",
                label: (
                  <span
                    className={
                      zoom === 0 && layout === "board"
                        ? "font-semibold text-red"
                        : ""
                    }
                  >
                    День · Доска
                  </span>
                ),
                onClick: () => {
                  setZoom(0);
                  setTaskLayout("today", "board");
                },
              },
              {
                icon: "calendar",
                label: (
                  <span
                    className={
                      zoom === 0 && layout === "hours"
                        ? "font-semibold text-red"
                        : ""
                    }
                  >
                    День · Часы
                  </span>
                ),
                onClick: () => {
                  setZoom(0);
                  setTaskLayout("today", "hours");
                },
              },
              {
                icon: "calendar",
                label: (
                  <span
                    className={
                      zoom === 1 ? "font-semibold text-red" : ""
                    }
                  >
                    Неделя
                  </span>
                ),
                onClick: () => setZoom(1),
              },
              {
                icon: "grid",
                label: (
                  <span
                    className={
                      zoom === 2 ? "font-semibold text-red" : ""
                    }
                  >
                    Месяц
                  </span>
                ),
                onClick: () => setZoom(2),
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

  // Большая иллюстрация для пустого дня — только список, не доска/часы.
  if (trueEmpty && zoom === 0 && layout === "list") {
    return (
      <div className="px-4 pb-4 flex flex-col items-center">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center mt-8">
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

  // День-список с дедупом и блоками.
  const dayList = (
    <div className="space-y-[2px]">
      <AppleCalendarEvents dateStr={today} className="mb-2.5" />
      {waitingTasks.length > 0 && (
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
  );

  // Неделя.
  const week = useMemo(() => {
    const out: { date: string; label: string; tasks: ApiTask[] }[] = [];
    for (let i = -3; i <= 3; i++) {
      const date = addDays(today, i);
      const isCurrent = i === 0;
      const label = isCurrent
        ? "Сегодня"
        : `${new Date(date + "T00:00:00").getDate()} ${MONTHS_SHORT[new Date(date + "T00:00:00").getMonth()]}`;
      const dayTasks = filterTasks(
        plannerTasks.filter((t) => t.due_date === date),
        filters,
      );
      out.push({ date, label, tasks: dayTasks });
    }
    return out;
  }, [plannerTasks, today, filters]);

  return (
    <div className="pb-4">
      {header}
      <PlannerProjectChips
        projects={projects}
        visibleProjectIds={visibleProjectIds}
        onAdd={() => setFilterSheetOpen(true)}
      />
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

      {/* Свайп-область. На iPhone свайп пальцем — основной жест, mouse мы
          не обрабатываем (там есть мышь в web-режиме, но это побочно). */}
      <div
        className="px-4"
        onTouchStart={(e) => {
          (window as unknown as { __swipeStartX: number }).__swipeStartX =
            e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          const start = (window as unknown as { __swipeStartX?: number })
            .__swipeStartX;
          if (start === undefined) return;
          (window as unknown as { __swipeStartX?: number }).__swipeStartX = undefined;
          const diff = start - e.changedTouches[0].clientX;
          if (Math.abs(diff) < 50) return;
          if (diff > 0 && zoom < 2) setZoom((zoom + 1) as Zoom);
          else if (diff < 0 && zoom > 0) setZoom((zoom - 1) as Zoom);
        }}
      >
        {/* Слой 1: День */}
        {zoom === 0 && (
          <div className="mt-2">
            {layout === "hours" ? (
              <DayHours
                days={hourDays}
                projectColor={(t) =>
                  projects.find((p) => p.id === t.project_id)?.color ||
                  "#717171"
                }
                onTaskClick={openTask}
                onPrevDay={() => setHourDateOffset((o) => o - 1)}
                onNextDay={() => setHourDateOffset((o) => o + 1)}
                onSchedule={(id, date, time) => {
                  const task = allTasks.find((t) => t.id === id);
                  updateTask.mutate({
                    id,
                    start_time: time,
                    due_date: date,
                    ...(task?.duration_min == null
                      ? { duration_min: 15 }
                      : null),
                  });
                }}
              />
            ) : layout === "board" ? (
              <TaskBoard
                columns={boardColumns}
                onTaskClick={openTask}
                isLoading={isLoading}
              />
            ) : (
              dayList
            )}
          </div>
        )}

        {/* Слой 2: Неделя */}
        {zoom === 1 && (
          <WeekLayer
            days={week}
            today={today}
            onOpenTask={(id) => openTask(id)}
          />
        )}

        {/* Слой 3: Месяц */}
        {zoom === 2 && (
          <MonthGrid
            tasks={plannerTasks}
            filters={filters}
            agents={agents}
            onOpenTask={(id) => openTask(id)}
          />
        )}
      </div>

      {/* Индикатор зума — три точки */}
      <div className="fixed bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-4 z-40">
        <div className="text-[10px] text-neutral-600 tracking-widest uppercase">
          {ZOOM_LABELS[zoom]}
        </div>
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              onClick={() => setZoom(i as Zoom)}
              aria-label={`Зум ${ZOOM_LABELS[i]}`}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                i === zoom ? "bg-text" : "bg-neutral-700"
              }`}
            />
          ))}
        </div>
      </div>

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
          defaultOpenSection: "planner",
        }}
      />
    </div>
  );
}

// ═══════════ Подслои (День-список / Неделя / Месяц) ═══════════════════

// Неделя — 7 дней вокруг сегодня, с количеством задач.
function WeekLayer({
  days,
  today,
  onOpenTask,
}: {
  days: { date: string; label: string; tasks: ApiTask[] }[];
  today: string;
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className="space-y-2 mt-4">
      {days.map((d) => {
        const isCurrent = d.date === today;
        const dateObj = new Date(d.date + "T00:00:00");
        return (
          <button
            key={d.date}
            onClick={() => {
              // В POC: открываем первую задачу дня, если она одна.
              // В этапе4 — переход на /timeline?day=...
              if (d.tasks.length === 1) onOpenTask(d.tasks[0].id);
            }}
            className={`relative pl-8 w-full text-left py-2 ${
              isCurrent ? "" : "opacity-40"
            }`}
          >
            <div
              aria-hidden
              className={`absolute left-${
                isCurrent ? "[-4px] w-2 h-2" : "[-2px] w-1 h-1"
              } top-3 bg-white rounded-full`}
            />
            <div
              className={`text-xs mb-1 tracking-widest uppercase ${
                isCurrent ? "text-text font-medium" : "text-dim"
              }`}
            >
              {d.label}
              {isCurrent && " · " + WEEKDAYS_FULL[dateObj.getDay()]}
            </div>
            {d.tasks.length > 0 ? (
              <div className="flex items-center gap-2">
                <div className="text-lg">
                  {d.tasks.length === 1
                    ? "1 задача"
                    : d.tasks.length < 5
                      ? `${d.tasks.length} задачи`
                      : `${d.tasks.length} задач`}
                </div>
                <div className="flex gap-1.5 ml-2">
                  {d.tasks.slice(0, 6).map((t) => (
                    <div
                      key={t.id}
                      className={`w-1.5 h-1.5 rounded-full ${priorityDotColor(
                        t.priority,
                      )}`}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-lg text-sub">Отдых</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Месяц — 7×6 сетка с числами и точками приоритетов.
function MonthGrid({
  tasks,
  filters,
  agents,
  onOpenTask,
}: {
  tasks: ApiTask[];
  filters: TaskFilters;
  agents: ApiUser[];
  onOpenTask: (id: string) => void;
}) {
  const today = todayStr();
  const todayDate = new Date(today + "T00:00:00");
  const year = todayDate.getFullYear();
  const month = todayDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;

  const tasksByDay = useMemo(() => {
    const map = new Map<number, ApiTask[]>();
    const filtered = filterTasks(tasks, filters);
    filtered.forEach((t) => {
      if (!t.due_date) return;
      if (t.status === "completed") return;
      if (isAgentAssignedTask(t, agents)) return;
      const [y, m, d] = t.due_date.slice(0, 10).split("-").map(Number);
      if (y !== year || m !== month + 1) return;
      const arr = map.get(d) || [];
      arr.push(t);
      map.set(d, arr);
    });
    return map;
  }, [tasks, filters, agents, year, month]);

  const cells: ({ day: number } | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });

  return (
    <div className="px-2 mt-4">
      <div className="text-center text-xs text-dim mb-4">
        ПН · ВТ · СР · ЧТ · ПТ · СБ · ВС
      </div>
      <div className="grid grid-cols-7 gap-y-8 text-center">
        {cells.map((cell, idx) => {
          if (!cell) {
            return <div key={`empty-${idx}`} />;
          }
          const isToday = cell.day === todayDate.getDate();
          const dayTasks = tasksByDay.get(cell.day) || [];
          return (
            <button
              key={cell.day}
              onClick={() => {
                if (dayTasks.length === 1) onOpenTask(dayTasks[0].id);
              }}
              className={`flex flex-col items-center ${
                isToday ? "" : "opacity-60"
              }`}
            >
              <span
                className={`text-xl ${
                  isToday ? "text-text font-medium" : "text-sub font-light"
                }`}
              >
                {cell.day}
              </span>
              {isToday && dayTasks.length > 0 ? (
                <div className="mx-auto mt-1 w-1 h-1 bg-orange rounded-full shadow-[0_0_8px_#ff9a14]" />
              ) : dayTasks.length > 0 ? (
                <div className="flex gap-0.5 mt-1 justify-center">
                  {dayTasks.slice(0, 4).map((t) => (
                    <span
                      key={t.id}
                      className={`w-1 h-1 rounded-full ${priorityDotColor(
                        t.priority,
                      )}`}
                    />
                  ))}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function priorityDotColor(priority: number): string {
  if (priority === 1) return "bg-red";
  if (priority === 2) return "bg-orange";
  if (priority === 3) return "bg-blue";
  return "bg-white";
}