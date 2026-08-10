import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store";
import { Icon, Avatar } from "../components/UI";

export function AgentsScreen() {
  const navigate = useNavigate();
  const users = useAppStore((s) => s.users);

  return (
    <div className="px-4 pb-4">
      {/* Header */}
      <div className="flex items-center h-[48px] mb-2 relative">
        <button onClick={() => navigate(-1)} className="w-[36px] h-[36px]">
          <Icon name="chevronLeft" size={22} />
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold">
          Агенты
        </h2>
        <button className="absolute right-0 w-[36px] h-[36px] rounded-[10px] bg-card flex items-center justify-center">
          <Icon name="plus" size={18} />
        </button>
      </div>

      {/* Team */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2 mt-2">Команда</div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 py-3 px-4">
            <Avatar initials={u.initials} color={u.avatarColor} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] text-text">{u.name}</div>
              {u.capabilities && (
                <div className="flex gap-1 mt-1">
                  {u.capabilities.map((c) => (
                    <span key={c} className="text-[11px] text-sub bg-card2 px-2 py-0.5 rounded">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span
              className="text-[12px] font-medium px-2 py-0.5 rounded text-white"
              style={{
                backgroundColor:
                  u.role === "owner"
                    ? "#E44332"
                    : u.name === "Claude_Bot"
                      ? "#A78BFA"
                      : "#FF9A14",
              }}
            >
              {u.role === "owner" ? "Владелец" : "Агент"}
            </span>
            <div className="flex items-center gap-1.5">
              <div className="w-[7px] h-[7px] rounded-full bg-green" />
              <span className="text-[12px] text-sub">Онлайн</span>
            </div>
          </div>
        ))}
      </div>

      {/* Invitations */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Приглашения</div>
      <div className="bg-card rounded-2xl overflow-hidden mb-4">
        <button className="w-full flex items-center gap-3 py-3 px-4 border border-dashed border-stroke rounded-2xl">
          <Icon name="plus" size={18} className="text-dim" />
          <span className="text-[14px] text-sub">Пригласить агента</span>
        </button>
      </div>

      {/* Roles */}
      <div className="text-[13px] text-sub font-semibold px-1 mb-2">Роль агента</div>
      <div className="bg-card rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Icon name="crown" size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Владелец</span> — полный доступ ко всем задачам и настройкам
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="bot" size={16} className="text-purple mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Агент</span> — может редактировать назначенные задачи, добавлять комментарии, отмечать выполнение
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Icon name="eye" size={16} className="text-dim mt-0.5 shrink-0" />
          <p className="text-[13px] text-sub leading-relaxed">
            <span className="text-text font-medium">Наблюдатель</span> — только просмотр
          </p>
        </div>
      </div>
    </div>
  );
}
