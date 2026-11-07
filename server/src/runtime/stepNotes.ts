import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleUserId } from "../roleRouting.js";
import { isRoutineServiceComment } from "../lib/serviceNoise.js";

/** Заметки и уведомления шага — общие для сторожа зависших шагов и для
 *  остановки по циклу неверных вызовов. Вынесены отдельным модулем, чтобы
 *  оба места пользовались одним и тем же способом доложить владельцу, а
 *  не расходились копиями (24.10.2026). */
export function ownerId(): string | null {
  const row = db
    .prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function taskHeads(taskId: string): {
  creator_id: string | null;
  assignee_id: string | null;
  title: string;
} {
  const row = db
    .prepare("SELECT creator_id, assignee_id, title FROM tasks WHERE id = ?")
    .get(taskId) as
    | { creator_id: string | null; assignee_id: string | null; title: string }
    | undefined;
  return row ?? { creator_id: null, assignee_id: null, title: "" };
}

/** Заметка в ленту карточки от имени роли. Рутинный сервисный шум
 *  отфильтровывается — как и раньше в стороже зависших шагов. */
export function postRoleNote(taskId: string, role: string, text: string): void {
  if (isRoutineServiceComment({ user_id: "role_system", text })) return;
  db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), taskId, roleUserId(role), text);
}

/** Уведомление владельцу + запись в ленту карточки. Тип уведомления и вид
 *  события разведены: уведомление сторожа остаётся `stalled_blocked`
 *  (по нему владелец и тесты фильтруют), а вид события в ленте — свой. */
export function postOwnerNotification(
  taskId: string,
  title: string,
  body: string,
  options: { notificationType?: string; eventKind?: string } = {},
): void {
  const notificationType = options.notificationType ?? "stalled_blocked";
  const eventKind = options.eventKind ?? "stalled_step_blocked";
  const owner = ownerId();
  if (!owner) return;
  const notifId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(notifId, owner, notificationType, taskId, body);
  logEvent({ taskId, actorId: null, kind: eventKind, field: title, toValue: body.slice(0, 160) });
}
