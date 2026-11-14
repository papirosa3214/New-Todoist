/**
 * To Do List Pi в сессиях владельца — чтение готового списка.
 *
 * `GET /api/sessions/:id/todos` → `{ todos: { sessionId, available, entryId,
 * updatedAt, nextId, tasks, counts } }` (форма и разбор —
 * `runtime/ownerSessionTodos.ts`).
 *
 * Почему отдельным маршрутом, а не полем снимка: снимок сессии и лента
 * событий (`routes/owner-sessions.ts`, `runtime/ownerSessionEvents.ts`,
 * `runtime/ownerSessionRuntime.ts`) в момент этой правки заняты другой
 * работой по курсору и снимку. Поэтому здесь **только чтение файла сессии**:
 *
 *   id сессии → файл `.jsonl` в каталоге сессий владельца → `SessionManager.open`
 *   (read-only) → ветка → `sessionTodosFromEntries`.
 *
 * Ничего не пишется: ни в БД, ни в транскрипт, ни в состояние расширения.
 * Второй `OwnerSessionRuntime` не создаётся — две копии рантайма означали бы
 * два независимых набора живых сессий на одних файлах.
 *
 * Файл при этом актуален: Pi пишет записи в транскрипт синхронно
 * (`docs/current/owner-session-snapshot-events.md`, «Что доказано про порядок
 * Pi»), поэтому результат инструмента `todo` уже в файле к моменту запроса.
 *
 * Живое обновление: результат `todo` приходит клиенту существующими
 * событиями сессии (`entry_appended` с записью, `tool_end`). Готовый
 * объединённый push (`todos` внутри события) — правка занятых файлов, её
 * точная потребность описана в `docs/current/pi-todo-list-sessions.md`,
 * раздел «Что нужно от занятых файлов».
 *
 * Права — те же, что у остальных сессий владельца: владелец или агент
 * сессий, иначе 403. Чужая/несуществующая сессия — 404, а не пустой список:
 * «нет файла» и «список пуст» клиент должен различать.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { authOrApiToken } from "../auth.js";
import { isOwner, isSessionAgent } from "../access.js";
import { sessionTodosFromEntries } from "../runtime/ownerSessionTodos.js";

export interface OwnerSessionTodosRouteDependencies {
  /** Каталог сессий владельца. По умолчанию — тот же, что у
   *  `routes/owner-sessions.ts` (productionDependencies): один каталог на всех. */
  sessionDir?: string;
  authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
  isOwner: (userId: string) => boolean;
  isSessionAgent?: (userId: string) => boolean;
}

/** Каталог сессий владельца — те же строки, что в `routes/owner-sessions.ts`.
 *  Разъедутся — маршрут честно ответит 404, а не отдаст пустой список. */
export function defaultOwnerSessionDir(): string {
  if (process.env.VITEST) return path.join(os.tmpdir(), `taskflow-owner-sessions-${process.pid}`);
  const runsRoot = process.env.TASKFLOW_RUNS_DIR ?? path.join(os.homedir(), ".local", "state", "taskflow-runs");
  return path.join(runsRoot, "owner-sessions");
}

const HEADER_SCAN_BYTES = 64 * 1024;

/** Файл сессии по её id: заголовок `.jsonl` — первая строка. */
export function findOwnerSessionFile(sessionDir: string, sessionId: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, name);
    const id = readSessionHeaderId(file);
    if (id === sessionId) return file;
  }
  return null;
}

function readSessionHeaderId(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, read).toString("utf8").split("\n")[0];
    if (!firstLine) return null;
    const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
    if (header?.type !== "session") return null;
    return typeof header.id === "string" ? header.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* закрытие не влияет на ответ */
      }
    }
  }
}

export function registerOwnerSessionTodosRoutes(
  app: FastifyInstance,
  dependencies: OwnerSessionTodosRouteDependencies = {
    authorize: authOrApiToken,
    isOwner,
    isSessionAgent,
  },
): void {
  const ownerOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    await dependencies.authorize(request, reply);
    if (reply.sent) return;
    const userId = (request as any).userId as string | undefined;
    if (!userId || !(dependencies.isOwner(userId) || dependencies.isSessionAgent?.(userId))) {
      return reply.code(403).send({ error: "owner_only" });
    }
  };

  app.get<{ Params: { id: string } }>("/api/sessions/:id/todos", { preHandler: ownerOnly }, async (request, reply) => {
    const sessionId = request.params.id;
    const file = findOwnerSessionFile(dependencies.sessionDir ?? defaultOwnerSessionDir(), sessionId);
    if (!file) return reply.code(404).send({ error: "session_not_found", sessionId });
    // open() — только чтение файла: миграции и перезапись транскрипта здесь не
    // происходят (флаг read-only в конструкторе SessionManager).
    const manager = SessionManager.open(file);
    return { todos: sessionTodosFromEntries(sessionId, manager.getBranch()) };
  });
}
