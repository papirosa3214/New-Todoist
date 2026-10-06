// «Что уже было по этой карточке» — краткая сводка прошлых ходов, которую
// сервер собирает БЕЗ модели и подкладывает в задание каждого шага (владелец
// 06.10.2026). Зачем: роль нового слота начинала с чистого листа и писала
// «памяти о прошлых сессиях нет» — следующий шаг не видел ни результата
// предыдущего, ни дефектов проверки, ни замечаний владельца.
//
// Что внутри (ровно по постановке):
//   1. предыдущие шаги плана и доработки — роль, результат строкой, ссылка на
//      артефакт/документ/коммит;
//   2. последние снимки слотов карточки (`slot_work_snapshots`) — по строке на
//      слот, как в `roleSlotSnapshotsBlock`;
//   3. вердикты и дефекты QA/Критика по карточке — суть и id комментария;
//   4. последние комментарии владельца.
//
// Границы: только чтение базы, никаких вызовов модели. Блок короткий (до
// ~1500 знаков), остальное — ссылками на документы. Пустой блок — явная
// пометка «первый шаг», чтобы роль не гадала, потеряли ли данные.

import db from "../db.js";
import { roleTitle } from "../roleRouting.js";
import { latestSlotSnapshot } from "./slotWorkSnapshot.js";
import { latestStepOutcome, type StepOutcomeStatus } from "./stepOutcome.js";

/** Жёсткий потолок самого блока (постановка: "до ~1500 знаков"). */
export const TASK_HISTORY_BLOCK_MAX = 1_500;
const STEP_MAX = 8;
const SNAPSHOT_MAX = 5;
const VERDICT_MAX = 3;
const OWNER_COMMENT_MAX = 2;
const RESULT_CLIP = 180;
const TEXT_CLIP = 200;

export type TaskHistory = {
  /** ok — есть что показать; empty — прошлых ходов по карточке не нашлось. */
  status: "ok" | "empty";
  /** Сколько предыдущих шагов/доработок попало в сводку. */
  past_steps: number;
  /** Готовый текст блока (≤ TASK_HISTORY_BLOCK_MAX). */
  block: string;
};

function one(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function clip(text: unknown, max = TEXT_CLIP): string {
  const flat = one(text);
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function roleNameOf(roleKey: string | null | undefined): string {
  const key = one(roleKey);
  return key ? roleTitle(key) : "роль не указана";
}

/** Коммит, если роль явно написала его в результате или доказательствах. */
function commitOf(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = /(?:commit|коммит|sha)\s*[:#]?\s*([0-9a-f]{7,40})\b/i.exec(text);
    if (match) return match[1];
  }
  return null;
}

type StepRow = {
  id: string;
  title: string;
  done: number;
  plan_node_key: string | null;
  result: string | null;
  role_key: string | null;
};

type ArtifactRow = { artifact_key: string; version_no: number; note_id: string | null };

/** Чем кончился запуск шага — короткой строкой в сводку следующих шагов. */
const OUTCOME_RU: Record<StepOutcomeStatus, string> = {
  submitted: "сдан",
  blocked: "заблокирован",
  failed: "сбой",
  continued: "продолжен",
  interrupted: "прерван",
};

/** Исходы запусков прошлых шагов (MAK-96): следующий шаг видит не только
 *  результат, но и код причины, если шаг не сдался. Берём ВСЕ шаги карточки,
 *  а не только сдавшиеся: упавший шаг часто не имеет ни result, ни done.
 */
function stepOutcomeLines(taskId: string, subtaskId: string | null): string[] {
  const slots = db
    .prepare(
      `SELECT s.id, s.title, s.plan_node_key
         FROM subtasks s
        WHERE s.task_id = ? AND (? IS NULL OR s.id <> ?)
     ORDER BY s.rowid`,
    )
    .all(taskId, subtaskId, subtaskId) as Array<{ id: string; title: string; plan_node_key: string | null }>;
  const lines: string[] = [];
  for (const slot of slots) {
    const outcome = latestStepOutcome(slot.id);
    if (!outcome) continue;
    const code = outcome.code ? ` ${outcome.code}` : "";
    const tail = clip(outcome.message ?? "", RESULT_CLIP);
    lines.push(
      `— ${OUTCOME_RU[outcome.outcome] ?? outcome.outcome}${code}: «${clip(slot.title, 60)}»${slot.plan_node_key ? ` (${slot.plan_node_key})` : ""}${tail ? ` — ${tail}` : ""}`,
    );
    if (lines.length >= STEP_MAX) break;
  }
  return lines;
}

/** Ссылка на результат шага: артефакт версии (документ) или коммит. */
function stepLink(step: StepRow): string | null {
  const artifact = db
    .prepare(
      "SELECT artifact_key, version_no, note_id FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1",
    )
    .get(step.id) as ArtifactRow | undefined;
  const parts: string[] = [];
  if (artifact) parts.push(`артефакт ${artifact.artifact_key} v${artifact.version_no}`);
  if (artifact?.note_id) parts.push(`документ ${artifact.note_id}`);
  const commit = commitOf(step.result);
  if (commit) parts.push(`коммит ${commit}`);
  return parts.length ? parts.join(", ") : null;
}

/** Предыдущие шаги плана и доработки этого же карточки. */
function previousSteps(taskId: string, subtaskId: string | null): StepRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.done, s.plan_node_key, s.result, u.role_key
         FROM subtasks s
    LEFT JOIN users u ON u.id = s.agent_id
        WHERE s.task_id = ?
          AND (? IS NULL OR s.id <> ?)
          AND (s.done = 1 OR trim(COALESCE(s.result, '')) <> '')
     ORDER BY s.rowid
        LIMIT ?`,
    )
    .all(taskId, subtaskId, subtaskId, STEP_MAX) as StepRow[];
  return rows;
}

/** Последние снимки слотов карточки — по строке на слот. */
function snapshotLines(taskId: string, subtaskId: string | null): string[] {
  const slots = db
    .prepare(
      `SELECT s.id, s.title, s.plan_node_key, u.role_key
         FROM subtasks s
    LEFT JOIN users u ON u.id = s.agent_id
        WHERE s.task_id = ? AND (? IS NULL OR s.id <> ?)
     ORDER BY s.rowid
        LIMIT ?`,
    )
    .all(taskId, subtaskId, subtaskId, STEP_MAX + SNAPSHOT_MAX) as Array<{
    id: string;
    title: string;
    plan_node_key: string | null;
    role_key: string | null;
  }>;
  const lines: string[] = [];
  for (const slot of slots) {
    const snapshot = latestSlotSnapshot(slot.id);
    if (!snapshot) continue;
    const done = clip(snapshot.done_summary ?? snapshot.last_action ?? "—", RESULT_CLIP);
    const next = clip(snapshot.next_step ?? snapshot.left_summary ?? "—", RESULT_CLIP);
    lines.push(
      `— [${roleNameOf(slot.role_key)}] «${clip(slot.title, 60)}»${slot.plan_node_key ? ` (${slot.plan_node_key})` : ""}: сделано: ${done}; дальше: ${next}`,
    );
    if (lines.length >= SNAPSHOT_MAX) break;
  }
  return lines;
}

type CommentRow = { id: string; text: string; role_key?: string | null; author?: string | null };

/** Вердикты и дефекты QA/Критика по карточке (суть + id комментария). */
function verdictLines(taskId: string): string[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.text, u.role_key, u.name AS author
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.task_id = ?
          AND u.role_key IN ('qa', 'critic_verifier')
          AND c.text NOT LIKE 'Материал для работы собран%'
     ORDER BY c.created_at DESC, c.rowid DESC
        LIMIT ?`,
    )
    .all(taskId, VERDICT_MAX) as CommentRow[];
  return rows
    .reverse()
    .map((row) => `— [${roleNameOf(row.role_key)}] ${clip(row.text, TEXT_CLIP)} (комментарий ${row.id})`);
}

/** Последние комментарии владельца к карточке. */
function ownerCommentLines(taskId: string): string[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.text, u.name AS author
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.task_id = ? AND u.role = 'owner'
     ORDER BY c.created_at DESC, c.rowid DESC
        LIMIT ?`,
    )
    .all(taskId, OWNER_COMMENT_MAX) as CommentRow[];
  return rows
    .reverse()
    .map((row) => `— ${clip(row.text, TEXT_CLIP)} (комментарий ${row.id})`);
}

/**
 * Собрать блок «Что уже было по этой карточке». Никаких вызовов модели —
 * только чтение базы; пусто — честная пометка «первый шаг».
 */
export function buildTaskHistory(input: { taskId: string; subtaskId?: string | null }): TaskHistory {
  const taskId = input.taskId;
  const subtaskId = input.subtaskId ?? null;
  try {
    const steps = previousSteps(taskId, subtaskId);
    const snapshots = snapshotLines(taskId, subtaskId);
    const outcomes = stepOutcomeLines(taskId, subtaskId);
    const verdicts = verdictLines(taskId);
    const ownerComments = ownerCommentLines(taskId);

    if (!steps.length && !snapshots.length && !outcomes.length && !verdicts.length && !ownerComments.length) {
      return {
        status: "empty",
        past_steps: 0,
        block: [
          "── Что уже было по этой карточке ──",
          "Первый шаг по этой карточке: прошлых ходов нет.",
          "Прочитай это, но не пересказывай.",
        ].join("\n"),
      };
    }

    const lines: string[] = [
      "── Что уже было по этой карточке ──",
      `Прошлые шаги: ${steps.length}. Прочитай это, но не пересказывай — ссылки на документы важнее пересказа.`,
    ];
    if (steps.length) {
      lines.push("Шаги до текущего:");
      for (const step of steps) {
        const link = stepLink(step);
        lines.push(
          `— [${roleNameOf(step.role_key)}] «${clip(step.title, 60)}»${step.plan_node_key ? ` (${step.plan_node_key})` : ""}: ${clip(step.result, RESULT_CLIP) || "(результат не записан)"}${link ? ` — ${link}` : ""}`,
        );
      }
    }
    if (snapshots.length) {
      lines.push("Снимки этапов:");
      lines.push(...snapshots);
    }
    if (outcomes.length) {
      lines.push("Исходы запусков шагов:");
      lines.push(...outcomes);
    }
    if (verdicts.length) {
      lines.push("Вердикты и дефекты (QA/Критик):");
      lines.push(...verdicts);
    }
    if (ownerComments.length) {
      lines.push("Последние комментарии владельца:");
      lines.push(...ownerComments);
    }

    // Потолок: роли нужна короткая сводка, а не второй лог карточки.
    const block = lines.join("\n");
    const bounded =
      block.length <= TASK_HISTORY_BLOCK_MAX
        ? block
        : `${block.slice(0, TASK_HISTORY_BLOCK_MAX - 20).trimEnd()}… (сокращено)`;

    return { status: "ok", past_steps: steps.length, block: bounded };
  } catch {
    // Сводка не должна срывать запуск: нет данных — пусть роль начнёт как
    // раньше, без блока прошлого.
    return {
      status: "empty",
      past_steps: 0,
      block: "── Что уже было по этой карточке ──\nСводку собрать не удалось; работай по карточке.",
    };
  }
}
