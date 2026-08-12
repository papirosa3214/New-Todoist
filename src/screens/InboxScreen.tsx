import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { TaskRow } from "../components/TaskRow";

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
    // Пилюля «Добавить задачу» — тот же приём, что у колонки «Сегодня»
    // (TodayScreen.tsx: пунктир, акцентный красный, TaskBoard.tsx уже даёт
    // ей отступ mt-4 от карточек). Здесь колонка = проект, поэтому у каждой
    // своя пилюля, и она передаёт СВОЙ проект в создание задачи через
    // ?project=<id> (TaskFormScreen.tsx читает параметр один раз при
    // монтировании) — так задача действительно попадает в тот проект, под
    // колонкой которого её создали, а не в первый проект пользователя
    // (дефолт формы вне этого экрана).
    const makeFooter = (projectQuery: string) => (
      <button
        onClick={() => navigate(`/task/new?project=${projectQuery}`)}
        className="tap-row w-full flex items-center justify-center gap-2 h-11 rounded-xl border border-dashed border-red/40 bg-red/5 text-[13px] font-semibold text-red"
      >
        <Icon name="plus" size={16} />
        Добавить задачу
      </button>
    );
    const cols: BoardColumn[] = projects.map((p) => ({
      id: p.id,
      title: p.name,
      dotColor: p.color,
      trailingCount: (byProject.get(p.id) ?? []).length,
      tasks: byProject.get(p.id) ?? [],
      footer: makeFooter(p.id),
    }));
    // Колонка «Без проекта» держится и без единой задачи, когда у
    // пользователя вообще нет проектов — иначе на доске «Входящие» не
    // остаётся ни одной колонки, а значит ни одной пилюли, и кнопка «+»
    // при этом уже спрятана (Layout.tsx, fabReplacedByPill) — экран без
    // единого способа создать задачу. Когда хотя бы один проект есть,
    // колонка по-прежнему появляется только при реальных задачах без
    // project_id — иначе это была бы вечно пустая колонка без смысла.
    if (noProject.length > 0 || projects.length === 0) {
      cols.push({
        id: "__none",
        title: "Без проекта",
        dotColor: "var(--color-dim)",
        trailingCount: noProject.length,
        tasks: noProject,
        footer: makeFooter("none"),
      });
    }
    return cols;
  }, [tasks, projects, navigate]);

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        title="Входящие"
        actions={
          <button
            onClick={() =>
              setTaskLayout("inbox", layout === "list" ? "board" : "list")
            }
            className="tap-scale w-[44px] h-[44px] flex items-center justify-center"
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
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onClick={() => navigate(`/task/${task.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
