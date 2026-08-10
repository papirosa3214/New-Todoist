import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  useProjects,
  useCreateProject,
  useUpdateProject,
} from "../api/projects";
import { Icon, ScreenHeader, ErrorBanner } from "../components/UI";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import type { ApiProject } from "../api/types";

const PROJECT_COLORS = [
  "#4A9FD8",
  "#A78BFA",
  "#E44332",
  "#FF9A14",
  "#FF7A8A",
  "#8FBF9F",
  "#35B8A3",
];

// One row = one component instance, so its rename form gets its own
// useGuardedCallback + its own useUpdateProject mutation — tapping "Save"
// twice fast on row A can't race with row B, and each row's pending/error
// state is independent of every other row's.
function ProjectRow({ project }: { project: ApiProject }) {
  const navigate = useNavigate();
  const updateProject = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);

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
              className="w-[24px] h-[24px] rounded-full shrink-0"
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
            className="flex-1 h-11 rounded-xl bg-card2 text-[14px] text-sub font-semibold"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!name.trim() || updateProject.isPending}
            className="flex-1 h-11 rounded-xl bg-red text-[14px] text-white font-semibold disabled:opacity-50"
          >
            {updateProject.isPending ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex items-center bg-card rounded-xl mb-[2px]">
      <button
        onClick={() => navigate(`/projects/${project.id}`)}
        className="flex-1 min-w-0 flex items-center gap-3 py-3 pl-4 pr-1 text-left"
      >
        <div
          className="w-[28px] h-[28px] rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: project.color + "20" }}
        >
          <Icon name="hash" size={16} style={{ color: project.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] text-text truncate">{project.name}</div>
          <div className="text-[12px] text-sub">{project.task_count} задач</div>
        </div>
      </button>
      <button
        onClick={startEdit}
        aria-label="Переименовать проект"
        className="w-[44px] h-[44px] mr-1 flex items-center justify-center shrink-0 text-dim"
      >
        <Icon name="edit" size={16} />
      </button>
    </div>
  );
}

export function ProjectsScreen() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading, isError, error } = useProjects();
  const createProject = useCreateProject();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createProject.mutateAsync({ name: name.trim(), color });
    setName("");
    setShowCreate(false);
  });

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
        title="Проекты"
        actions={
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
          >
            <Icon name={showCreate ? "x" : "plus"} size={18} />
          </button>
        }
      />

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
                className="w-[24px] h-[24px] rounded-full shrink-0"
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
          <button
            type="submit"
            disabled={!name.trim() || createProject.isPending}
            className="w-full h-12 bg-red rounded-xl text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {createProject.isPending ? "Создаём…" : "Создать"}
          </button>
        </form>
      )}

      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      <ErrorBanner
        error={error}
        fallback="Не удалось загрузить проекты"
        variant="inline"
        className="mb-2"
      />

      <div className="space-y-[2px]">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
        {!isLoading && !isError && projects.length === 0 && !showCreate && (
          <p className="px-1 text-[13px] text-dim">Проектов пока нет</p>
        )}
      </div>

      {!showCreate && (
        <button
          onClick={() => setShowCreate(true)}
          className="w-full flex items-center gap-3 py-3 px-4 mt-4 border border-dashed border-stroke rounded-xl"
        >
          <Icon name="plus" size={18} className="text-dim" />
          <span className="text-[14px] text-sub">Создать проект</span>
        </button>
      )}
    </div>
  );
}
