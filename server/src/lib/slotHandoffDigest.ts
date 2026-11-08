import crypto from "node:crypto";
import db from "../db.js";
import { handoffRecords, type HandoffRecord } from "./slotHandoff.js";

/**
 * Выжимка передачи работы (владелец 08.11.2026; спецификация
 * `docs/2026-11-08-role-slot-chat-branches-spec.md` §7, критерии 8–10).
 *
 * Отличие от `lib/slotHandoff.ts`: там передача просто обрезалась по
 * постоянным пределам (300 символов на итог, 200 — на артефакт). Здесь размер
 * выжимки считается от окна той модели, которая принимает работу:
 *
 *  • `handoffBudget` — сколько символов выжимка может занять при данном окне;
 *    ниже — жёсткий минимум (меньше читать бессмысленно), выше — жёсткий
 *    максимум (передача не должна становиться вторым логом);
 *  • граница передачи фиксируется: `boundary_message_id` — последнее событие
 *    в комнате задачи до передачи, `artifact_version_id` — версия артефакта,
 *    по которой слот сдавал работу. Повтор с той же границей отдаёт ровно тот
 *    же текст (`slot_handoffs.boundary_message_id` уникален) — передача
 *    идемпотентна;
 *  • сбой сжатия (нет данных о модели, ошибка) не теряет историю: в базе
 *    остаётся строка `state='failed'` с причиной, а вызывающий получает
 *    несжатую передачу из `slotHandoff.handoffText` — видимая история комнаты
 *    при этом не меняется вообще;
 *  • `evidence` — первичные доказательства для Критика: id сообщений и версий
 *    артефактов, по которым построена выжимка.
 *
 * Сжатие здесь извлекающее (первые предложения итога), без запроса к модели:
 * передача строится внутри постановки этапа, а модельный вызов в этом месте
 * держал бы слот и стоил бы хода роли. Модельная выжимка остаётся там, где ей
 * место, — при компакции сессии (`runtime/compactionFallback.ts`).
 */

/** Сколько символов приходится на токен при оценке размера текста. */
export const CHARS_PER_TOKEN = 4;
/** Какую долю окна модели передача имеет право занять. */
export const HANDOFF_WINDOW_SHARE = 0.05;
export const HANDOFF_CHARS_MIN = 800;
export const HANDOFF_CHARS_MAX = 12_000;
/** Окно, когда о модели ничего не известно. Хватает на короткую передачу. */
export const FALLBACK_WINDOW_TOKENS = 32_000;

export interface HandoffDigest {
  text: string;
  state: "ready" | "failed";
  reason: string | null;
  boundary: string | null;
  windowTokens: number | null;
  budget: number;
  evidence: string[];
}

/** Предел выжимки по окну принимающей модели. */
export function handoffBudget(windowTokens?: number | null): number {
  const raw = typeof windowTokens === "number" && Number.isFinite(windowTokens) ? Math.floor(windowTokens) : 0;
  const tokens = raw > 0 ? raw : FALLBACK_WINDOW_TOKENS;
  const chars = Math.round(tokens * CHARS_PER_TOKEN * HANDOFF_WINDOW_SHARE);
  return Math.min(HANDOFF_CHARS_MAX, Math.max(HANDOFF_CHARS_MIN, chars));
}

/** Окно модели роли: последнее измерение контекста этой роли, если оно есть. */
export function roleWindowTokens(roleKey: string): number | null {
  const row = db
    .prepare(
      `SELECT u.context_window FROM chat_context_usage u
         JOIN users r ON r.id = u.role_id
        WHERE r.role_key = ? AND u.context_window IS NOT NULL AND u.context_window > 0
        ORDER BY u.measured_at DESC, u.rowid DESC LIMIT 1`,
    )
    .get(roleKey) as { context_window: number } | undefined;
  return row ? row.context_window : null;
}

/** Последнее событие в комнате задачи — граница передачи. */
export function handoffBoundary(roomId: string | null): string | null {
  if (!roomId) return null;
  const row = db.prepare("SELECT MAX(rowid) AS id FROM chat_messages WHERE chat_id = ?").get(roomId) as
    | { id: number | null }
    | undefined;
  return row && row.id != null ? String(row.id) : null;
}

/** Версия артефакта, по которой слот сдавал работу: доказательство для Критика. */
function artifactVersionId(subtaskId: string): string | null {
  const row = db
    .prepare("SELECT id FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1")
    .get(subtaskId) as { id: string } | undefined;
  return row ? row.id : null;
}

/** Извлекающее сжатие: целые предложения, пока влезают в предел. */
export function compressTo(text: string | null | undefined, budget: number): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (trimmed.length <= budget) return trimmed;
  const sentences = trimmed.split(/(?<=[.!?…])\s+/).filter(Boolean);
  let out = "";
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > budget) break;
    out = candidate;
  }
  if (!out) out = `${trimmed.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return out.length >= trimmed.length ? out : `${out.replace(/[.…]\s*$/, "")}…`;
}

function recordLine(record: HandoffRecord, budget: number): string {
  const head = `- ${record.label} (слот ${record.slot_key}${record.verdict ? `, вердикт ${record.verdict}` : ""})`;
  const result = compressTo(record.result, Math.max(120, Math.round(budget * 0.6)));
  const artifact = record.artifact_summary
    ? compressTo(record.artifact_summary, Math.max(120, Math.round(budget * 0.4)))
    : "";
  const parts = [result ? `${head}: ${result}` : head];
  if (record.artifact_key) parts.push(`  артефакт ${record.artifact_key}${artifact ? `: ${artifact}` : ""}`);
  return parts.join("\n");
}

function buildDigestText(records: HandoffRecord[], budget: number, evidence: string[]): string {
  const header = "Передача работы от предыдущих слотов (итог, а не переписка):";
  const footer = "Своё делай от этого итога; подтверждения ищи в артефакте, а не в разговоре.";
  const evidenceLine = evidence.length ? `Первичные доказательства: ${evidence.join(", ")}.` : "";
  const room = budget - header.length - footer.length - evidenceLine.length - 8;
  const perRecord = records.length ? Math.max(160, Math.floor(room / records.length)) : room;
  const lines = records.map((record) => recordLine(record, perRecord));
  return [header, ...lines, footer, evidenceLine].filter(Boolean).join("\n");
}

function windowOf(windowTokens: number | null | undefined, roleKey: string | null | undefined): number | null {
  const given = typeof windowTokens === "number" && Number.isFinite(windowTokens) && windowTokens > 0 ? Math.floor(windowTokens) : null;
  if (given) return given;
  if (roleKey) return roleWindowTokens(roleKey);
  return null;
}

/**
 * Выжимка передачи для слота: считается от окна модели и запоминается по
 * границе. Тот же `boundary` — тот же текст, новый — новая строка.
 */
export function handoffDigest(
  taskId: string,
  options: { roomId?: string | null; roleKey?: string | null; windowTokens?: number | null } = {},
): HandoffDigest {
  const roomId = options.roomId ?? null;
  const boundary = handoffBoundary(roomId);
  const windowTokens = windowOf(options.windowTokens, options.roleKey ?? null);
  const budget = handoffBudget(windowTokens);
  const records = handoffRecords(taskId).filter((record) => record.result || record.artifact_summary);

  if (boundary) {
    const stored = db
      .prepare("SELECT digest, state, reason FROM slot_handoffs WHERE task_id = ? AND boundary_message_id = ?")
      .get(taskId, boundary) as { digest: string; state: "ready" | "failed"; reason: string | null } | undefined;
    if (stored) {
      return {
        text: stored.digest,
        state: stored.state,
        reason: stored.reason,
        boundary,
        windowTokens,
        budget,
        evidence: [],
      };
    }
  }

  if (!records.length) {
    return { text: "", state: "ready", reason: null, boundary, windowTokens, budget, evidence: [] };
  }

  const evidence: string[] = [];
  for (const record of records) {
    evidence.push(`слот ${record.slot_key}`);
    const version = artifactVersionId(record.subtask_id);
    if (version) evidence.push(`артефакт ${record.artifact_key ?? record.slot_key} v${version}`);
  }
  if (boundary) evidence.push(`событие ${boundary}`);

  // Нет данных о модели — это не повод рвать передачу. Пишем причину и
  // отдаём несжатый текст: история комнаты при этом не меняется.
  const failed = windowTokens == null;
  const text = failed
    ? ""
    : buildDigestText(records, budget, evidence);
  const reason = failed ? "окно модели неизвестно: сжатие не выполнялось, передача без правки" : null;

  if (boundary) {
    db.prepare(
      `INSERT INTO slot_handoffs (id, task_id, boundary_message_id, window_tokens, budget_chars, digest, state, reason, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, boundary_message_id) DO NOTHING`,
    ).run(
      crypto.randomUUID(),
      taskId,
      boundary,
      windowTokens,
      budget,
      text,
      failed ? "failed" : "ready",
      reason,
      JSON.stringify(evidence),
    );
  }

  return { text, state: failed ? "failed" : "ready", reason, boundary, windowTokens, budget, evidence };
}
