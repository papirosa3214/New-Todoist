// Событие «шаг брошен» с хвостом журнала и снимком git рабочей копии
// (MAK-97, пункт 4 плана «Коммуникация агентов», 06.10.2026).
//
// Образец — `tools/async_delegation_recovery_hints.py` Гермеса: когда шаг
// умер или завис, событие несёт не только «исход неизвестен», но и последние
// строки журнала хода и однострочный снимок git, чтобы получатель (сервер, а
// через него оркестратор) сразу видел, где шаг остановился, и не открывал
// файлы вручную. Дополняет MAK-94 (сторож зависших шагов и восстановление
// после рестарта), не повторяет его.
//
// Всё здесь best-effort и ограничено: нет файла, cwd не git-репозиторий,
// git подвис — событие всё равно записывается, просто без этой части.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { slotSessionDirectory } from "./slotSession.js";

export const ABANDONED_STEP_KIND = "step_abandoned";

/** Хвост журнала: 20 строк, не больше 2000 знаков — как у Гермеса. */
export const ABANDONED_TAIL_LINES = 20;
export const ABANDONED_TAIL_CHARS = 2_000;
const GIT_TIMEOUT_MS = 5_000;

/** Последние `lines` строк (не длиннее `chars`); null — если текста нет. */
export function tailOfText(text: string | null | undefined, lines = ABANDONED_TAIL_LINES, chars = ABANDONED_TAIL_CHARS): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  let tail = text.split(/\r?\n/).slice(-lines).join("\n").trim();
  if (!tail) return null;
  if (tail.length > chars) tail = "…" + tail.slice(-chars);
  return tail;
}

/** Хвост файла журнала; читаем с конца, а не весь файл. */
export function transcriptTail(file: string, lines = ABANDONED_TAIL_LINES, chars = ABANDONED_TAIL_CHARS): string | null {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - chars * 4);
    const fd = fs.openSync(file, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return tailOfText(buffer.toString("utf8"), lines, chars);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Однострочный снимок git рабочей копии: «ветка @ коммит (N несохранённых файлов)». */
export function gitStateHint(cwd: string | null | undefined): string | null {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const run = (args: string[]): string | null => {
    try {
      const out = spawnSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.status === 0 && typeof out.stdout === "string" ? out.stdout : null;
    } catch {
      return null;
    }
  };
  const head = run(["log", "-1", "--format=%h %s"]);
  if (head === null) return null;
  const branch = (run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "?").trim();
  const status = run(["status", "--porcelain"]);
  const dirty = status === null ? "?" : String(status.split("\n").filter((line) => line.trim()).length);
  return `${branch} @ ${head.trim()} (${dirty} несохранённых файлов)`;
}

/** Рабочий каталог шага — из сохранённой сессии слота; null, если неизвестен. */
export function stepCwd(subtaskId: string | null | undefined): string | null {
  if (!subtaskId) return null;
  try {
    const row = db.prepare("SELECT cwd FROM slot_sessions WHERE subtask_id = ?").get(subtaskId) as { cwd?: string | null } | undefined;
    return row?.cwd ?? null;
  } catch {
    return null;
  }
}

/** Хвост журнала хода шага: свежий `.jsonl` в каталоге сессии слота. */
export function latestJournalTail(taskId: string, role: string, subtaskId: string): string | null {
  try {
    const dir = slotSessionDirectory(taskId, role, subtaskId);
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length === 0) return null;
    return transcriptTail(files[0]);
  } catch {
    return null;
  }
}

export type AbandonedStep = {
  reason: string;
  journal_tail: string | null;
  git_snapshot: string | null;
  subtask_id: string | null;
  slot_key: string | null;
  role: string | null;
  at: string;
};

export type AbandonedStepInput = {
  taskId: string;
  subtaskId?: string | null;
  role?: string | null;
  reason: string;
};

function slotKeyOf(subtaskId: string | null | undefined): string | null {
  if (!subtaskId) return null;
  try {
    const row = db.prepare("SELECT plan_node_key FROM subtasks WHERE id = ?").get(subtaskId) as { plan_node_key?: string | null } | undefined;
    return row?.plan_node_key ?? null;
  } catch {
    return null;
  }
}

/** Собрать хвост журнала и снимок git, не записывая событие. */
export function buildAbandonedStepHints(input: AbandonedStepInput): { journal_tail: string | null; git_snapshot: string | null } {
  const cwd = stepCwd(input.subtaskId ?? null);
  return {
    journal_tail: input.subtaskId && input.role
      ? latestJournalTail(input.taskId, input.role, input.subtaskId)
      : null,
    git_snapshot: gitStateHint(cwd),
  };
}

/**
 * Записать событие «шаг брошен» в журнал карточки. Не бросает: сбой сбора
 * подсказок не должен валить путь, на котором и так случился сбой.
 */
export function logStepAbandoned(input: AbandonedStepInput): AbandonedStep | null {
  try {
    const hints = buildAbandonedStepHints(input);
    const event: AbandonedStep = {
      reason: input.reason.slice(0, 500),
      journal_tail: hints.journal_tail,
      git_snapshot: hints.git_snapshot,
      subtask_id: input.subtaskId ?? null,
      slot_key: slotKeyOf(input.subtaskId ?? null),
      role: input.role ?? null,
      at: new Date().toISOString(),
    };
    logEvent({
      taskId: input.taskId,
      actorId: null,
      kind: ABANDONED_STEP_KIND,
      field: event.slot_key ?? event.subtask_id,
      toValue: JSON.stringify(event),
    });
    return event;
  } catch (error) {
    console.warn("[abandonedStep] событие «шаг брошен» не записано:", error);
    return null;
  }
}
