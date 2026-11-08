import crypto from "node:crypto";
import db from "../db.js";
import { slotLabels } from "./slotResolution.js";

/**
 * Передача работы от слота к слоту (владелец 08.11.2026; спецификация
 * `docs/2026-11-08-role-slot-chat-branches-spec.md` §7).
 *
 * Раньше следующий слот получал комнату целиком: весь сырой лог последних
 * сообщений (`topicContext`) и, если ребро плана объявляло `artifact_key`,
 * артефакт предшественника. Разговор в комнате от этого не сжимался, и чем
 * дольше идёт задача, тем больше чужих реплик попадало в постановку этапа.
 *
 * Теперь передача — явная и короткая:
 *  • `handoffRecords` — по каждому закрытому слоту плана: кто, что сделал,
 *    каким вердиктом закрыт, какой артефакт сдал;
 *  • `handoffText` — этот список строкой для постановки этапа;
 *  • `conversationDigest` — разговор комнаты сжатый: последние реплики
 *    обрезаны, служебные карточки не берутся;
 *  • `insertHandoffCard` — карточка передачи в комнате задачи для человека.
 *    Она отображаемая, поэтому в историю модели не идёт (см.
 *    `lib/chatHistoryModel.ts`: `message_type='system'`).
 */

const SYSTEM_USER_ID = "taskflow_system";
const RESULT_LIMIT = 300;
const ARTIFACT_LIMIT = 200;
const CONVERSATION_MESSAGES = 8;
const CONVERSATION_LINE_LIMIT = 240;

export interface HandoffRecord {
  subtask_id: string;
  slot_key: string;
  label: string;
  role_key: string;
  verdict: string | null;
  result: string | null;
  artifact_key: string | null;
  artifact_summary: string | null;
}

function clip(text: string | null | undefined, limit: number): string | null {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1).trimEnd()}…` : trimmed;
}

/** Вердикт из результата слота: `closeNodeWithVerdict` пишет «approved: …». */
function verdictOf(result: string | null): string | null {
  const match = (result ?? "").match(/^(approved|changes_requested|blocked)\s*:/);
  return match ? match[1] : null;
}

/** Закрытые слоты утверждённого плана задачи — в порядке плана. */
export function handoffRecords(taskId: string): HandoffRecord[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.plan_node_key, s.result, n.role_key,
              (SELECT a.artifact_key FROM subtask_artifact_versions a
                WHERE a.subtask_id = s.id ORDER BY a.version_no DESC LIMIT 1) AS artifact_key,
              (SELECT a.summary FROM subtask_artifact_versions a
                WHERE a.subtask_id = s.id ORDER BY a.version_no DESC LIMIT 1) AS artifact_summary
         FROM subtasks s
         JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
         JOIN task_collaboration_plans p ON p.id = n.plan_id
        WHERE s.task_id = ? AND s.done = 1 AND p.status = 'approved' AND n.skipped_at IS NULL
        ORDER BY s.position, s.rowid`,
    )
    .all(taskId) as Array<{
    id: string;
    plan_node_key: string;
    result: string | null;
    role_key: string;
    artifact_key: string | null;
    artifact_summary: string | null;
  }>;
  const labels = new Map(slotLabels(taskId).map((slot) => [slot.subtask_id, slot.label]));
  return rows.map((row) => ({
    subtask_id: row.id,
    slot_key: row.plan_node_key,
    label: labels.get(row.id) ?? row.role_key,
    role_key: row.role_key,
    verdict: verdictOf(row.result),
    result: clip(row.result, RESULT_LIMIT),
    artifact_key: row.artifact_key,
    artifact_summary: clip(row.artifact_summary, ARTIFACT_LIMIT),
  }));
}

/** Передача работы строкой для постановки этапа. Пусто — плана ещё нет. */
export function handoffText(taskId: string): string {
  const records = handoffRecords(taskId).filter((record) => record.result || record.artifact_summary);
  if (!records.length) return "";
  const lines = records.map((record) => {
    const parts = [`- ${record.label} (слот ${record.slot_key}${record.verdict ? `, вердикт ${record.verdict}` : ""})`];
    if (record.result) parts[0] += `: ${record.result}`;
    if (record.artifact_key)
      parts.push(`  артефакт ${record.artifact_key}${record.artifact_summary ? `: ${record.artifact_summary}` : ""}`);
    return parts.join("\n");
  });
  return [
    "Передача работы от предыдущих слотов (итог, а не переписка):",
    ...lines,
    "Своё делай от этого итога; подтверждения ищи в артефакте, а не в разговоре.",
  ].join("\n");
}

/**
 * Разговор комнаты задачи, сжатый для постановки этапа: последние реплики,
 * обрезанные по длине; карточки и служебные уведомления не берутся.
 */
export function conversationDigest(taskId: string, roomId: string): string {
  const rows = db
    .prepare(
      `SELECT m.created_at, m.text, COALESCE(u.name, m.from_user_id) AS from_name
         FROM chat_messages m LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.chat_id = ? AND COALESCE(m.is_session_marker, 0) = 0
          AND COALESCE(m.message_type, '') != 'system'
        ORDER BY m.rowid DESC LIMIT ?`,
    )
    .all(roomId, CONVERSATION_MESSAGES) as Array<{ created_at: string; text: string; from_name: string }>;
  if (!rows.length) return "";
  const lines = rows.reverse().map((row) => `- [${row.created_at}] ${row.from_name}: ${clip(row.text, CONVERSATION_LINE_LIMIT)}`);
  return [
    `Разговор в комнате задачи ${taskId} (сжато, ${rows.length} последних реплик):`,
    ...lines,
  ].join("\n");
}

/** Карточка передачи в комнате задачи: человеку видно, кто кому что передал. */
export function insertHandoffCard(taskId: string, roomId: string, slotId: string): void {
  const record = handoffRecords(taskId).find((item) => item.subtask_id === slotId);
  if (!record) return;
  const summary = record.artifact_summary || record.result || "без итога";
  const text = `${record.label}: этап закрыт${record.verdict ? ` (${record.verdict})` : ""} · ${summary}`;
  const steps = JSON.stringify({
    duration_ms: 0,
    items: [],
    handoff: {
      slot_id: record.subtask_id,
      slot_key: record.slot_key,
      label: record.label,
      role_key: record.role_key,
      verdict: record.verdict,
      artifact_key: record.artifact_key,
      artifact_summary: record.artifact_summary,
    },
  });
  const exists = db
    .prepare(
      `SELECT 1 FROM chat_messages
        WHERE chat_id = ? AND message_type = 'system'
          AND json_extract(steps, '$.handoff.slot_id') = ?`,
    )
    .get(roomId, record.subtask_id);
  if (exists) return;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, message_type, steps)
       VALUES (?, ?, ?, 'chat', ?, ?, 'system', ?)`,
    ).run(crypto.randomUUID(), SYSTEM_USER_ID, text, roomId, taskId, steps);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(roomId);
  })();
}
