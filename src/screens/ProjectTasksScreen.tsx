// Screen for a single project's task list — the destination for
// /projects/:id. Modeled directly on InboxScreen's list layout (same row
// shape, same priority-color bullets, same empty/loading treatment) so it
// reads as part of the same app, just scoped to one project's tasks.
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";

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

export function ProjectTasksScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
    error: projectsErrorObj,
  } = useProjects();
  const {
    data: allTasks = [],
    isLoading: tasksLoading,
    isError: tasksError,
    error: tasksErrorObj,
  } = useTasks();

  const project = useMemo(
    () => projects.find((p) => p.id === id),
    [projects, id],
  );

  const tasks = useMemo(
    () => allTasks.filter((t) => t.project_id === id && t.status === "active"),
    [allTasks, id],
  );

  const isLoading = projectsLoading || tasksLoading;
  // Only "not found" once the projects list has actually loaded without
  // error — otherwise a still-loading or failed projects query would look
  // exactly like a deleted/unknown project id.
  const notFound = !projectsLoading && !projectsError && !project;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        leading={
          <button
            onClick={() => navigate(-1)}
            className="w-[44px] h-[44px] -ml-2.5 flex items-center justify-center"
            aria-label="Назад"
          >
            <Icon name="chevronLeft" size={22} />
          </button>
        }
        title={
          project ? (
            <span className="inline-flex max-w-[62vw] items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: project.color }}
              />
              <span className="truncate">{project.name}</span>
            </span>
          ) : (
            "Проект"
          )
        }
      />

      <ErrorBanner
        error={projectsErrorObj}
        fallback="Не удалось загрузить проект"
        variant="inline"
        className="mb-2"
      />
      <ErrorBanner
        error={tasksErrorObj}
        fallback="Не удалось загрузить задачи"
        variant="inline"
        className="mb-2"
      />

      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}

      {notFound && (
        <div className="px-1 py-8 text-center">
          <p className="text-[14px] text-sub mb-4">
            Проект не найден — возможно, он удалён.
          </p>
          <button
            onClick={() => navigate("/projects")}
            className="h-11 px-5 rounded-xl bg-card text-[13px] text-text font-semibold"
          >
            К списку проектов
          </button>
        </div>
      )}

      {!isLoading &&
        !projectsError &&
        !tasksError &&
        project &&
        tasks.length === 0 && (
          <p className="px-1 text-[13px] text-dim">В проекте пока нет задач</p>
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
