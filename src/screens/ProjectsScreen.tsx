import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTasks } from "../api/tasks";
import {
  useProjects,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
} from "../api/projects";
import { Icon, ScreenHeader, ErrorBanner, Loading } from "../components/UI";
import { useDialog } from "../components/Dialog";
import { useRowSwipe, ROW_ACTION_W } from "../lib/useRowSwipe";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { taskWord } from "../lib/pluralize";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { ApiProject } from "../api/types";

// One row = one component instance, so its rename form gets its own
// useGuardedCallback + its own useUpdateProject mutation — tapping "Save"
// twice fast on row A can't race with row B, and each row's pending/error
// state is independent of every other row's.
function ProjectRow({
  project,
  onRequestDelete,
  onOpen,
}: {
  project: ApiProject;
  onRequestDelete: (project: ApiProject) => void;
  onOpen: () => void;
}) {
  const updateProject = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  // Слева «Удалить», справа «Изменить» — как в строке задачи.
  const swipe = useRowSwipe(true, true);

  const startEdit = () => {
    setName(project.name);
    setColor(project.color);
    updateProject.reset();
    setEditing(true);
  };

  const cancelEdit = () => {
    updateProject.reset();
    setEditing(false);
  };

  const handleSave = useGuardedCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await updateProject.mutateAsync({ id: project.id, name: trimmed, color });
    setEditing(false);
  });

  if (editing) {
    return (
      <div className="bg-card rounded-xl p-4 mb-[2px]">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название проекта"
          className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
        />
        <div className="flex items-center gap-2 mb-3">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-[24px] h-[24px] rounded-full shrink-0 tap-scale"
              style={{
                backgroundColor: c,
                outline: color === c ? "2px solid white" : "none",
                outlineOffset: 2,
              }}
            />
          ))}
        </div>
        <ErrorBanner
          error={updateProject.error}
          fallback="Не удалось переименовать проект"
          variant="block"
          className="mb-3"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelEdit}
            className="flex-1 h-11 rounded-xl bg-card2 text-[14px] text-sub font-semibold tap-row"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || updateProject.isPending}
            className="flex-1 h-11 rounded-xl bg-red text-[14px] text-white font-semibold disabled:opacity-50 tap-fade"
          >
            {updateProject.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    );
  }

  return (
    // Свайп вместо двух иконок в строке (26.08.2026, Максим: «раз проекты
    // сразу открываются списком, то вот это „изменить, удалить“, которые
    // иконки стоят, имеет смысл точно так же обозначить свайпами, которые
    // у нас уже есть»). Направления те же, что у строки задачи: вправо —
    // удалить (красное), влево — изменить (синее).
    //
    // data-hswipe исключает строку из свайпа «назад», который ловится по
    // всему экрану (useSwipeBack).
    <div
      data-hswipe
      className="relative overflow-hidden rounded-xl mb-[2px]"
      onPointerDown={swipe.onPointerDown}
    >
      {/* Удалить — слева, открывается свайпом вправо */}
      <button
        onClick={() => {
          swipe.close();
          onRequestDelete(project);
        }}
        aria-label="Удалить проект"
        className="absolute inset-y-0 left-0 flex flex-col items-center justify-center gap-0.5 text-white"
        style={{ width: ROW_ACTION_W, background: "#FF3B30" }}
      >
        <Icon name="trash" size={18} />
        <span className="text-[11px] font-medium">Удалить</span>
      </button>
      {/* Изменить — справа, открывается свайпом влево */}
      <button
        onClick={() => {
          swipe.close();
          startEdit();
        }}
        aria-label="Переименовать проект"
        className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-0.5 text-white"
        style={{ width: ROW_ACTION_W, background: "#007AFF" }}
      >
        <Icon name="edit" size={18} />
        <span className="text-[11px] font-medium">Изменить</span>
      </button>

      <div
        className="relative w-full flex items-center bg-card rounded-xl"
        style={{
          transform: `translateX(${swipe.x}px)`,
          transition: swipe.animate
            ? "transform 0.25s cubic-bezier(0.32,0.72,0,1)"
            : "none",
        }}
      >
        {/* Отклики по той же системе, что на экране-близнеце «Метки»
          (LabelsScreen): tap-row строкам и иконкам, tap-fade — красной
          кнопке подтверждения. Без них ни один контрол этого экрана
          нажимался без видимой реакции: глобальный
          -webkit-tap-highlight-color: transparent снял системную подсветку,
          а замены не дали. rounded-l-xl — чтобы заливка отклика не
          квадратила левый скруглённый угол карточки строки. */}
        <button
          onClick={onOpen}
          className="tap-row rounded-xl flex-1 min-w-0 flex items-center gap-3 py-3 pl-4 pr-4 text-left"
        >
          <div
            className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: project.color + "20" }}
          >
            <Icon name="hash" size={16} style={{ color: project.color }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] text-text truncate">{project.name}</div>
            <div className="text-[12px] text-sub">
              {project.task_count} задач
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

export function ProjectsScreen() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading, isError, error } = useProjects();
  const { data: allTasks = [] } = useTasks();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { confirm, dialog } = useDialog();
  const [searchParams, setSearchParams] = useSearchParams();

  // Ни кнопки в шапке, ни плашки внизу больше нет (27.08.2026, владелец:
  // «зачем он нужен» / убрать плашку) — единственный вход теперь удержание
  // главной кнопки (FanMenu.tsx / FAB.onLongPress), которое приходит сюда
  // через ?create=1, тем же приёмом, что ?due=/?project= у TaskFormScreen.
  //
  // useEffect, НЕ ленивый useState(() => ...): удержание с ЭТОГО ЖЕ экрана
  // не размонтирует компонент (маршрут тот же, меняется только query) —
  // ленивый инициализатор в таком случае не перезапускается, и форма не
  // открылась бы у того, кто уже стоит на «Проектах» (поймано вживую
  // playwright'ом: URL сменился на ?create=1, форма — нет). Параметр сразу
  // же убирается из адресной строки — иначе Cancel не отличить от
  // «параметр всё ещё висит», и обновление страницы переоткрывало бы форму.
  const [showCreate, setShowCreate] = useState(false);
  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    setShowCreate(true);
    setSearchParams(
      (prev) => {
        prev.delete("create");
        return prev;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSearchParams меняется каждый рендер, а условие — только по значению самого параметра
  }, [searchParams]);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const noProjectCount = allTasks.filter(
    (t) => t.project_id == null && t.status === "active",
  ).length;

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createProject.mutateAsync({ name: name.trim(), color });
    setName("");
    setShowCreate(false);
  });

  // Server-verified (server/src/routes/projects.ts DELETE /api/projects/:id):
  // it first runs `UPDATE tasks SET project_id = NULL WHERE project_id = ?`,
  // THEN deletes the project row. So the project's tasks are NOT deleted —
  // they survive as project-less tasks (same "detach, don't destroy" shape
  // as label deletion). The confirm text below must say exactly that.
  // task_count comes straight off the already-loaded project row (the
  // GET /api/projects query computes it server-side), no extra fetch needed.
  const handleDelete = async (project: ApiProject) => {
    const count = project.task_count;
    const ok = await confirm({
      title: `Удалить проект «${project.name}»?`,
      description:
        count > 0
          ? `Задачи внутри (${count} ${taskWord(count)}) не удалятся — они останутся без проекта. Сам проект и его столбец на доске исчезнут без возможности отмены.`
          : "В нём сейчас нет задач. Действие нельзя отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setDeleteError(null);
    try {
      await deleteProject.mutateAsync(project.id);
    } catch (err) {
      setDeleteError(err);
    }
  };

  return (
    <div className="px-4 pb-4">
      {dialog}
      <ScreenHeader variant="compact" title="Проекты" />

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-card rounded-2xl p-4 mb-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название проекта"
            className="w-full bg-card2 rounded-xl px-3 py-2.5 text-[16px] text-text placeholder:text-dim outline-none mb-3"
          />
          <div className="flex items-center gap-2 mb-3">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="w-[24px] h-[24px] rounded-full shrink-0 tap-scale"
                style={{
                  backgroundColor: c,
                  outline: color === c ? "2px solid white" : "none",
                  outlineOffset: 2,
                }}
              />
            ))}
          </div>
          <ErrorBanner
            error={createProject.error}
            fallback="Не удалось создать проект"
            variant="block"
            className="mb-3"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="flex-1 h-11 rounded-xl bg-card2 text-[14px] text-sub font-semibold tap-row"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createProject.isPending}
              className="flex-1 h-11 rounded-xl bg-red text-[14px] font-semibold text-white disabled:opacity-50 tap-fade"
            >
              {createProject.isPending ? "Создаём…" : "Создать"}
            </button>
          </div>
        </form>
      )}

      {isLoading && <Loading />}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить проекты"
        variant="inline"
        className="mb-2"
      />
      {deleteError !== null && (
        <ErrorBanner
          error={deleteError}
          fallback="Не удалось удалить проект"
          variant="block"
          className="mb-2"
        />
      )}

      <div className="space-y-[2px]">
        {/* Синтетический раздел рядом с проектами: все задачи без проекта
            в одном списке (владелец 19.09.2026). */}
        <button
          onClick={() => navigate("/projects/no-project")}
          className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-card text-left tap-row"
        >
          <Icon name="list" size={18} className="text-sub" />
          <span className="text-[15px] text-text">Без проекта</span>
          <span className="ml-auto text-[12px] text-sub">
            {noProjectCount === 0 ? "" : noProjectCount}
          </span>
        </button>
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            onRequestDelete={handleDelete}
            onOpen={() => navigate(`/projects/${p.id}`)}
          />
        ))}
        {!isLoading && !isError && projects.length === 0 && !showCreate && (
          <p className="px-1 text-[13px] text-dim">
            Проектов пока нет — удержите кнопку внизу, чтобы создать
          </p>
        )}
      </div>
    </div>
  );
}
