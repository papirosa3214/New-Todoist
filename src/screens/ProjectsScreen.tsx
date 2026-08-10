import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useCreateProject } from "../api/projects";
import { Icon, ScreenHeader } from "../components/UI";

const PROJECT_COLORS = [
  "#4A9FD8",
  "#A78BFA",
  "#E44332",
  "#FF9A14",
  "#FF7A8A",
  "#8FBF9F",
  "#35B8A3",
];

export function ProjectsScreen() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useProjects();
  const createProject = useCreateProject();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createProject.mutateAsync({ name: name.trim(), color });
    setName("");
    setShowCreate(false);
  };

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

      <div className="space-y-[2px]">
        {projects.map((p) => (
          <div
            key={p.id}
            className="w-full flex items-center gap-3 py-3 px-4 bg-card rounded-xl text-left"
          >
            <div
              className="w-[28px] h-[28px] rounded-lg flex items-center justify-center"
              style={{ backgroundColor: p.color + "20" }}
            >
              <Icon name="hash" size={16} style={{ color: p.color }} />
            </div>
            <div className="flex-1">
              <div className="text-[15px] text-text">{p.name}</div>
              <div className="text-[12px] text-sub">{p.task_count} задач</div>
            </div>
          </div>
        ))}
        {!isLoading && projects.length === 0 && !showCreate && (
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
