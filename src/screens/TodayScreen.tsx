import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { todayStr, formatDueLabel } from "../lib/date";
import { getPriorityColor } from "../lib/priority";
import type { ApiTask } from "../api/types";

// Одна строка задачи — используется и для просроченных, и для сегодняшних,
// разница только в `overdue` (красная пометка «Просрочено, …» под текстом).
function TaskRow({
  task,
  overdue,
  onClick,
}: {
  task: ApiTask;
  overdue: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50 active:bg-card/50 transition-colors"
    >
      <div
        className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0"
        style={{ borderColor: getPriorityColor(task.priority) }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[15px] text-text leading-snug truncate">
          {task.title}
        </div>
        {task.description && (
          <div className="text-[13px] text-sub mt-0.5 truncate">
            {task.description.substring(0, 60)}…
          </div>
        )}
        {overdue && task.due_date && (
          <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded text-[11px] bg-red/15 text-red">
            <Icon name="calendarSmall" size={10} /> Просрочено,{" "}
            {formatDueLabel(task.due_date)}
          </span>
        )}
      </div>
    </button>
  );
}

export function TodayScreen() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const navigate = useNavigate();
  const today = todayStr();

  // Просроченные задачи (дедлайн раньше сегодня, ещё активные) теперь не
  // пропадают из виду — попадают в «Сегодня» отдельным блоком выше обычных
  // сегодняшних, отсортированы от самой давней просрочки к недавней.
  const overdueTasks = useMemo(
    () =>
      allTasks
        .filter(
          (t) =>
            t.status === "active" && t.due_date !== null && t.due_date < today,
        )
        .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "")),
    [allTasks, today],
  );
  const todayTasks = useMemo(
    () => allTasks.filter((t) => t.due_date === today && t.status === "active"),
    [allTasks, today],
  );

  const isEmpty =
    !isLoading &&
    !isError &&
    overdueTasks.length === 0 &&
    todayTasks.length === 0;

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
          <button className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform">
            <Icon name="dots" size={18} />
          </button>
          <button
            onClick={() => navigate("/search")}
            className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center active:scale-95 transition-transform"
          >
            <Icon name="search" size={18} />
          </button>
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
      <div className="space-y-[2px]">
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
            onClick={() => navigate(`/task/${t.id}`)}
          />
        ))}
        {overdueTasks.length > 0 && todayTasks.length > 0 && (
          <div className="text-[13px] font-semibold text-sub px-1 pt-3 pb-1">
            Сегодня
          </div>
        )}
        {todayTasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            overdue={false}
            onClick={() => navigate(`/task/${t.id}`)}
          />
        ))}
      </div>
    </div>
  );
}
