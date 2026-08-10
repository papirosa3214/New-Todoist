import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { Icon, Avatar } from "../components/UI";

function formatDue(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const months = [
    "янв",
    "фев",
    "мар",
    "апр",
    "мая",
    "июн",
    "июл",
    "авг",
    "сен",
    "окт",
    "ноя",
    "дек",
  ];
  return `${day} ${months[d.getMonth()]}`;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: "#E44332",
  2: "#FF9A14",
  3: "#4A9FD8",
  4: "#A6A6A6",
};

export function InboxScreen() {
  const { data: allTasks = [], isLoading, isError } = useTasks();
  const navigate = useNavigate();
  const tasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );

  return (
    <div className="px-4 pb-4">
      <h1 className="text-[28px] font-bold mb-3 px-1">Входящие</h1>
      <div className="flex gap-2 mb-3 px-1">
        <button className="flex items-center gap-1.5 px-3 py-[6px] bg-card rounded-lg text-[13px] text-sub">
          <Icon name="list" size={15} />
        </button>
        <button className="flex items-center gap-1.5 px-3 py-[6px] bg-card rounded-lg text-[13px] text-sub">
          <Icon name="dotsH" size={15} />
        </button>
      </div>

      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      {isError && (
        <p className="px-1 text-[13px] text-coral">
          Не удалось загрузить задачи
        </p>
      )}
      {!isLoading && !isError && tasks.length === 0 && (
        <p className="px-1 text-[13px] text-dim">Задач пока нет</p>
      )}

      <div className="space-y-[2px]">
        {tasks.map((task) => {
          const hasSubtasks = task.subtasks.length > 0;
          const doneSub = task.subtasks.filter((s) => s.done).length;
          return (
            <button
              key={task.id}
              onClick={() => navigate(`/task/${task.id}`)}
              className="w-full flex items-start gap-3 py-3 px-1 text-left border-b border-stroke/50"
            >
              <div
                className="mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0"
                style={{
                  borderColor: PRIORITY_COLORS[task.priority] || "#4A9FD8",
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-text leading-snug mb-1 truncate">
                  {task.title}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-sub">
                  {task.description && (
                    <span className="truncate max-w-[200px]">
                      {task.description.substring(0, 50)}…
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {task.labels.map((l) => (
                    <span
                      key={l.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                      style={{
                        backgroundColor: l.color + "26",
                        color: l.color,
                      }}
                    >
                      <Icon name="tag" size={10} /> {l.name}
                    </span>
                  ))}
                  {task.due_date && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                      <Icon name="calendarSmall" size={10} />{" "}
                      {formatDue(task.due_date)}
                    </span>
                  )}
                  {hasSubtasks && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-card text-sub">
                      <Icon name="check" size={10} /> {doneSub}/
                      {task.subtasks.length}
                    </span>
                  )}
                </div>
              </div>
              {task.assignee_id && task.assignee_initials && (
                <Avatar
                  initials={task.assignee_initials}
                  color={task.assignee_color || "#A6A6A6"}
                  size={24}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
