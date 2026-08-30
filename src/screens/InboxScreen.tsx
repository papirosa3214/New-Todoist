import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { useAppStore } from "../store";
import { TaskBoard, type BoardColumn } from "../components/TaskBoard";
import { TaskRow } from "../components/TaskRow";
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
  const [filters, setFilters] = useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const activeTasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );

  // Filter options come from the full active set (pre-filter) — every
  // option shown matches at least one task somewhere on this screen, even
  // when combined with another active filter it currently yields zero.
  const projectFilterOptions = useMemo(
    () => buildProjectOptions(activeTasks),
    [activeTasks],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelOptions(activeTasks),
    [activeTasks],
  );
  const assigneeFilterOptions = useMemo(
    () => buildAssigneeOptions(activeTasks),
    [activeTasks],
  );

  // The single filtered set feeding both layouts — list rows below and
  // the board columns' project buckets both read from `tasks`, so list ↔
  // board can never quietly disagree about which tasks a filter matched.
  const tasks = useMemo(
    () => filterTasks(activeTasks, filters),
    [activeTasks, filters],
  );
  // activeFilterCount removed
  const showTrueEmpty = !isLoading && !isError && activeTasks.length === 0;
  const showFilteredEmpty =
    !isLoading && !isError && activeTasks.length > 0 && tasks.length === 0;

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
          <>
            <TaskFilterButton
              onClick={() => setFilterSheetOpen(true)}
            />
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
          </>
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
      {showTrueEmpty && (
        <p className="px-1 text-[13px] text-dim">Задач пока нет</p>
      )}
      {showFilteredEmpty && (
        <div className="px-1 flex items-center gap-2 flex-wrap text-[13px] text-dim">
          Под выбранные фильтры ничего не подошло
          <button
            onClick={() => setFilters(DEFAULT_TASK_FILTERS)}
            className="text-red font-medium"
          >
            Сбросить фильтры
          </button>
        </div>
      )}

      {layout === "board" ? (
        <TaskBoard
          columns={boardColumns}
          onTaskClick={(id) => navigate(`/task/${id}`)}
          isLoading={isLoading || projectsLoading}
          emptyMessage="Задач пока нет"
        />
      ) : (
        // Список сгруппирован по проектам — Максим 17.08.2026: «не просто
        // один голый список, а были разделы — проект написан, потом идут
        // задачи». Группы и порядок берутся из boardColumns (тот же расчёт,
        // что для вида доски — один источник, list и board не могут
        // разойтись в том, что относится к какому проекту), только пустые
        // колонки тут не показываются: на доске пустая колонка держит место
        // и пилюлю «Добавить», в простом списке пустой заголовок без единой
        // задачи под ним смысла не несёт. Заголовок секции — 1:1 разметка
        // заголовка колонки из TaskBoard.tsx (точка цвета проекта + название
        // + счётчик), чтобы один и тот же проект выглядел одинаково что на
        // доске, что в списке.
        <div className="space-y-4">
          {boardColumns
            .filter((col) => col.tasks.length > 0)
            .map((col) => (
              <div key={col.id}>
                <div className="flex items-center gap-2 px-1 mb-2 min-h-11">
                  {col.dotColor && (
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: col.dotColor }}
                    />
                  )}
                  <span
                    className={`text-[13px] font-semibold truncate ${
                      col.titleClassName ?? "text-text"
                    }`}
                  >
                    {col.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-sub">
                    {col.trailingCount}
                  </span>
                </div>
                <div className="space-y-[2px]">
                  {col.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onClick={() => navigate(`/task/${task.id}`)}
                    />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      <TaskFilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        filters={filters}
        setFilters={setFilters}
        projectOptions={projectFilterOptions}
        labelOptions={labelFilterOptions}
        assigneeOptions={assigneeFilterOptions}
      />
    </div>
  );
}
