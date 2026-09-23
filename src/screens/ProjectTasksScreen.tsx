// Screen for a single project's task list — the destination for
// /projects/:id. Modeled directly on InboxScreen's list layout (same row
// shape, same priority-color bullets, same empty/loading treatment) so it
// reads as part of the same app, just scoped to one project's tasks.
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api/tasks";
import { useProjects } from "../api/projects";
import { ScreenHeader, ErrorBanner, Loading, Icon } from "../components/UI";
import { TaskRow } from "../components/TaskRow";
import { ProjectNotes } from "../components/ProjectNotes";

export function ProjectTasksScreen() {
  const { id } = useParams<{ id: string }>();
  // Синтетический раздел «Без проекта» — тот же список, но по задачам
  // без project_id. id проекта — UUID, коллизии со строкой нет.
  const noProject = id === "no-project";
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
  const updateTask = useUpdateTask();

  const project = useMemo(
    () => projects.find((p) => p.id === id),
    [projects, id],
  );

  // Закреплённые — единым блоком сверху, остальные в прежнем порядке между
  // собой (20.08.2026, «закреплять задачи — это внутри уже проекта»). .sort
  // здесь стабилен (спецификация ES2019+, которую и Chrome/Safari/Node
  // держат) — сравнение только по pinned не трогает относительный порядок
  // внутри каждой из двух групп, менять его незачем: на этом экране пока
  // нет отдельного ручного reorder, только закрепление.
  const tasks = useMemo(
    () =>
      allTasks
        .filter((t) =>
          (noProject ? t.project_id == null : t.project_id === id) &&
          t.status === "active",
        )
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)),
    [allTasks, id, noProject],
  );

  const isLoading = projectsLoading || tasksLoading;
  // Only "not found" once the projects list has actually loaded without
  // error — otherwise a still-loading or failed projects query would look
  // exactly like a deleted/unknown project id.
  const notFound = !noProject && !projectsLoading && !projectsError && !project;

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title={
          project ? (
            <span className="inline-flex max-w-[62vw] items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: project.color }}
              />
              <span className="truncate">{project.name}</span>
            </span>
          ) : noProject ? (
            "Без проекта"
          ) : (
            "Проект"
          )
        }
        actions={
          // Не было способа завести задачу прямо в проекте — на «дрилл-даун»
          // экранах FAB намеренно не показывается (Layout.tsx), но здесь
          // взамен него не появилось вообще ничего (в отличие от «Сегодня»/
          // «Входящих», где роль FAB играет пилюля под колонкой). Максим
          // 27.08.2026: «проваливаюсь в проект, а кнопки создать нет».
          // ?project= уже понимает TaskFormScreen — просто не было, кому на
          // него сослаться.
          !noProject &&
          project && (
            <button
              onClick={() => navigate(`/task/new?project=${project.id}`)}
              aria-label="Новая задача"
              className="w-[44px] h-[44px] flex items-center justify-center tap-row"
            >
              <Icon name="plus" size={20} className="text-red" />
            </button>
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

      {isLoading && <Loading />}

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
            pinned={!!task.pinned}
            onTogglePin={() =>
              updateTask.mutate({ id: task.id, pinned: !task.pinned })
            }
            // Название проекта на каждой строке избыточно — владелец и так
            // внутри этого проекта (Максим 27.08.2026). На «Сегодня» бейдж
            // остаётся: там задачи из разных проектов вперемешку.
            showProjectBadge={false}
          />
        ))}
      </div>

      {/* Документация проекта — папка заметок (26.08.2026, выбор Максима:
          «если есть какой-то проект, я бы мог прям прикрепить папку
          заметки и туда по этому проекту всю документацию скидывать»).
          Под задачами, а не над: задачи — то, ради чего экран открывают. */}
      {project && <ProjectNotes project={project} />}
    </div>
  );
}
