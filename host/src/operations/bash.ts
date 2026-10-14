import { spawn } from "node:child_process";
import path from "node:path";
import { resolveCwd } from "../pathSafety.js";
import {
  BadArgsError,
  CancelledError,
  type Operation,
  optionalNumber,
  optionalString,
  requireString,
} from "./types.js";

/**
 * Что возвращается по операции bash. Сам вывод уходит потоком сообщениями
 * `chunk` — возвращать его ещё раз в `result` значило бы слать по сети два
 * мегабайта, которые шлюз уже получил. Роль собирает поток у себя.
 */
export interface BashResult {
  exitCode: number | null;
  signal: string | null;
  /** Вывод обрезан по 4 МБ, процесс убит. */
  truncated: boolean;
  /** Не уложился в таймаут, процесс убит. */
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

/** SIGTERM, затем SIGKILL: команда может игнорировать первый сигнал. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // Минус перед pid — вся группа процессов команды, а не только сам bash:
    // иначе xcodebuild пережил бы отмену и продолжал жечь CPU.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Процесса уже нет — это не ошибка отмены, а его результат.
    }
  }
}

export const bash: Operation = async (args, context) => {
  const command = requireString(args, "command");
  const cwd = resolveCwd(context.roots, optionalString(args, "cwd"));
  // Потолок жёсткий: роль не может выпросить себе лимит больше лимита хоста.
  const timeoutMs = Math.min(
    optionalNumber(args, "timeoutMs", context.limits.bashTimeoutMs, { min: 1 }),
    context.limits.bashTimeoutMs,
  );
  const limit = context.limits.bashOutputLimitBytes;
  const shell = optionalString(args, "shell") ?? process.env["SHELL"] ?? "/bin/bash";
  const startedAt = context.now();

  if (context.signal.aborted) throw new CancelledError();

  return new Promise<BashResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TASKFLOW_HOST: "1" },
      });
    } catch (error) {
      reject(new BadArgsError(`не запустилась оболочка ${shell}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5_000);
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5_000);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    /** Записывает кусок в поток и следит за потолком вывода. */
    const push = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > limit) {
        truncated = true;
        killGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 5_000);
      }
      // Последний кусок всё равно отдаём: обрыв по лимиту должен быть виден в потоке.
      if (text) context.emit(stream, text);
    };

    child.stdout?.on("data", (chunk: Buffer) => push("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => push("stderr", chunk));

    const finish = (result: BashResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      context.signal.removeEventListener("abort", onAbort);
      // Отмена — это «команда не доведена до конца», а не её результат: роль
      // должна увидеть отмену, как у любого прерванного инструмента, и не принять
      // убитый процесс за успешный. Таймаут и лимит вывода, наоборот, остаются
      // результатом: там видно, чем кончилось.
      if (result.cancelled) {
        reject(new CancelledError("команда отменена шлюзом"));
        return;
      }
      resolve(result);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      context.signal.removeEventListener("abort", onAbort);
      reject(new BadArgsError(`команда не запустилась в ${cwd}: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      finish({
        exitCode: code,
        signal: signal ?? null,
        truncated,
        timedOut,
        cancelled,
        durationMs: context.now() - startedAt,
        stdoutBytes,
        stderrBytes,
      });
    });
  });
};

/** Человеческое описание для описания возможностей хоста. */
export const bashDescription = `Запустить команду в ${path.sep === "/" ? "терминале" : "оболочке"} и отдать её вывод потоком. Возвращает код возврата и счётчики; сам вывод приходит сообщениями chunk.`;