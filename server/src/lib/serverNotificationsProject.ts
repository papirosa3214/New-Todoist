// Проект «Серверные уведомления» — куда попадают ВСЕ задачи, которые сервер
// заводит по серверным уведомлениям: карточки на диагностику
// (inboxTriageWatcher) и на устранение (inboxResultsWriter).
//
// Решение Максима 27.09.2026: «создай проект „Серверные уведомления", и чтобы
// они всегда все туда попадали». До этого карточки создавались без проекта и
// падали во «Входящие» вперемешку с его задачами.
//
// Идентификатор постоянный: переименует Максим проект — задачи всё равно
// пойдут в него, а не в новый с тем же названием.

import db from "../db.js";

export const SERVER_NOTIFICATIONS_PROJECT_ID = "server-notifications";
export const SERVER_NOTIFICATIONS_PROJECT_NAME = "Серверные уведомления";

/** id проекта; создаёт его у владельца, если проекта ещё нет. */
export function serverNotificationsProjectId(ownerId: string): string {
  const row = db
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(SERVER_NOTIFICATIONS_PROJECT_ID) as { id: string } | undefined;
  if (row) return row.id;
  const pos = db
    .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM projects WHERE owner_id = ?`)
    .get(ownerId) as { p: number };
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, color, owner_id, position)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(SERVER_NOTIFICATIONS_PROJECT_ID, SERVER_NOTIFICATIONS_PROJECT_NAME, "#E4575A", ownerId, pos.p);
  return SERVER_NOTIFICATIONS_PROJECT_ID;
}
