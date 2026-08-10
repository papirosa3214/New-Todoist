import { useNavigate } from "react-router-dom";
import { useAppStore } from "../store";
import { Icon, Avatar } from "../components/UI";

export function NotificationsScreen() {
  const navigate = useNavigate();
  const notifications = useAppStore((s) => s.notifications);
  const users = useAppStore((s) => s.users);

  return (
    <div className="px-4 pb-4">
      {/* Header */}
      <div className="flex items-center h-[48px] mb-2 relative">
        <button onClick={() => navigate(-1)} className="w-[36px] h-[36px]">
          <Icon name="chevronLeft" size={22} />
        </button>
        <h2 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold">
          Уведомления
        </h2>
        <button className="absolute right-0 text-[13px] text-sub">
          Прочитать все
        </button>
      </div>

      {/* Notification list */}
      <div className="bg-card rounded-2xl overflow-hidden">
        {notifications.map((n, i) => {
          const user = users.find((u) => u.id === n.userId);
          return (
            <button
              key={n.id}
              className="w-full flex items-start gap-3 py-3.5 px-4 text-left"
            >
              {user ? (
                <Avatar initials={user.initials} color={user.avatarColor} size={36} />
              ) : (
                <div className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center">
                  <Icon name="bell" size={18} className="text-dim" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-text leading-snug">{n.text}</div>
                <div className="text-[13px] text-sub mt-0.5">{n.taskTitle}</div>
                <div className="text-[12px] text-dim mt-0.5">{n.timestamp}</div>
              </div>
              {!n.read && (
                <div className="w-[8px] h-[8px] rounded-full bg-red mt-2 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
