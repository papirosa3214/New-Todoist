import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { todayStr, formatDueLabel, MONTHS_SHORT } from "../lib/date";
import { Icon } from "../components/UI";
import { MarkdownInline } from "../components/MarkdownInline";
import { useOpenTask } from "../lib/useOpenTask";
import { isAgentAssignedTask } from "../lib/taskOwner";
import { useAgents } from "../api/agents";
import type { ApiTask, ApiUser } from "../api/types";

// ═══════════ TodayScreenTimeline — Time-Thread UI, этап2 ═══════════
//
// 30.08.2026. Этап2 (по HTML-референсу):
// - Три слоя: День (zoom=0), Неделя (zoom=1), Месяц (zoom=2)
// - Свайп влево/вправо по горизонтали с порогом 50px
// - Заголовок и точки-индикатор меняются при смене слоя
// - Анимация смены через CSS transform/opacity/filter (как в HTML)
//
// Этап3 добавит полноценный слой «Месяц» (7×5 сетка). Сейчас —
// простой placeholder «Этап 3», чтобы проверить свайп+анимацию.
//
// Доступ: /timeline (POC, рядом с /today). TodayScreen.tsx не трогаем.

type Zoom = 0 | 1 | 2;

const ZOOM_LABELS = ["Фокус дня", "Обзор недели", "Сетка месяца"] as const;

// Локальная копия WEEKDAYS_FULL из TodayScreen.tsx (там она приватная).
// В этапе3 вынесу в lib/date.ts и переиспользую там и там.
const WEEKDAYS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

export function TodayScreenTimeline() {
  const { data: allTasks = [], isLoading } = useTasks();
  const { data: agents = [] } = useAgents();
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const today = todayStr();
  const [zoom, setZoom] = useState<Zoom>(0);
  // Refs для свайпа
  const startXRef = useRef<number | null>(null);

  // Активные задачи на сегодня — слой «День».
  const todays = useMemo(() => {
    return allTasks
      .filter((t) => {
        if (!t.due_date) return false;
        if (t.status === "completed") return false;
        return t.due_date.startsWith(today);
      })
      .filter((t) => !isAgentAssignedTask(t, agents))
      .sort((a, b) => {
        const ta = a.start_time ?? "";
        const tb = b.start_time ?? "";
        if (!ta && !tb) return (a.position ?? 0) - (b.position ?? 0);
        if (!ta) return 1;
        if (!tb) return -1;
        return ta.localeCompare(tb);
      });
  }, [allTasks, today, agents]);

  // Группировка задач по дням на ближайшую неделю (относительно today).
  // Ключ — YYYY-MM-DD, значение — массив задач этого дня.
  const week = useMemo(() => {
    const todayDate = new Date(today + "T00:00:00");
    const out: { date: string; label: string; tasks: ApiTask[] }[] = [];
    for (let i = -3; i <= 3; i++) {
      const d = new Date(todayDate);
      d.setDate(todayDate.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const isCurrent = i === 0;
      const label = isCurrent
        ? "Сегодня"
        : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
      const tasks = allTasks
        .filter((t) => {
          if (!t.due_date) return false;
          if (t.status === "completed") return false;
          return t.due_date.startsWith(key);
        })
        .filter((t) => !isAgentAssignedTask(t, agents))
        .sort((a, b) => {
          const ta = a.start_time ?? "";
          const tb = b.start_time ?? "";
          if (!ta && !tb) return (a.position ?? 0) - (b.position ?? 0);
          if (!ta) return 1;
          if (!tb) return -1;
          return ta.localeCompare(tb);
        });
      out.push({ date: key, label, tasks });
    }
    return out;
  }, [allTasks, today, agents]);

  // Свайп
  function handleSwipe(diffX: number) {
    if (Math.abs(diffX) < 50) return;
    if (diffX > 0 && zoom < 2) setZoom((zoom + 1) as Zoom);
    else if (diffX < 0 && zoom > 0) setZoom((zoom - 1) as Zoom);
  }

  return (
    <div
      className="min-h-screen bg-bg text-text pb-12 relative overflow-hidden"
      onTouchStart={(e) => {
        startXRef.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (startXRef.current !== null) {
          handleSwipe(startXRef.current - e.changedTouches[0].clientX);
          startXRef.current = null;
        }
      }}
    >
      <header className="px-8 pt-12 pb-4 z-50 relative">
        <div
          key={zoom}
          className="text-sm text-dim tracking-widest uppercase animate-fade-in"
        >
          {ZOOM_LABELS[zoom]}
        </div>
        <div className="text-3xl font-medium mt-1">{formatDueLabel(today)}</div>
        <button
          onClick={() => navigate(-1)}
          className="mt-3 inline-flex items-center gap-1 text-[12px] text-sub hover:text-text transition-colors"
        >
          <Icon name="chevron" size={14} className="rotate-90" />
          <span>Назад (демо)</span>
        </button>
      </header>

      {/* СЛОИ — три одновременно, видимый — через scale/opacity/blur */}
      <Layer active={zoom === 0}>
        <DayLayer
          tasks={todays}
          isLoading={isLoading}
          onOpenTask={(id) => openTask(id)}
        />
      </Layer>
      <Layer active={zoom === 1}>
        <WeekLayer days={week} />
      </Layer>
      <Layer active={zoom === 2}>
        <MonthGrid
          tasks={allTasks}
          agents={agents}
          onOpenTask={(id) => openTask(id)}
        />
      </Layer>

      {/* Индикатор зума — три точки, активная белая */}
      <div className="fixed bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-4 z-50">
        <div className="text-[10px] text-neutral-600 tracking-widest uppercase">
          Свайп влево/вправо
        </div>
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                i === zoom ? "bg-text" : "bg-neutral-700"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Один слой в стеке. active=true → видимый. active=false → прозрачный +
// размытый + чуть сжат. CSS-transition на transform/opacity/filter.
// (Здесь простой вариант: один scale(0.95) для неактивных. В этапе3
// добавим разные scale для index< и index> — это даёт ощущение «уехал
// влево» / «уехал вправо» при свайпе, как в HTML-референсе.)
function Layer({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 pt-32 px-8 transition-all duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)] flex flex-col"
      style={{
        transform: active ? "scale(1)" : "scale(0.95)",
        opacity: active ? 1 : 0,
        filter: active ? "blur(0)" : "blur(4px)",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

// Слой «День» — те же точки на time-thread, что и в этапе1.
function DayLayer({
  tasks,
  isLoading,
  onOpenTask,
}: {
  tasks: ApiTask[];
  isLoading: boolean;
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className="relative flex-1 overflow-y-auto">
      <div
        aria-hidden
        className="absolute left-[24px] top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
      />
      {isLoading ? (
        <div className="text-sub text-sm pl-8 py-8">Загрузка…</div>
      ) : tasks.length === 0 ? (
        <div className="text-sub text-sm pl-8 py-8">На сегодня задач нет.</div>
      ) : (
        <div className="space-y-12">
          {tasks.map((t) => (
            <TimelineTask key={t.id} task={t} onOpen={() => onOpenTask(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Слой «Неделя» — 7 дней вокруг today, каждый как день со счётчиком задач.
function WeekLayer({
  days,
}: {
  days: { date: string; label: string; tasks: ApiTask[] }[];
}) {
  const today = todayStr();
  return (
    <div className="relative flex-1 overflow-y-auto">
      <div
        aria-hidden
        className="absolute left-[24px] top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"
      />
      <div className="space-y-8">
        {days.map((d) => {
          const isCurrent = d.date === today;
          return (
            <div
              key={d.date}
              className={`relative pl-8 ${isCurrent ? "" : "opacity-40"}`}
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
                {d.date === today && " · " + WEEKDAYS_FULL[new Date(d.date + "T00:00:00").getDay()]}
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
                  {/* Цветные точки — приоритеты задач дня */}
                  <div className="flex gap-1.5 ml-2">
                    {d.tasks.slice(0, 6).map((t) => (
                      <div
                        key={t.id}
                        className={`w-1.5 h-1.5 rounded-full ${priorityDotColor(t.priority)}`}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-lg text-sub">Отдых</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Слой «Месяц» — 7×5 (или 6) сетка с числами дней. Неделя начинается с
// понедельника (как в остальных местах проекта). Точка под числом —
// приоритет первой задачи дня; если задач несколько — несколько точек
// разных цветов (как в HTML-референсе).
function MonthGrid({
  tasks,
  agents,
  onOpenTask,
}: {
  tasks: ApiTask[];
  agents: ApiUser[];
  onOpenTask: (id: string) => void;
}) {
  const today = todayStr();
  const todayDate = new Date(today + "T00:00:00");
  const year = todayDate.getFullYear();
  const month = todayDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // Понедельник = 0. JS: getDay() воскресенье=0, понедельник=1.
  // Переводим к «ПН=0»: ((d.getDay() + 6) % 7).
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;

  // Группируем задачи по дню месяца.
  const tasksByDay = useMemo(() => {
    const map = new Map<number, ApiTask[]>();
    tasks.forEach((t) => {
      if (!t.due_date) return;
      if (t.status === "completed") return;
      if (isAgentAssignedTask(t, agents)) return;
      // Парсим YYYY-MM-DD без timezone-сдвига.
      const [y, m, d] = t.due_date.slice(0, 10).split("-").map(Number);
      if (y !== year || m !== month + 1) return;
      const arr = map.get(d) || [];
      arr.push(t);
      map.set(d, arr);
    });
    return map;
  }, [tasks, agents, year, month]);

  // Сетка: пустые ячейки до первого дня + числа 1..daysInMonth.
  const cells: ({ day: number } | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });

  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="px-2">
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
                  // Не открываем задачу — открываем день. Для POC просто
                  // лог; в этапе4 — переход на /timeline?day=...
                  if (dayTasks.length === 1) onOpenTask(dayTasks[0].id);
                }}
                className={`flex flex-col items-center ${
                  isToday ? "" : "opacity-60"
                }`}
              >
                <span
                  className={`text-xl ${
                    isToday
                      ? "text-text font-medium"
                      : "text-sub font-light"
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
    </div>
  );
}

function TimelineTask({ task, onOpen }: { task: ApiTask; onOpen: () => void }) {
  const priorityColor =
    task.priority === 1
      ? "bg-red shadow-[0_0_8px_#e44332]"
      : task.priority === 2
        ? "bg-orange shadow-[0_0_8px_#ff9a14]"
        : task.priority === 3
          ? "bg-blue shadow-[0_0_8px_#4a9fd8]"
          : "bg-white";

  const time =
    task.start_time && task.duration_min
      ? `${task.start_time}—${formatEnd(task.start_time, task.duration_min)}`
      : task.start_time
        ? `${task.start_time}`
        : "Без времени";

  return (
    <button
      onClick={onOpen}
      className="relative pl-8 w-full text-left group"
    >
      <div
        aria-hidden
        className={`absolute left-[-4px] top-1.5 w-2 h-2 rounded-full ${priorityColor}`}
      />
      <div className="text-xs text-dim font-mono mb-1 tracking-widest">
        {time}
      </div>
      <div className="text-lg font-light leading-tight group-hover:text-text transition-colors">
        <MarkdownInline source={task.title} />
      </div>
    </button>
  );
}

function priorityDotColor(priority: number): string {
  if (priority === 1) return "bg-red";
  if (priority === 2) return "bg-orange";
  if (priority === 3) return "bg-blue";
  return "bg-white";
}

function formatEnd(start: string, durationMin: number): string {
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}