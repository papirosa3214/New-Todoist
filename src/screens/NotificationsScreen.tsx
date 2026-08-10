import { useNavigate } from "react-router-dom";
import {
  useNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  formatRelativeTime,
} from "../api/notifications";
import { Icon, Avatar } from "../components/UI";

export function NotificationsScreen() {
  const navigate = useNavigate();
  const { data: notifications = [], isLoading } = useNotifications();
  const markAllRead = useMarkAllNotificationsRead();
  const markRead = useMarkNotificationRead();

  const handleOpen = (n: (typeof notifications)[number]) => {
    if (!n.read) markRead.mutate(n.id);
    if (n.task_id) navigate(`/task/${n.task_id}`);
  };

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
        <button
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending || notifications.every((n) => n.read)}
          className="absolute right-0 text-[13px] text-sub disabled:opacity-40"
        >
          Прочитать все
        </button>
      </div>

      {isLoading && <p className="px-1 text-[13px] text-dim">Загрузка…</p>}
      {!isLoading && notifications.length === 0 && (
        <p className="px-1 text-[13px] text-dim">Уведомлений пока нет</p>
      )}

      {/* Notification list */}
      {notifications.length > 0 && (
        <div className="bg-card rounded-2xl overflow-hidden">
          {notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => handleOpen(n)}
              className="w-full flex items-start gap-3 py-3.5 px-4 text-left"
            >
              {n.user_name ? (
                <Avatar
                  initials={n.user_initials || "?"}
                  color={n.user_color || "#A6A6A6"}
                  size={36}
                />
              ) : (
                <div className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center">
                  <Icon name="bell" size={18} className="text-dim" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-text leading-snug">
                  {n.text}
                </div>
                {n.task_title && (
                  <div className="text-[13px] text-sub mt-0.5">
                    {n.task_title}
                  </div>
                )}
                <div className="text-[12px] text-dim mt-0.5">
                  {formatRelativeTime(n.created_at)}
                </div>
              </div>
              {!n.read && (
                <div className="w-[8px] h-[8px] rounded-full bg-red mt-2 shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
