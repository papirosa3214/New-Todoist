import { useNavigate } from "react-router-dom";
import type { ApiNotification } from "../api/types";
import {
  useNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useDeleteNotification,
  formatRelativeTime,
  formatAbsoluteTime,
} from "../api/notifications";
import {
  Icon,
  Avatar,
  ScreenHeader,
  ErrorBanner,
  Loading,
} from "../components/UI";
import { useGuardedCallback } from "../lib/useGuardedCallback";

function NotificationRow({ n }: { n: ApiNotification }) {
  const navigate = useNavigate();
  const markRead = useMarkNotificationRead();
  const deleteNotif = useDeleteNotification();

  const handleOpen = useGuardedCallback(async () => {
    if (!n.read) await markRead.mutateAsync(n.id);
    if (n.task_id) navigate(`/task/${n.task_id}`);
  });

  const handleDelete = useGuardedCallback(async () => {
    await deleteNotif.mutateAsync(n.id);
  });

  // Show the actor (the person who triggered the notification) — never
  // fall back to n.user_name/user_color, which is the *recipient*.
  // Falling back to the recipient would show the user their own avatar as
  // if they were the author of the action on them, which is worse than no
  // avatar at all. Older notifications (seeded, or created before actor_id
  // existed) have actor_id/actor_name = null — those get the neutral gear
  // placeholder below instead of any avatar (matches mockup-reference's
  // no-actor row, e.g. "Новая задача назначена вам").
  const hasActor = Boolean(
    n.actor_id && n.actor_name && n.actor_name.trim().length > 0,
  );

  return (
    <div className="flex items-start gap-3 py-3.5 px-4 group border-b border-stroke last:border-b-0 hover:bg-card2/50">
      {hasActor ? (
        <Avatar
          initials={n.actor_initials || "?"}
          color={n.actor_color || "#A6A6A6"}
          avatar_url={n.actor_avatar_url}
          size={36}
        />
      ) : (
        <div className="w-[36px] h-[36px] rounded-full bg-card2 flex items-center justify-center shrink-0">
          <Icon name="gear" size={17} className="text-dim" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <button
          onClick={handleOpen}
          className="tap-row w-full text-left"
          title={n.task_title || undefined}
        >
          <div className="text-[14px] text-text leading-snug">{n.text}</div>
          {n.task_title && (
            <div className="text-[13px] text-sub mt-0.5">{n.task_title}</div>
          )}
          <div className="text-[12px] text-dim mt-0.5">
            {formatRelativeTime(n.created_at)} · {formatAbsoluteTime(n.created_at)}
          </div>
        </button>
        <ErrorBanner
          error={markRead.error}
          fallback="Не удалось отметить прочитанным"
          variant="inline"
          className="mt-1"
        />
        <ErrorBanner
          error={deleteNotif.error}
          fallback="Не удалось удалить уведомление"
          variant="inline"
          className="mt-1"
        />
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {!n.read && <div className="w-[8px] h-[8px] rounded-full bg-red" />}
        <button
          onClick={handleDelete}
          disabled={deleteNotif.isPending}
          className="tap-row w-11 h-11 flex items-center justify-center rounded-lg text-dim hover:bg-card2 hover:text-text disabled:opacity-40 -mr-2"
          aria-label="Удалить уведомление"
          title="Удалить"
        >
          <Icon name="trash" size={18} />
        </button>
      </div>
    </div>
  );
}

export function NotificationsScreen() {
  const {
    data: notifications = [],
    isLoading,
    error: loadError,
    isError: isLoadError,
  } = useNotifications();
  const markAllRead = useMarkAllNotificationsRead();

  const handleMarkAllRead = useGuardedCallback(async () => {
    await markAllRead.mutateAsync();
  });

  return (
    <div className="px-4 pb-4">
      <ScreenHeader
        variant="compact"
        title="Уведомления"
        actions={
          <button
            onClick={handleMarkAllRead}
            disabled={
              markAllRead.isPending || notifications.every((n) => n.read)
            }
            // Надпись 87×19.5 — по высоте вдвое меньше нормы HIG в 44pt.
            // Кегль и место в шапке не трогаем, зону добираем прозрачным
            // ::before на всю ширину надписи и 44pt по высоте.
            className="tap-fade relative text-[13px] text-sub disabled:opacity-40 before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-['']"
          >
            Прочитать все
          </button>
        }
      />

      <ErrorBanner
        error={isLoadError ? loadError : null}
        fallback="Не удалось загрузить уведомления"
        variant="inline"
        className="mt-3"
      />
      <ErrorBanner
        error={markAllRead.error}
        fallback="Не удалось отметить все прочитанными"
        variant="inline"
        className="mt-2"
      />

      {isLoading && <Loading className="mt-3" />}
      {!isLoading && notifications.length === 0 && (
        <p className="px-1 text-[13px] text-dim mt-3">Уведомлений пока нет</p>
      )}

      {/* Notification list */}
      {notifications.length > 0 && (
        <div className="bg-card rounded-2xl overflow-hidden mt-3">
          {notifications.map((n) => (
            <NotificationRow key={n.id} n={n} />
          ))}
        </div>
      )}
    </div>
  );
}
