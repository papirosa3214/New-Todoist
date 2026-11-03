// Наблюдатель слота: после полного снимка done выносит устойчивый урок в
// memories. Роль вызов не видит. Чип владельцу — memoryObserverChatChip.ts.
// Модель и порог — из серверных настроек (телефон: Настройки → Наблюдатель памяти).
import db from "../db.js";
import { callRuntimeModel } from "../lib/runtimeAi.js";
import { getSetting } from "../lib/serverSettings.js";
import { remember } from "../lib/memory.js";
import { recordMemoryObserverEvent } from "../lib/memoryObserverLog.js";
import { postMemoryUpdateChip } from "./memoryObserverChatChip.js";
import type { SlotSnapshotRow } from "./slotWorkSnapshot.js";

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
