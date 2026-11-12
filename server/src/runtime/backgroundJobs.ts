/**
 * Фоновые команды ролей.
 *
 * Решение владельца 08.11.2026 (дизайн docs/2026-11-08-role-background-jobs.md):
 * длинная команда (сборка, тесты, выкладка) не держит ход роли. Реестр живёт в
 * сервере поверх уже существующего вызова хоста: runOperation умеет отдавать
 * поток кадрами, поэтому хост на маке про фон ничего не знает и не меняется.
 *
 * Что здесь важно и почему:
 *  - сигнал хода не пробрасывается: отмена хода не должна убивать команду;
 *  - обрыв связи, таймаут и остановка — это состояния задачи (lost/timeout/
 *    stopped), а не исключения: роль должна увидеть их как данные;
 *  - в одном рабочем дереве идёт одна команда: две сборки в одном дереве
 *    ломают друг друга молча. Вторая встаёт в очередь и стартует после первой;
 *  - реестр в памяти: после перезапуска сервера задача не найдена, и роли так
 *    и говорится — вместо тишины.
 */

import crypto from "node:crypto";
import { roleBashKillError } from "./roleBashGuard.js";

export type BackgroundJobState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "stopped"
  | "lost";

export type BackgroundRunnerInput = {
  machineId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Отмена по stop: шлюз отправит хосту op_cancel и reject'ит вызов. */
  signal: AbortSignal;
  onChunk: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
};

export type BackgroundRunResult = {
  ok?: boolean;
  exitCode?: number | null;
  error?: unknown;
};

export type BackgroundRunner = (input: BackgroundRunnerInput) => Promise<BackgroundRunResult>;

export type BackgroundStartInput = {
  role: string;
  /** Ключ рабочего дерева: у карточки он равен taskId (см. roleHostAccess). */
  worktreeKey: string;
  machineId: string;
  cwd: string;
  command: string;
  timeoutMs: number;
  taskId?: string;
  chatId?: string;
};

export type BackgroundJob = {
  id: string;
  role: string;
  taskId?: string;
  chatId?: string;
  worktreeKey: string;
  machineId: string;
  cwd: string;
  command: string;
  state: BackgroundJobState;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  bytes: number;
  truncated: boolean;
  tail: string;
};

type Job = BackgroundJob & {
  buffer: string;
  cancelRequested: boolean;
  controller: AbortController | null;
  /** Предел времени самой команды (мс): шлюз получает свой, чуть больше. */
  commandTimeoutMs: number;
};

type Options = {
  run: BackgroundRunner;
  /** Отметка активности хода: пока задача идёт, роль не считается молчащей. */
  onActivity?: (job: BackgroundJob) => void;
  /** Завершение задачи: итог в переписку и пробуждение роли. */
  onStateChange?: (job: BackgroundJob) => void;
  now?: () => number;
  maxOutputBytes?: number;
  maxJobsPerRole?: number;
  maxJobsPerTask?: number;
  retentionMs?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_JOBS_PER_ROLE = 3;
const DEFAULT_MAX_JOBS_PER_TASK = 6;
const DEFAULT_RETENTION_MS = 60 * 60_000;
const TAIL_BYTES = 2 * 1024;
const OUTPUT_PAGE_BYTES = 64 * 1024;

const ACTIVE: BackgroundJobState[] = ["queued", "running"];

/** Заголовок команды в списке: полная строка в списке не нужна. */
const COMMAND_HEAD = 200;

/** Состояние задачи для человека — одно слово, которое роль вставит в ответ. */
export const BACKGROUND_STATE_TITLES: Record<BackgroundJobState, string> = {
  queued: "в очереди",
  running: "идёт",
  done: "готово",
  failed: "ошибка",
  timeout: "таймаут",
  stopped: "остановлено",
  lost: "потеряна",
};

export function createBackgroundJobs(options: Options) {
  const now = options.now ?? (() => Date.now());
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxJobsPerRole = options.maxJobsPerRole ?? DEFAULT_MAX_JOBS_PER_ROLE;
  const maxJobsPerTask = options.maxJobsPerTask ?? DEFAULT_MAX_JOBS_PER_TASK;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;

  const jobs = new Map<string, Job>();

  const activeOf = (predicate: (job: Job) => boolean) =>
    [...jobs.values()].filter((job) => ACTIVE.includes(job.state) && predicate(job));

  function view(job: Job): BackgroundJob {
    return {
      id: job.id,
      role: job.role,
      taskId: job.taskId,
      chatId: job.chatId,
      worktreeKey: job.worktreeKey,
      machineId: job.machineId,
      cwd: job.cwd,
      command: job.command.slice(0, COMMAND_HEAD),
      state: job.state,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      bytes: job.bytes,
      truncated: job.truncated,
      tail: job.tail,
    };
  }

  function tailOf(buffer: string, bytes = TAIL_BYTES): string {
    if (Buffer.byteLength(buffer, "utf8") <= bytes) return buffer;
    const raw = Buffer.from(buffer, "utf8");
    let start = raw.length - bytes;
    // Не рвать многобайтовый символ: отступаем до границы кодовой точки.
    while (start > 0 && (raw[start] & 0xc0) === 0x80) start -= 1;
    return raw.subarray(start).toString("utf8");
  }

  function append(job: Job, data: string) {
    if (job.truncated) return;
    const rest = maxOutputBytes - job.bytes;
    if (rest <= 0) {
      job.truncated = true;
      return;
    }
    let piece = data;
    if (Buffer.byteLength(piece, "utf8") > rest) {
      const raw = Buffer.from(piece, "utf8");
      let end = rest;
      while (end > 0 && (raw[end] & 0xc0) === 0x80) end -= 1;
      piece = raw.subarray(0, end).toString("utf8");
      job.truncated = true;
    }
    if (!piece) return;
    job.buffer += piece;
    job.bytes += Buffer.byteLength(piece, "utf8");
    job.tail = tailOf(job.buffer);
  }

  function nextInQueue(worktreeKey: string): Job | undefined {
    return [...jobs.values()].find((job) => job.worktreeKey === worktreeKey && job.state === "queued");
  }

  function finish(job: Job, state: BackgroundJobState, exitCode: number | null, note?: string) {
    if (job.state !== "running") return; // уже остановлена — второй раз не завершаем
    if (note) append(job, note);
    job.state = state;
    job.exitCode = exitCode;
    job.finishedAt = now();
    job.durationMs = job.finishedAt - job.startedAt;
    job.controller = null;
    options.onStateChange?.(view(job));
    const next = nextInQueue(job.worktreeKey);
    if (next) startRun(next);
  }

  function startRun(job: Job) {
    job.state = "running";
    job.startedAt = now();
    job.controller = new AbortController();
    options.onActivity?.(view(job));
    options.onStateChange?.(view(job));
    const run = options.run;
    void run({
      machineId: job.machineId,
      command: job.command,
      cwd: job.cwd,
      timeoutMs: job.commandTimeoutMs,
      signal: job.controller.signal,
      onChunk: (chunk) => {
        if (job.state !== "running") return;
        append(job, chunk.data);
        options.onActivity?.(view(job));
      },
    })
      .then((result) => {
        const code = typeof result.exitCode === "number" ? result.exitCode : result.ok === false ? null : 0;
        if (result.ok === false) {
          finish(job, "failed", code, result.error ? `\n[хост] ${String(result.error)}\n` : undefined);
          return;
        }
        finish(job, code === 0 ? "done" : "failed", code);
      })
      .catch((error: unknown) => {
        if (job.cancelRequested) return; // состояние stopped уже выставлено в stop
        const text = errorText(error);
        if (/не ответил за/.test(text)) {
          finish(job, "timeout", null, `\n[хост] ${text}\n`);
          return;
        }
        if (/связь с машиной потеряна|офлайн|оффлайн/.test(text)) {
          finish(job, "lost", null, `\n[хост] ${text}\n`);
          return;
        }
        finish(job, "failed", null, `\n[хост] ${text}\n`);
      });
  }

  function start(input: BackgroundStartInput): BackgroundJob {
    if (activeOf((job) => job.role === input.role).length >= maxJobsPerRole) {
      throw new Error(
        `У роли уже ${maxJobsPerRole} фоновые задачи — дождись завершения или останови одну: taskflow_host_bg action=list`,
      );
    }
    if (input.taskId && activeOf((job) => job.taskId === input.taskId).length >= maxJobsPerTask) {
      throw new Error(`У карточки уже ${maxJobsPerTask} фоновых задач — дождись завершения или останови лишние`);
    }
    const job: Job = {
      id: `bg_${crypto.randomUUID()}`,
      role: input.role,
      taskId: input.taskId,
      chatId: input.chatId,
      worktreeKey: input.worktreeKey,
      machineId: input.machineId,
      cwd: input.cwd,
      command: input.command,
      state: "queued",
      exitCode: null,
      startedAt: 0,
      finishedAt: null,
      durationMs: null,
      bytes: 0,
      truncated: false,
      tail: "",
      buffer: "",
      cancelRequested: false,
      controller: null,
      commandTimeoutMs: input.timeoutMs,
    };
    jobs.set(job.id, job);
    // Свободное дерево — запускаем сразу; занятое — задача ждёт своей очереди.
    const busy = job.worktreeKey
      ? [...jobs.values()].some((other) => other !== job && other.worktreeKey === job.worktreeKey && other.state === "running")
      : false;
    if (busy) {
      options.onStateChange?.(view(job));
    } else {
      startRun(job);
    }
    return view(job);
  }

  function require(jobId: string): Job {
    const job = jobs.get(jobId);
    if (!job) {
      throw new Error(
        `Фоновая задача ${jobId} не найдена: сервер перезапускался или задача уже убрана. Проверь вывод команды в рабочем дереве и перезапусти её`,
      );
    }
    return job;
  }

  function status(jobId: string): BackgroundJob {
    return view(require(jobId));
  }

  function output(jobId: string, offset = 0): { data: string; nextOffset: number; truncated: boolean } {
    const job = require(jobId);
    const raw = Buffer.from(job.buffer, "utf8");
    const from = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, raw.length));
    let end = Math.min(raw.length, from + OUTPUT_PAGE_BYTES);
    while (end < raw.length && (raw[end] & 0xc0) === 0x80) end += 1;
    const data = raw.subarray(from, end).toString("utf8");
    return { data, nextOffset: end, truncated: job.truncated };
  }

  function stop(jobId: string): BackgroundJob {
    const job = require(jobId);
    if (!ACTIVE.includes(job.state)) return view(job);
    job.cancelRequested = true;
    job.state = "stopped";
    job.finishedAt = now();
    job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : 0;
    const controller = job.controller;
    job.controller = null;
    options.onStateChange?.(view(job));
    controller?.abort();
    const next = nextInQueue(job.worktreeKey);
    if (next) startRun(next);
    return view(job);
  }

  function list(input: { role: string }): BackgroundJob[] {
    return [...jobs.values()]
      .filter((job) => job.role === input.role)
      .map(view)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Уборка завершённых задач: память не должна расти бесконечно. */
  function sweep(): void {
    const edge = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (!ACTIVE.includes(job.state) && job.finishedAt !== null && job.finishedAt < edge) jobs.delete(id);
    }
  }

  /** Деревья, в которых сейчас идёт команда: для отказа «дерево занято». */
  function busyWorktrees(): string[] {
    return [...new Set([...jobs.values()].filter((job) => job.state === "running").map((job) => job.worktreeKey))];
  }

  return { start, status, output, stop, list, sweep, busyWorktrees };
}

export type BackgroundJobs = ReturnType<typeof createBackgroundJobs>;

/**
 * Проверка запуска: сторож опасных остановок (тот же, что у bash роли) и
 * рабочая папка внутри разрешённых корней машины. Возвращает текст отказа или
 * null, если команду можно запускать.
 */
export function backgroundStartError(input: {
  command: unknown;
  cwd: unknown;
  allowedRoots?: unknown;
}): string | null {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return "Пустая команда: передай command — что запустить";
  const kill = roleBashKillError(command);
  if (kill) return kill;
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd && !cwd.startsWith("/")) return `Рабочая папка должна быть абсолютным путём: ${cwd}`;
  const roots = Array.isArray(input.allowedRoots)
    ? input.allowedRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
    : [];
  if (cwd && roots.length) {
    const inside = roots.some((root) => {
      const base = root.replace(/\/+$/, "");
      return cwd === base || cwd.startsWith(base + "/");
    });
    if (!inside) return `Рабочая папка выходит за разрешённые корни машины: ${cwd}`;
  }
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
