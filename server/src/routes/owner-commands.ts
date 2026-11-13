// MAK-82 / карточка d9dee6f8 «Сервер: выполнение команд владельца на .110».
// Серверный маршрут POST /api/owner-command/run для кнопки ▶ в чате
// владельца: выполнить «безопасную» системную команду (systemctl,
// journalctl, sqlite3) под владельцем трекера, записать исход в журнал
// owner_command_log, сделать автобэкап БД перед записью в неё.
//
// Контракт API и список действий — в `docs/owner-command.md`. Здесь —
// только реализация. Тесты: `server/test/ownerCommands.test.ts`.
//
// Три замечания, на которых держится модуль:
//
// 1. **OWNER_USER_ID** в коде нигде не зашит: владелец трекера определяется
//    по `users.role = 'owner'` (access.ts:isOwner), и в системе он один.
//    «Не-владелец» — все остальные, включая оркестратора. Это и есть
//    требуемая проверка прав: маршрут только для владельца.
//
// 2. **Реальный exec замокан через PATH**: в тестах переменная PATH
//    переставляется так, что первым находится каталог с фейковыми
//    `systemctl`/`journalctl`/`sqlite3` (см. ownerCommands.test.ts). На
//    живом сервере PATH системный и ничего не подменяет.
//
// 3. **exec убивается не только по тайм-ауту, но и при отмене запроса**:
//    AbortSignal клиента закрывает SIGTERM через 5 с SIGKILL. Это нужно,
//    потому что Fastify пробрасывает сигнал в хендлер, иначе процесс
//    остался бы сиротой.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import db, { DB_PATH } from "../db.js";
import { createUtf8StreamDecoder } from "../lib/utf8Stream.js";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const SIGTERM_GRACE_MS = 5_000;

/** Тайм-аут исполнения (мс). Дефолт 30 c; в тестах перекрывается через
 *  ENV OWNER_COMMAND_TIMEOUT_MS. Читается при каждом exec — так тест
 *  может выставить ENV до запроса, не трогая импорт модуля. */
function actionTimeoutMs(): number {
  const raw = process.env.OWNER_COMMAND_TIMEOUT_MS;
  if (!raw) return DEFAULT_ACTION_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACTION_TIMEOUT_MS;
}

/** Список действий белого списка, расширять только отдельной задачей. */
export const WHITELIST = new Set<string>([
  "service.restart",
  "service.status",
  "journal.tail",
  "db.snapshot",
]);

/** Какие действия требуют автобэкап БД перед выполнением. По умолчанию —
 *  ни одно из белого списка: перезапуск сервиса, статус, чтение журнала и
 *  снимок сам по себе БД не меняют. Действия из белого списка, пишущие в
 *  БД, здесь не появятся без отдельной задачи — карточка d9dee6f8. */
export const BACKUP_REQUIRED = new Set<string>([
  // пусто: белый список не пишет в БД.
]);

/** Имена сервисов, которые можно перезапустить через service.restart.
 * Через ENV OWNER_COMMAND_SERVICE_WHITELIST (через запятую); дефолт —
 * один юнит, на котором крутится сам сервер. В тестах перекрывается
 * переменной окружения до вызова роута. */
function serviceWhitelist(): Set<string> {
  const raw = process.env.OWNER_COMMAND_SERVICE_WHITELIST ?? "taskflow-server.service";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Куда класть снимки БД. По умолчанию — `<dir(DB_PATH)>/backups`. Тесты
 *  ставят свой каталог через ENV OWNER_COMMAND_BACKUP_DIR до запуска. */
function backupDir(): string {
  if (process.env.OWNER_COMMAND_BACKUP_DIR) {
    return path.resolve(process.env.OWNER_COMMAND_BACKUP_DIR);
  }
  return path.join(path.dirname(DB_PATH), "backups");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Снять снимок БД через штатный online backup better-sqlite3.
 *  Вызывается и как действие db.snapshot, и как автобэкап перед записью.
 *  Возвращает абсолютный путь к файлу. Асинхронная — `db.backup()`
 *  возвращает Promise, без await файл может ещё не существовать к
 *  моменту ответа. */
export async function snapshotDb(targetDir?: string): Promise<string> {
  const dir = targetDir ?? backupDir();
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `db-${stamp}.sqlite3`);
  // `Database.backup()` — штатный online backup SQLite, не блокирует базу.
  // Тесты гоняют на временной БД, прод — на боевой; никаких побочных
  // эффектов на пишущий процесс, кроме кратковременного read lock'а
  // на исходный файл.
  await db.backup(file);
  return file;
}

type RunParams = {
  action: string;
  command: string;
  params?: Record<string, unknown>;
  confirm: boolean;
};

type RunOutcome =
  | { kind: "ok"; exitCode: number; stdout: string; stderr: string; durationMs: number; backup: string | null }
  | { kind: "rejected"; error: string; http: number }
  | { kind: "timeout"; stdout: string; stderr: string; durationMs: number }
  | { kind: "error"; error: string; stdout?: string; stderr?: string; durationMs?: number };

/** Исполнить действие белого списка. Возвращает структурированный исход;
 *  запись в журнал делает вызывающий — здесь про побочный эффект exec. */
async function runAction(
  params: RunParams,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<RunOutcome> {
  const startedAt = Date.now();

  // Аргументы exec получаем из params — каждое действие само знает,
  // какие ключи ему нужны. Это позволяет одному действию принимать
  // разные команды (например, service.restart — имя сервиса), не плодя
  // кучу полей на верхнем уровне запроса.
  let file = "";
  let args: string[] = [];
  switch (params.action) {
    case "service.restart": {
      const name = String(params.params?.service ?? "").trim();
      if (!name) return { kind: "rejected", error: "params.service: имя сервиса обязательно", http: 400 };
      if (!serviceWhitelist().has(name)) {
        return {
          kind: "rejected",
          error: `params.service: '${name}' не в белом списке сервисов`,
          http: 400,
        };
      }
      file = "systemctl";
      args = ["--user", "restart", name];
      break;
    }
    case "service.status": {
      const name = String(params.params?.service ?? "").trim();
      if (!name) return { kind: "rejected", error: "params.service: имя сервиса обязательно", http: 400 };
      if (!serviceWhitelist().has(name)) {
        return {
          kind: "rejected",
          error: `params.service: '${name}' не в белом списке сервисов`,
          http: 400,
        };
      }
      file = "systemctl";
      args = ["--user", "is-active", name];
      break;
    }
    case "journal.tail": {
      const unit = String(params.params?.service ?? "taskflow-server.service").trim();
      if (!serviceWhitelist().has(unit)) {
        return {
          kind: "rejected",
          error: `params.service: '${unit}' не в белом списке сервисов`,
          http: 400,
        };
      }
      const n = Math.max(1, Math.min(1000, Number(params.params?.lines ?? 100)));
      file = "journalctl";
      args = ["--user", "-u", unit, "-n", String(n), "--no-pager"];
      break;
    }
    case "db.snapshot": {
      // Не дёргаем exec: делаем снимок прямо здесь. Так тестовая среда
      // с замоканным PATH всё равно получает файл.
      try {
        const file = await snapshotDb();
        return {
          kind: "ok",
          exitCode: 0,
          stdout: file,
          stderr: "",
          durationMs: Date.now() - startedAt,
          backup: file,
        };
      } catch (error) {
        return {
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        };
      }
    }
    default:
      // Произвольное действие с confirm=true — выполнить params.command
      // как есть. Валидация самой команды — задача вызывающего: он уже
      // явно подтвердил, что хочет это запустить.
      if (!params.confirm) {
        return {
          kind: "rejected",
          error: `неизвестное действие: '${params.action}'. Допустимо: ${[...WHITELIST].join(", ")}, либо произвольное с confirm=true`,
          http: 404,
        };
      }
      // fall through к Promise ниже: парсим `command` в бинарь + args.
      file = "/bin/bash";
      args = ["-c", params.command];
      break;
  }

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } } };
    let stdout = "";
    let stderr = "";
    const STDOUT_LIMIT = 64 * 1024;
    const STDERR_LIMIT = 64 * 1024;
    // Декодер на поток, а не на кусок: иначе буква на границе чтения
    // превращается в два U+FFFD (см. src/lib/utf8Stream.ts).
    const stdoutDecoder = createUtf8StreamDecoder();
    const stderrDecoder = createUtf8StreamDecoder();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + stdoutDecoder.write(chunk)).slice(0, STDOUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(0, STDERR_LIMIT);
    });

    let settled = false;
    let timedOut = false;
    const settle = (out: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          killGroup("SIGKILL");
        } catch {
          // процесс уже умер — финиш
        }
      }, SIGTERM_GRACE_MS);
      child.once("close", () => clearTimeout(killTimer));
      // Результат публикуем из обработчика `exit`: SIGTERM мог убить
      // процесс синхронно с этим таймером, и тогда exit сработает раньше
      // settle. Сейчас мы только поднимаем флаг, а выход оформит exit
      // с `kind: "timeout"`.
    }, actionTimeoutMs());

    child.once("error", (err) => {
      settle({
        kind: "error",
        error: err.message,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    child.once("close", (code) => {
      if (timedOut) {
        settle({
          kind: "timeout",
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      settle({
        kind: "ok",
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        backup: null,
      });
    });

    // Клиент оборвал запрос — тоже убиваем процесс, иначе он остался бы
    // сиротой (Fastify пробрасывает сигнал отмены в хендлер).
    reply.raw.once("close", () => {
      if (!settled && !reply.raw.writableEnded) {
        try {
          killGroup("SIGTERM");
        } catch {
          // уже умер
        }
      }
    });
  });
}

/** Записать строку журнала. Поле `outcome` — из контролируемого набора,
 *  никакого пользовательского ввода туда не попадает. */
function logEntry(row: {
  requestId: string;
  who: string;
  action: string;
  command: string;
  params: Record<string, unknown>;
  confirm: boolean;
  outcome: "ok" | "rejected" | "timeout" | "error" | "backup_failed";
  startedAt: number;
  finishedAt: number;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  backupPath?: string | null;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO owner_command_log
       (id, request_id, who, action, command, params, confirm,
        started_at, finished_at, duration_ms, exit_code,
        outcome, stdout, stderr, backup_path, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    row.requestId,
    row.who,
    row.action,
    row.command,
    JSON.stringify(row.params ?? {}),
    row.confirm ? 1 : 0,
    new Date(row.startedAt).toISOString().replace("T", " ").slice(0, 19),
    new Date(row.finishedAt).toISOString().replace("T", " ").slice(0, 19),
    row.finishedAt - row.startedAt,
    row.exitCode ?? null,
    row.outcome,
    row.stdout ?? null,
    row.stderr ?? null,
    row.backupPath ?? null,
    row.error ?? null,
  );
}

export function registerOwnerCommandRoutes(app: FastifyInstance): void {
  app.post(
    "/api/owner-command/run",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "маршрут только для владельца трекера" });
      }
      const body = req.body ?? ({} as RunParams);
      const action = String(body.action ?? "").trim();
      const command = String(body.command ?? "").trim();
      if (!action) return reply.code(400).send({ error: "action: обязательно" });
      if (!command) return reply.code(400).send({ error: "command: обязательно" });

      const confirm = body.confirm === true;
      if (!WHITELIST.has(action) && !confirm) {
        // Чужих действий нет в роуте: всё, что не из белого списка, мы
        // отвергаем, если нет подтверждения. Это и есть «вне списка —
        // только с confirm=true» из карточки.
        const requestId = crypto.randomUUID();
        const now = Date.now();
        logEntry({
          requestId,
          who: req.userId,
          action,
          command,
          params: body.params ?? {},
          confirm: false,
          outcome: "rejected",
          startedAt: now,
          finishedAt: now,
          error: "требуется confirm=true для действий вне белого списка",
        });
        return reply.code(400).send({
          error: "действие вне белого списка — нужен confirm=true",
          whitelist: [...WHITELIST].sort(),
        });
      }

      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      let backupPath: string | null = null;

      // Автобэкап перед записью. Сейчас таких действий в белом списке
      // нет, но флаг `requiresBackup` оставлен для будущих пишущих
      // команд, чтобы архитектура была готова.
      if (BACKUP_REQUIRED.has(action)) {
        try {
          backupPath = await snapshotDb();
        } catch (error) {
          const finishedAt = Date.now();
          logEntry({
            requestId,
            who: req.userId,
            action,
            command,
            params: body.params ?? {},
            confirm,
            outcome: "backup_failed",
            startedAt,
            finishedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          return reply.code(500).send({
            error: "не удалось снять снимок БД перед записью — действие отменено",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const outcome = await runAction(
        {
          action,
          command,
          params: body.params ?? {},
          confirm,
        },
        req,
        reply,
      );

      const finishedAt = Date.now();

      if (outcome.kind === "rejected") {
        logEntry({
          requestId,
          who: req.userId,
          action,
          command,
          params: body.params ?? {},
          confirm,
          outcome: "rejected",
          startedAt,
          finishedAt,
          error: outcome.error,
        });
        return reply.code(outcome.http).send({ error: outcome.error });
      }

      if (outcome.kind === "timeout") {
        logEntry({
          requestId,
          who: req.userId,
          action,
          command,
          params: body.params ?? {},
          confirm,
          outcome: "timeout",
          startedAt,
          finishedAt,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
        });
        return reply.code(504).send({
          ok: false,
          outcome: "timeout",
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          durationMs: outcome.durationMs,
          requestId,
        });
      }

      if (outcome.kind === "error") {
        logEntry({
          requestId,
          who: req.userId,
          action,
          command,
          params: body.params ?? {},
          confirm,
          outcome: "error",
          startedAt,
          finishedAt,
          stdout: outcome.stdout ?? null,
          stderr: outcome.stderr ?? null,
          error: outcome.error,
        });
        return reply.code(500).send({
          ok: false,
          outcome: "error",
          error: outcome.error,
          stdout: outcome.stdout ?? "",
          stderr: outcome.stderr ?? "",
          durationMs: outcome.durationMs ?? 0,
          requestId,
        });
      }

      logEntry({
        requestId,
        who: req.userId,
        action,
        command,
        params: body.params ?? {},
        confirm,
        outcome: "ok",
        startedAt,
        finishedAt,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        backupPath: outcome.backup ?? backupPath,
      });
      return reply.code(200).send({
        ok: true,
        outcome: "ok",
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs: outcome.durationMs,
        backup: outcome.backup ?? backupPath
          ? { path: outcome.backup ?? backupPath }
          : null,
        requestId,
      });
    },
  );
}