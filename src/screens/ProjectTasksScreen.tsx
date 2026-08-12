// Screen for a single project's task list — the destination for
// /projects/:id. Modeled directly on InboxScreen's list layout (same row
// shape, same priority-color bullets, same empty/loading treatment) so it
// reads as part of the same app, just scoped to one project's tasks.
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { ScreenHeader, ErrorBanner, BackButton } from "../components/UI";
import { TaskRow } from "../components/TaskRow";

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
        leading={<BackButton onClick={() => navigate(-1)} />}
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
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onClick={() => navigate(`/task/${task.id}`)}
          />
        ))}
      </div>
    </div>
  );
}
