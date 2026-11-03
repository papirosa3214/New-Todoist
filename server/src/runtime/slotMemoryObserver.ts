// Наблюдатель слота: после полного снимка done выносит устойчивый урок в
// memories. Роль вызов не видит; владельцу при записи — тихий чип в ленте.
// Модель и порог — из серверных настроек (телефон: Настройки → Наблюдатель памяти).
import crypto from "node:crypto";
import db from "../db.js";
import { callRuntimeModel } from "../lib/runtimeAi.js";
import { getSetting } from "../lib/serverSettings.js";
import { remember } from "../lib/memory.js";
import { recordMemoryObserverEvent } from "../lib/memoryObserverLog.js";
import { ensurePersonalRoom } from "../lib/chatRooms.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import { broadcastToUsers } from "../ws.js";
import type { SlotSnapshotRow } from "./slotWorkSnapshot.js";

const SYSTEM_USER_ID = "taskflow_system";

const SYSTEM = `Ты наблюдатель памяти TaskFlow. По готовому итогу слота реши, есть ли устойчивый урок на будущее.
Это не отчёт о работе и не пересказ. Нужно правило, приём или факт, который пригодится в другой похожей задаче.
Если не уверен — не пиши.
Ответ — один JSON без текста вокруг:
{"action":"skip"}
или
{"action":"remember","title":"...","text":"...","kind":"lesson","confidence":0.0}
kind: lesson | fact | preference. confidence от 0 до 1.
Не выдумывай. Не пиши разовые детали текущей карточки.`;

export async function observeSlotMemory(
  snapshot: SlotSnapshotRow,
): Promise<{ wrote: boolean; reason?: string }> {
  const base = {
    role_key: snapshot.role_key,
    task_id: snapshot.task_id,
    subtask_id: snapshot.subtask_id,
  };
  if (!getSetting("memory_observer_enabled")) {
    recordMemoryObserverEvent({ ...base, outcome: "disabled" });
    return { wrote: false, reason: "disabled" };
  }
  if (snapshot.reason !== "done" || snapshot.is_complete !== 1) {
    recordMemoryObserverEvent({ ...base, outcome: "not_done", detail: String(snapshot.reason) });
    return { wrote: false, reason: "not_done" };
  }
  const roleKey = snapshot.role_key;
  if (!roleKey) {
    recordMemoryObserverEvent({ ...base, outcome: "no_role" });
    return { wrote: false, reason: "no_role" };
  }
  const sourceRef = `obs:${snapshot.subtask_id}:${snapshot.attempt_id ?? "none"}`.slice(0, 100);
  const already = db.prepare("SELECT id FROM memories WHERE source_ref = ?").get(sourceRef);
  if (already) {
    recordMemoryObserverEvent({ ...base, outcome: "already", source_ref: sourceRef });
    return { wrote: false, reason: "already" };
  }

  const task = db.prepare("SELECT title, project_id FROM tasks WHERE id = ?").get(snapshot.task_id) as
    | { title: string; project_id: string | null }
    | undefined;
  const userPrompt = [
    `Роль: ${roleKey}`,
    `Задача: ${task?.title ?? snapshot.task_id}`,
    snapshot.done_summary ? `Сделано: ${snapshot.done_summary}` : "",
    snapshot.left_summary ? `Осталось: ${snapshot.left_summary}` : "",
    snapshot.blocker ? `Блок: ${snapshot.blocker}` : "",
    snapshot.next_step ? `Дальше: ${snapshot.next_step}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const modelRef = String(getSetting("memory_observer_model") ?? "").trim();
  let raw: string;
  try {
    raw = await callRuntimeModel({
      systemPrompt: SYSTEM,
      userPrompt,
      maxTokens: 400,
      ...(modelRef ? { modelRef } : {}),
    });
  } catch (error) {
    recordMemoryObserverEvent({
      ...base,
      outcome: "model",
      source_ref: sourceRef,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { wrote: false, reason: "model" };
  }
  const parsed = parseObserverJson(raw);
  if (!parsed) {
    recordMemoryObserverEvent({
      ...base,
      outcome: "parse_error",
      source_ref: sourceRef,
      detail: String(raw).slice(0, 200),
    });
    return { wrote: false, reason: "parse_error" };
  }
  if (parsed.action !== "remember") {
    recordMemoryObserverEvent({
      ...base,
      outcome: "skip",
      source_ref: sourceRef,
      confidence: parsed.confidence ?? null,
      detail: "model_skip",
    });
    return { wrote: false, reason: "skip" };
  }
  const minConfidence = Number(getSetting("memory_observer_min_confidence") ?? 60) / 100;
  if ((parsed.confidence ?? 0) < minConfidence) {
    recordMemoryObserverEvent({
      ...base,
      outcome: "low_confidence",
      source_ref: sourceRef,
      confidence: parsed.confidence ?? null,
      title: parsed.title ?? null,
      detail: `ниже порога ${Math.round(minConfidence * 100)}%`,
    });
    return { wrote: false, reason: "low_confidence" };
  }
  const text = String(parsed.text ?? "").trim();
  if (!text) {
    recordMemoryObserverEvent({ ...base, outcome: "skip", source_ref: sourceRef, detail: "empty_text" });
    return { wrote: false, reason: "skip" };
  }
  const kind = parsed.kind === "fact" || parsed.kind === "preference" ? parsed.kind : "lesson";
  const title = String(parsed.title ?? "").trim() || null;
  const result = await remember(
    {
      scope: "role",
      role_key: roleKey,
      kind,
      title,
      text,
      source_ref: sourceRef,
    },
    { id: snapshot.author_id ?? `role_${roleKey}`, kind: "role" },
    { onDuplicate: "skip", skipWriteReview: true },
  );
  if (result.skipped) {
    recordMemoryObserverEvent({
      ...base,
      outcome: "similar",
      source_ref: sourceRef,
      confidence: parsed.confidence ?? null,
      title,
      detail: "похожая запись уже есть",
    });
    return { wrote: false, reason: "similar" };
  }
  recordMemoryObserverEvent({
    ...base,
    outcome: "wrote",
    source_ref: sourceRef,
    confidence: parsed.confidence ?? null,
    title,
    detail: text.slice(0, 200),
  });
  postMemoryUpdateChip(snapshot, {
    title,
    kind,
    confidence: parsed.confidence ?? null,
  });
  return { wrote: true };
}

/** Только личная комната владельца с ролью.
 *  Не тема задачи и не dm ролей между собой — владелец 03.11.2026:
 *  чип только там, где он сам общается с ролью. */
function resolveMemoryChipChatId(snapshot: SlotSnapshotRow): string | null {
  const roleId =
    snapshot.author_id ??
    (
      db
        .prepare(
          "SELECT id FROM users WHERE role_key = ? AND type = 'ai' AND COALESCE(archived, 0) = 0 ORDER BY id LIMIT 1",
        )
        .get(snapshot.role_key) as { id: string } | undefined
    )?.id ??
    (snapshot.role_key ? `role_${snapshot.role_key}` : null);
  if (!roleId) return null;
  const chatId = ensurePersonalRoom(roleId);
  if (!chatId) return null;
  // На всякий случай: не писать в dm / чужие комнаты.
  const kind = db.prepare("SELECT room_kind FROM chats WHERE id = ?").get(chatId) as
    | { room_kind: string | null }
    | undefined;
  if (kind?.room_kind !== "personal") return null;
  return chatId;
}

function postMemoryUpdateChip(
  snapshot: SlotSnapshotRow,
  update: { title: string | null; kind: string; confidence: number | null },
): void {
  const chatId = resolveMemoryChipChatId(snapshot);
  if (!chatId) return;
  const title = update.title?.trim() || null;
  const text = title ? `Память обновлена · ${title}` : "Память обновлена";
  const id = crypto.randomUUID();
  const steps = JSON.stringify({
    duration_ms: 0,
    items: [],
    memory_update: {
      title,
      kind: update.kind,
      confidence: update.confidence,
    },
  });
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, task_id, message_type, steps)
         VALUES (?, ?, ?, 'chat', ?, ?, 'system', ?)`,
      ).run(id, SYSTEM_USER_ID, text, chatId, snapshot.task_id, steps);
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(chatId);
    })();
  } catch (error) {
    console.warn(
      "[slot-memory-observer] чип в чат не записан:",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const message = loadChatMessage(id);
  if (!message) return;
  const audience = (
    db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(chatId) as {
      member_id: string;
    }[]
  ).map((row) => row.member_id);
  broadcastToUsers(audience, { type: "chat:new", message });
}

function parseObserverJson(raw: string): {
  action?: string;
  title?: string;
  text?: string;
  kind?: string;
  confidence?: number;
} | null {
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, "$1").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as {
      action?: string;
      title?: string;
      text?: string;
      kind?: string;
      confidence?: number;
    };
  } catch {
    return null;
  }
}
