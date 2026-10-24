import db from "../db.js";

/** Минут простоя, после которых переписка ролей между собой закрывается
 *  (владелец 24.10.2026: роли открывают dm между собой, те не закрываются
 *  и раздувают список чатов). По умолчанию 30. */
export function chatAutoCloseIdleMinutes(): number {
  const raw = Number(process.env.TASKFLOW_CHAT_AUTOCLOSE_MIN ?? 30);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

/** Закрыть простаивающие переписки ролей (dm/handoff), по которым нет идущей
 *  доставки. Возвращает число закрытых. dm-комната переиспользуется при новом
 *  сообщении пары (ensureDirectRoom не смотрит на closed_at), поэтому закрытие
 *  ничего не ломает — просто прячет разговор из списка владельца. */
export function autoCloseStaleRoleChats(idleMinutes = chatAutoCloseIdleMinutes()): number {
  const cutoff = `-${Math.max(1, Math.floor(idleMinutes))} minutes`;
  const rows = db.prepare(
    `SELECT id FROM chats
      WHERE room_kind IN ('dm', 'handoff')
        AND closed_at IS NULL
        AND julianday(updated_at) < julianday('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM chat_message_queue q
           WHERE q.chat_id = chats.id AND q.status IN ('pending', 'picked')
        )`,
  ).all(cutoff) as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  const close = db.prepare("UPDATE chats SET closed_at = COALESCE(closed_at, datetime('now')) WHERE id = ?");
  db.transaction((ids: string[]) => {
    for (const id of ids) close.run(id);
  })(rows.map((r) => r.id));
  console.log(`[chatAutoClose] закрыто простаивающих переписок ролей: ${rows.length}`);
  return rows.length;
}

/** Периодический проход автозакрытия — раз в 5 минут. */
export function startChatAutoClose(intervalMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    try {
      autoCloseStaleRoleChats();
    } catch (error) {
      console.warn("[chatAutoClose] проход не удался:", error instanceof Error ? error.message : error);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
