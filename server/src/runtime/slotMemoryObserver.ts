// Наблюдатель слота: после полного снимка done выносит устойчивый урок в
// memories. Не в задании роли, не в ленте, не в карточках — только remember().
import db from "../db.js";
import { callUnifiedAi } from "../lib/aiClient.js";
import { remember } from "../lib/memory.js";
import type { SlotSnapshotRow } from "./slotWorkSnapshot.js";

const MIN_CONFIDENCE = 0.6;

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
  if (snapshot.reason !== "done" || snapshot.is_complete !== 1)
    return { wrote: false, reason: "not_done" };
  const roleKey = snapshot.role_key;
  if (!roleKey) return { wrote: false, reason: "no_role" };
  const sourceRef = `obs:${snapshot.subtask_id}:${snapshot.attempt_id ?? "none"}`.slice(0, 100);
  const already = db.prepare("SELECT id FROM memories WHERE source_ref = ?").get(sourceRef);
  if (already) return { wrote: false, reason: "already" };

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

  let raw: string;
  try {
    raw = await callUnifiedAi({
      systemPrompt: SYSTEM,
      userPrompt,
      think: false,
      predictTokens: 400,
      temperature: 0,
    });
  } catch {
    return { wrote: false, reason: "model" };
  }
  const parsed = parseObserverJson(raw);
  if (!parsed || parsed.action !== "remember") return { wrote: false, reason: "skip" };
  if ((parsed.confidence ?? 0) < MIN_CONFIDENCE) return { wrote: false, reason: "low_confidence" };
  const text = String(parsed.text ?? "").trim();
  if (!text) return { wrote: false, reason: "skip" };
  const kind = parsed.kind === "fact" || parsed.kind === "preference" ? parsed.kind : "lesson";
  const result = await remember(
    {
      scope: "role",
      role_key: roleKey,
      kind,
      title: String(parsed.title ?? "").trim() || null,
      text,
      source_ref: sourceRef,
    },
    { id: snapshot.author_id ?? `role_${roleKey}`, kind: "role" },
    { onDuplicate: "skip", skipWriteReview: true },
  );
  if (result.skipped) return { wrote: false, reason: "similar" };
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
