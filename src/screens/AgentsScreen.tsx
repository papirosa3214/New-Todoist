import { useNavigate } from "react-router-dom";
import { useAgents } from "../api/agents";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  BackButton,
} from "../components/UI";

export function AgentsScreen() {
  const navigate = useNavigate();
  const { data: agents = [], isLoading, error, isError } = useAgents();

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        leading={<BackButton onClick={() => navigate(-1)} />}
        title="Агенты"
      />

      <ErrorBanner
        error={isError ? error : null}
        fallback="Не удалось загрузить список агентов"
        variant="inline"
        className="mt-3"
      />

      {/* Team */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">
        Команда
      </div>
      {isLoading && <p className="px-1 text-[13px] text-dim mb-4">Загрузка…</p>}
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {agents.map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-3 px-4">
            <Avatar initials={u.initials} color={u.avatar_color} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] text-text">{u.name}</div>
            </div>
            <span
              className="text-[12px] font-medium px-2 py-0.5 rounded text-white"
              style={{
                backgroundColor:
                  u.role === "owner"
                    ? "#E44332"
                    : u.type === "ai"
                      ? "#A78BFA"
                      : "#FF9A14",
              }}
            >
              {u.role === "owner" ? "Владелец" : "Агент"}
            </span>
            <div className="flex items-center gap-1.5">
              <div
                className={`w-[7px] h-[7px] rounded-full ${u.status === "online" ? "bg-green" : "bg-dim"}`}
              />
              <span className="text-[12px] text-sub">
                {u.status === "online" ? "Онлайн" : "Офлайн"}
              </span>
            </div>
          </div>
        ))}
        {!isLoading && agents.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-dim">
            Нет пользователей
          </div>
        )}
      </div>

      {/* Invitations — no invite endpoint exists on the server */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Приглашения
      </div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        <button
          disabled
          className="w-full flex items-center gap-3 py-3 px-4 border border-dashed border-stroke rounded-2xl opacity-40 cursor-not-allowed"
        >
          <Icon name="plus" size={18} className="text-dim" />
          <span className="text-[14px] text-sub">Пригласить агента</span>
        </button>
      </div>

      {/* Roles */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">
        Роль агента
      </div>
      <div className="bg-card rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Icon name="crown" size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Владелец</span> — полный
            доступ ко всем задачам и настройкам
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="bot" size={16} className="text-purple mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Агент</span> — может
            редактировать назначенные задачи, добавлять комментарии, отмечать
            выполнение
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="eye" size={16} className="text-dim mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Наблюдатель</span> — только
            просмотр
          </p>
        </div>
      </div>
    </div>
  );
}
