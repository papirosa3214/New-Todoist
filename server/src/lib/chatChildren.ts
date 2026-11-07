import crypto from "node:crypto";
import db from "../db.js";
import { ensurePersonalRoom } from "./chatRooms.js";
import { ensureTaskRoom, taskRoomOf } from "./projectTopics.js";
import { roleUserId } from "../roleRouting.js";

/**
 * Дочерние сессии личной комнаты роли (владелец 08.11.2026; спецификация
 * `docs/2026-11-08-role-slot-chat-branches-spec.md`, §1–2, §4, §6).
 *
 * Личная комната роли — родитель; дочерняя сессия — работа по конкретному
 * слоту. Разговор идёт не в личной комнате, а в общей комнате задачи: у
 * назначения свой ID, своя попытка и собственное поколение контекста, а
 * `talk_chat_id` указывает, где именно идёт разговор.
 *
 * Карточка назначения живёт ЗДЕСЬ, а не в `chat_messages`: отображаемая
 * карточка не должна попадать во вход модели ни через историю, ни через
 * выжимку, ни через кэш (§5). Отдельная таблица — самый простой способ
 * гарантировать это структурно.
 */

export type ChildKind = "branch" | "assignment";
export type ChildStatus = "assigned" | "delivered" | "answered" | "waiting" | "failed";

export interface ChildSession {
  id: string;
  kind: ChildKind;
  parent_chat_id: string;
  talk_chat_id: string;
  role_id: string;
  role_key: string | null;
  task_id: string | null;
  task_title: string | null;
  slot_id: string | null;
  slot_title: string | null;
  attempt_no: number;
  context_generation: number;
  status: ChildStatus;
  title: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CHILD = `SELECT c.id, c.kind, c.parent_chat_id, c.talk_chat_id, c.role_id,
        u.role_key AS role_key, c.task_id,
        (SELECT title FROM tasks WHERE id = c.task_id) AS task_title,
        c.slot_id, (SELECT title FROM subtasks WHERE id = c.slot_id) AS slot_title,
        c.attempt_no, c.context_generation, c.status, c.title, c.created_at, c.updated_at
   FROM chat_child_sessions c LEFT JOIN users u ON u.id = c.role_id`;

/** Дочерние сессии личной комнаты: карточки назначений по её слотам. */
export function assignmentsOf(personalChatId: string): ChildSession[] {
  return db
    .prepare(
      `${SELECT_CHILD} WHERE c.parent_chat_id = ? ORDER BY c.created_at ASC, c.id ASC`,
    )
    .all(personalChatId) as ChildSession[];
}

/** Дочерняя сессия слота, если она уже есть. */
export function childSessionOfSlot(slotId: string): ChildSession | undefined {
  return db
    .prepare(`${SELECT_CHILD} WHERE c.kind = 'assignment' AND c.slot_id = ?`)
    .get(slotId) as ChildSession | undefined;
}

/**
 * Назначение слота: сервер выдал роль готовый слот. Идемпотентно — повтор
 * (рестарт, повторная попытка, повторная доставка) продолжает ту же дочернюю
 * связь и не создаёт вторую карточку и второй запуск.
 */
export function ensureSlotAssignment(args: {
  taskId: string;
  slotId: string;
  role: string;
  attemptNo?: number;
}): { id: string; created: boolean } | null {
  const roleId = roleUserId(args.role);
  if (!roleId) return null;
  const personal = ensurePersonalRoom(roleId);
  const talk = taskRoomOf(args.taskId) ?? ensureTaskRoom(args.taskId);
  if (!personal || !talk) return null;
  const slot = db
    .prepare("SELECT title FROM subtasks WHERE id = ?")
    .get(args.slotId) as { title: string | null } | undefined;
  if (!slot) return null;
  return db.transaction(() => {
    const existing = db
      .prepare(
        "SELECT id FROM chat_child_sessions WHERE kind = 'assignment' AND slot_id = ?",
      )
      .get(args.slotId) as { id: string } | undefined;
    if (existing) {
      // Попытка продолжает ту же связь: номер попытки обновляется, поколение
      // контекста растёт, карточка не дублируется (§4, критерий 4).
      db.prepare(
        `UPDATE chat_child_sessions
            SET attempt_no = COALESCE(?, attempt_no),
                context_generation = context_generation + 1,
                status = 'delivered',
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(args.attemptNo ?? null, existing.id);
      return { id: existing.id, created: false };
    }
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO chat_child_sessions
         (id, kind, parent_chat_id, talk_chat_id, role_id, task_id, slot_id,
          attempt_no, context_generation, status, title)
       VALUES (?, 'assignment', ?, ?, ?, ?, ?, ?, 1, 'delivered', ?)`,
    ).run(
      id,
      personal,
      talk,
      roleId,
      args.taskId,
      args.slotId,
      args.attemptNo ?? 1,
      slot.title ?? null,
    );
    return { id, created: true };
  })();
}

/** Слот сдал результат: карточка получает подтверждение «ответ получен». */
export function markAssignmentAnswered(slotId: string): number {
  return db
    .prepare(
      `UPDATE chat_child_sessions SET status = 'answered', updated_at = datetime('now')
        WHERE kind = 'assignment' AND slot_id = ? AND status != 'answered'`,
    )
    .run(slotId).changes;
}
