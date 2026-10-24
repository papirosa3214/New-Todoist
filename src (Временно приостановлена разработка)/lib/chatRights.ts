// Право убрать чат на экране. Правило — то же, что на сервере
// (server/src/lib/chatArchive.ts): тема задачи (системная комната) убирается
// любым участником проекта, личные и групповые переписки — только их
// создателем. Здесь оно нужно, чтобы показать кнопку только там, где
// сервер действительно разрешит.
//
// Сервер — источник истины: даже если кнопка показана, отказ сервера (403)
// остаётся отказом, а не «тихим успехом».

export interface ArchiveRightsChat {
  created_by: string;
  task_id?: string | null;
  parent_chat_id?: string | null;
  room_kind?: string | null;
  members?: Array<{ id: string }>;
}

/** Вправе ли этот человек убрать чат в архив. */
export function canArchiveChat(
  chat: ArchiveRightsChat,
  meId?: string,
): boolean {
  if (!meId) return false;
  // Постоянная общая комната — не переписка, её не убирают.
  if (chat.room_kind === "common") return false;
  // Тема задачи: системная комната, её заводит сервер. Убирает участник.
  if (chat.task_id && chat.parent_chat_id)
    return (chat.members ?? []).some((m) => m.id === meId);
  // Личные и групповые переписки: только создатель.
  return chat.created_by === meId;
}
