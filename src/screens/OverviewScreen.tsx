import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useProjects, useCreateProject } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { Icon, Avatar, ScreenHeader, ErrorBanner } from "../components/UI";
import { ActionsMenu } from "../components/ActionsMenu";
import { useGuardedCallback } from "../lib/useGuardedCallback";
import { PROJECT_COLORS } from "../lib/projectColors";

export function OverviewScreen() {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useProjects();
  const createProject = useCreateProject();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);

  const handleCreate = useGuardedCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createProject.mutateAsync({ name: name.trim(), color });
    setName("");
    setColor(PROJECT_COLORS[0]);
    setShowCreate(false);
  });

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        className="mb-5"
        title={
          <span className="flex w-fit max-w-full items-center gap-2 bg-card px-3 py-1.5 rounded-full">
            {user && (
              <Avatar
                initials={user.initials}
                color={user.avatar_color}
                size={28}
              />
            )}
            <span className="min-w-0 truncate text-[16px] font-semibold">
              {user?.name}
            </span>
          </span>
        }
        actions={
          <>
            <button
              ref={menuAnchorRef}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Ещё"
              className="w-[44px] h-[44px] flex items-center justify-center"
            >
              <Icon name="dots" size={18} />
            </button>
            <ActionsMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              anchorRef={menuAnchorRef}
              items={[
                {
                  icon: "bell",
                  label: "Уведомления",
                  onClick: () => navigate("/notifications"),
                },
                {
                  icon: "settings",
                  label: "Настройки",
                  onClick: () => navigate("/settings"),
                },
              ]}
            />
          </>
        }
      />

      {/* Pro Banner */}
      <div className="bg-card rounded-2xl p-4 mb-4 flex items-center gap-3">
        <div className="w-[44px] h-[44px] bg-orange rounded-xl flex items-center justify-center shrink-0">
          <Icon name="zap" size={22} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="text-[14px] font-semibold">
            Бесплатная пробная версия
          </div>
          <div className="text-[12px] text-sub">
            Попробуйте 30 дней бесплатно
          </div>
        </div>
      </div>

      {/* Search Card */}
      <button
        onClick={() => navigate("/search")}
        className="w-full flex items-center gap-3 bg-card rounded-2xl p-4 mb-4"
      >
        <Icon name="search" size={20} className="text-orange" />
        <span className="text-[15px] text-sub">Найти задачу или проект</span>
      </button>

      {/* Projects */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 px-1 -mr-2.5">
          <h3 className="text-[13px] font-semibold text-sub">Мои проекты</h3>
          <div className="flex items-center">
            <button
              onClick={() => navigate("/projects")}
              aria-label="Все проекты"
              className="w-[44px] h-[44px] flex items-center justify-center text-dim"
            >
              <Icon name="chevron" size={14} />
            </button>
            <button
              onClick={() => setShowCreate((v) => !v)}
              aria-label={
                showCreate ? "Отменить создание проекта" : "Создать проект"
              }
              className="w-[44px] h-[44px] flex items-center justify-center text-dim"
            >
              <Icon name={showCreate ? "x" : "plus"} size={16} />
            </button>
          </div>
        </div>

        {showCreate && (
          <form
            onSubmit={handleCreate}
            className="bg-card rounded-2xl p-4 mb-2"
          >
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
                  aria-label="Выбрать цвет"
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

        {isLoading && <p className="px-3 text-[13px] text-dim">Загрузка…</p>}

        {isError && (
          <div className="px-3 space-y-2">
            <ErrorBanner
              error={error}
              fallback="Не удалось загрузить проекты"
              variant="inline"
              className="px-0"
            />
            <button
              onClick={() => refetch()}
              className="min-h-[44px] px-3 -ml-3 text-[13px] text-red font-semibold"
            >
              Повторить
            </button>
          </div>
        )}

        {!isLoading && !isError && (
          <div className="space-y-[2px]">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="w-full flex items-center gap-3 py-2.5 px-3 bg-card rounded-xl text-left min-h-[44px]"
              >
                <Icon name="hash" size={18} style={{ color: p.color }} />
                <span className="text-[14px] text-text flex-1">{p.name}</span>
                <span className="text-[13px] text-sub">{p.task_count}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="px-3 text-[13px] text-dim">Проектов пока нет</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
