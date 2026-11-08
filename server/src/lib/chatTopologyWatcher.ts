import { randomUUID } from "node:crypto";
import db from "../db.js";

/// Сторож топологии чатов (спецификация 08.11.2026, §10). Проверяет то, что
/// ломается молча: ребёнок потерял связь со своей комнатой задачи, реплика
/// адресована слоту другой задачи, передача слоту зависла на доставке,
/// архивная комната продолжает получать доставку.
export interface ChatTopologyFindings {
  children: number;
  addressee: number;
  handoff: number;
  archived: number;
}
export interface ChatTopologyReport {
  ok: boolean;
  findings: ChatTopologyFindings;
  details: string[];
}

const count = (row: unknown): number => Number((row as { n?: number } | undefined)?.n ?? 0);

/// Дети: связь с родителем и с комнатой задачи должна оставаться целой.
const orphanChildren = () =>
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_child_sessions c
           LEFT JOIN chats parent ON parent.id = c.parent_chat_id
           LEFT JOIN chats talk ON talk.id = c.talk_chat_id
          WHERE talk.id IS NULL
             OR COALESCE(talk.room_kind, '') != 'task'
             OR parent.id IS NULL
             OR talk.task_id IS NOT c.task_id`,
      )
      .get(),
  );

/// Адресат: @-слот должен принадлежать той же задаче, что и комната.
const wrongAddressee = () =>
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id
           LEFT JOIN subtasks s ON s.id = m.recipient_subtask_id
          WHERE m.recipient_subtask_id IS NOT NULL
            AND c.task_id IS NOT NULL
            AND (s.id IS NULL OR s.task_id IS NOT c.task_id)`,
      )
      .get(),
  );

/// Передача: доставлено слоту сутки назад и до сих пор без ответа.
const STUCK_HANDOFF_HOURS = 24;
const stuckHandoff = () =>
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_child_sessions
          WHERE status = 'delivered' AND updated_at < datetime('now', ?)`,
      )
      .get(`-${STUCK_HANDOFF_HOURS} hours`),
  );

/// Архив: в архивную комнату не должно уходить ничего — ни в очередь, ни в ленту.
const ARCHIVE_DELIVERY_LOOKBACK_DAYS = 1;
const archivedDelivery = () =>
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_message_queue q
           JOIN chats c ON c.id = q.chat_id
          WHERE c.archived_at IS NOT NULL
            AND COALESCE(q.status, 'pending') NOT IN ('done', 'failed', 'superseded')`,
      )
      .get(),
  ) +
  count(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_messages m
           JOIN chats c ON c.id = m.chat_id
          WHERE c.archived_at IS NOT NULL AND m.created_at >= datetime('now', ?)`,
      )
      .get(`-${ARCHIVE_DELIVERY_LOOKBACK_DAYS} days`),
  );

export function checkChatTopology(): ChatTopologyReport {
  const findings: ChatTopologyFindings = {
    children: orphanChildren(),
    addressee: wrongAddressee(),
    handoff: stuckHandoff(),
    archived: archivedDelivery(),
  };
  const details: string[] = [];
  if (findings.children) details.push(`${findings.children} дочерних сессий без связи с комнатой задачи`);
  if (findings.addressee) details.push(`${findings.addressee} реплик адресованы слоту чужой задачи`);
  if (findings.handoff) details.push(`${findings.handoff} передач висят на доставке больше ${STUCK_HANDOFF_HOURS} ч`);
  if (findings.archived) details.push(`${findings.archived} доставок в архивные комнаты`);
  return { ok: details.length === 0, findings, details };
}

/// Пробный ход: ломаем связь нарочно и проверяем, что сторож это видит.
/// Всё откатывается одной транзакцией.
export function probeChatTopology(): { ok: boolean; reason?: string } {
  const rollback = new Error("chat-topology probe rollback");
  const suffix = "probe-" + randomUUID();
  try {
    db.transaction(() => {
      const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as { id: string } | undefined;
      if (!owner) throw new Error("нет владельца для пробы");
      db.prepare(
        "INSERT INTO chats(id, kind, title, created_by, room_kind) VALUES(?, 'group', 'Проба топологии', ?, 'personal')",
      ).run(suffix, owner.id);
      db.prepare(
        `INSERT INTO chat_child_sessions(id, kind, parent_chat_id, talk_chat_id, role_id, task_id, status)
         VALUES(?, 'assignment', ?, ?, ?, NULL, 'assigned')`,
      ).run(suffix + "-child", suffix, suffix, owner.id);
      if (orphanChildren() < 1) throw new Error("потеря связи с комнатой задачи не обнаружена");
      throw rollback;
    })();
  } catch (error) {
    return error === rollback ? { ok: true } : { ok: false, reason: String(error) };
  }
  return { ok: false, reason: "проба не завершилась" };
}

const NOTIFICATION_TEXT =
  "Цепочка чатов сломана: {details}. Часть результатов может не дойти до своих слотов, а архив — получать доставку. Проверить docs/watchers.md и checkChatTopology.";

export function startChatTopologyWatcher(): () => void {
  const check = () => {
    try {
      const report = checkChatTopology();
      if (report.ok) return;
      const type = "chat_topology_watch";
      if (db.prepare("SELECT 1 FROM notifications WHERE type = ? AND created_at >= datetime('now', '-1 day')").get(type)) return;
      const text = NOTIFICATION_TEXT.replace("{details}", report.details.join("; "));
      for (const owner of db.prepare("SELECT id FROM users WHERE role = 'owner'").all() as { id: string }[]) {
        db.prepare("INSERT INTO notifications(id, user_id, type, text) VALUES(?, ?, ?, ?)").run(randomUUID(), owner.id, type, text);
      }
    } catch {
      console.warn("chat-topology: сторож не смог проверить связь чатов");
    }
  };
  const first = setTimeout(check, 60_000);
  const timer = setInterval(check, 15 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
