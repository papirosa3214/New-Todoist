import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTasks } from "../api/tasks";
import { useProjects } from "../api/projects";
import { useCurrentUser } from "../api/auth";
import { Icon, Avatar, ScreenHeader } from "../components/UI";

export function OverviewScreen() {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const { data: allTasks = [] } = useTasks();
  const tasks = useMemo(
    () => allTasks.filter((t) => t.status === "active"),
    [allTasks],
  );
  const { data: projects = [] } = useProjects();

  const favorites = useMemo(
    () =>
      tasks
        .filter((t) => t.labels.some((l) => l.name === "Ипотека"))
        .slice(0, 3),
    [tasks],
  );

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
              onClick={() => navigate("/notifications")}
              className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
            >
              <Icon name="bell" size={18} />
            </button>
            <button
              onClick={() => navigate("/settings")}
              className="w-[44px] h-[44px] rounded-[10px] bg-card flex items-center justify-center"
            >
              <Icon name="settings" size={18} />
            </button>
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
        <button className="text-[13px] text-orange font-semibold">
          Попробовать
        </button>
      </div>

      {/* Search Card */}
      <button
        onClick={() => navigate("/search")}
        className="w-full flex items-center gap-3 bg-card rounded-2xl p-4 mb-4"
      >
        <Icon name="search" size={20} className="text-orange" />
        <span className="text-[15px] text-sub">Найти задачу или проект</span>
      </button>

      {/* Favorites */}
      {favorites.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
            Избранное
          </h3>
          <div className="space-y-[2px]">
            {favorites.map((t) => (
              <button
                key={t.id}
                onClick={() => navigate(`/task/${t.id}`)}
                className="w-full flex items-center gap-3 py-2.5 px-3 bg-card rounded-xl text-left"
              >
                <div className="w-[18px] h-[18px] rounded-full border-2 border-red shrink-0" />
                <span className="text-[14px] text-text truncate">
                  {t.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Projects */}
      <div className="mb-4">
        <h3 className="text-[13px] font-semibold text-sub mb-2 px-1">
          Мои проекты
        </h3>
        <div className="space-y-[2px]">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate("/projects")}
              className="w-full flex items-center gap-3 py-2.5 px-3 bg-card rounded-xl text-left"
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
      </div>
    </div>
  );
}
