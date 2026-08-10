import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { getPriorityColor } from "../lib/priority";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";

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

export function InboxScreen() {
  const { data: allTasks = [], isLoading, isError, error } = useTasks();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    error: projectsError,
  } = useProjects();
  const navigate = useNavigate();
  const layout = useAppStore((s) => s.taskLayout.inbox);
  const setTaskLayout = useAppStore((s) => s.setTaskLayout);

  const tasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );

  // Доска: колонка = проект. Каждый проект — своя колонка, даже без единой
  // задачи на этом экране (пустая колонка), так порядок и состав колонок не
  // прыгает по мере того, как задачи разбираются/переносятся. Задачи без
  // project_id (у Входящих такие встречаются) уходят в отдельную колонку
  // «Без проекта» — но только когда такие задачи реально есть, иначе это
  // была бы вечно пустая колонка без смысла.
  const boardColumns: BoardColumn[] = useMemo(() => {
    const byProject = new Map<string, typeof tasks>();
    const noProject: typeof tasks = [];
    for (const t of tasks) {
      if (t.project_id) {
        const arr = byProject.get(t.project_id);
        if (arr) arr.push(t);
        else byProject.set(t.project_id, [t]);
      } else {
        noProject.push(t);
      }
    }
    const cols: BoardColumn[] = projects.map((p) => ({
      id: p.id,
      title: p.name,
      dotColor: p.color,
      trailingCount: (byProject.get(p.id) ?? []).length,
      tasks: byProject.get(p.id) ?? [],
    }));
    if (noProject.length > 0) {
      cols.push({
        id: "__none",
        title: "Без проекта",
        dotColor: "var(--color-dim)",
        trailingCount: noProject.length,
        tasks: noProject,
      });
    }
    return cols;
  }, [tasks, projects]);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        title="Входящие"
        actions={
          <button
            onClick={() =>
              setTaskLayout("inbox", layout === "list" ? "board" : "list")
            }
            className="tap-scale w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
            aria-label={
              layout === "list"
                ? "Переключить на вид доски"
                : "Переключить на вид списка"
            }
          >
            <Icon
              name={layout === "list" ? "list" : "grid"}
              size={18}
              className="text-text"
            />
          </button>
        }
      />

      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить задачи"
        variant="inline"
      />
      {layout === "board" && (
        <ErrorBanner
          error={projectsError}
          fallback="Не удалось загрузить проекты"
          variant="inline"
        />
      )}
      {!isLoading && !isError && tasks.length === 0 && (
        <p className="px-1 text-[13px] text-dim">Задач пока нет</p>
      )}

      {layout === "board" ? (
        <TaskBoard
          columns={boardColumns}
          onTaskClick={(id) => navigate(`/task/${id}`)}
          isLoading={isLoading || projectsLoading}
          emptyMessage="Задач пока нет"
        />
      ) : (
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
                    borderColor: getPriorityColor(task.priority),
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
      )}
    </div>
  );
}
