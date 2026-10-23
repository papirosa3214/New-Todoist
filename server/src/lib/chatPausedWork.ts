// Пауза работы роли в личном чате (владелец 23.10.2026).
//
// Схема: владелец пишет в личный чат, пока роль занята длинным ходом. Ход
// останавливается («пауза»), в этой же комнате роль отвечает на новое
// сообщение. Пока владелец разговаривает, работа стоит. Минуту тишины — роль
// сама возвращается к прерванной работе с учётом разговора.
//
// Здесь только данные и решение «пора возвращаться»: сама остановка хода и
// запуск нового живут в routes/chats.ts (там же очередь и сессии).

import db from "../db.js";

/** Сколько тишины после последнего сообщения владельца держим паузу. */
export const CHAT_PAUSE_QUIET_MS = Number(process.env.TASKFLOW_CHAT_PAUSE_MS ?? 60_000);
/** Потолок паузы: дольше держать работу остановленной нельзя. */
export const CHAT_PAUSE_MAX_MS = Number(process.env.TASKFLOW_CHAT_PAUSE_MAX_MS ?? 10 * 60_000);

export type PausedWork = {
  id: string;
  chatId: string;
  roleId: string;
  ownerId: string;
  pausedAt: string;
};

/** Поставить чат на паузу (ход остановлен новым сообщением владельца). */
export function pauseChatWork(chatId: string, roleId: string, ownerId: string): void {
  const existing = db
    .prepare("SELECT id FROM chat_paused_work WHERE chat_id = ? AND role_id = ? AND resumed_at IS NULL")
    .get(chatId, roleId) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE chat_paused_work SET last_owner_at = datetime('now') WHERE id = ?").run(existing.id);
    return;
  }
  db.prepare(
    "INSERT INTO chat_paused_work (id, chat_id, role_id, owner_id, paused_at, last_owner_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
  ).run(crypto.randomUUID(), chatId, roleId, ownerId);
}

/** Владелец написал ещё — пауза продлевается. */
export function noteOwnerMessageWhilePaused(chatId: string): void {
  db.prepare("UPDATE chat_paused_work SET last_owner_at = datetime('now') WHERE chat_id = ? AND resumed_at IS NULL").run(chatId);
}

/** Пауза снята — строка закрывается. */
export function finishPausedWork(id: string): void {
  db.prepare("UPDATE chat_paused_work SET resumed_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * Кого пора возвращать в работу. Тишина считается от последнего сообщения
 * владельца, а не от остановки: пока он разговаривает, работа стоит; потолок
 * паузы снимает зависание, даже если он молчит не минуту, а дольше.
 */
export function duePausedWork(now = Date.now()): PausedWork[] {
  const rows = db
    .prepare(
      `SELECT id, chat_id, role_id, owner_id, paused_at, last_owner_at FROM chat_paused_work WHERE resumed_at IS NULL`,
    )
    .all() as Array<{ id: string; chat_id: string; role_id: string; owner_id: string; paused_at: string; last_owner_at: string }>;
  const toMs = (value: string) => Date.parse(value.replace(" ", "T") + "Z");
  return rows
    .filter((row) => {
      const quiet = now - toMs(row.last_owner_at);
      const total = now - toMs(row.paused_at);
      return quiet >= CHAT_PAUSE_QUIET_MS || total >= CHAT_PAUSE_MAX_MS;
    })
    .map((row) => ({ id: row.id, chatId: row.chat_id, roleId: row.role_id, ownerId: row.owner_id, pausedAt: row.paused_at }));
}
