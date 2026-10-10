/**
 * API владельца для чтения и выгрузки серверного журнала событий
 * (карточка e87cd93f, шаг «Разработка API чтения и выгрузки диагностики»).
 *
 * Контракт (все эндпоинты — только владелец):
 *   GET /api/admin/server-events
 *       ?since=&until=&scope=&kind=&task_id=&subtask_id=&operation_id=
 *       &actor_id=&outcome=&message=&cursor=&limit=&order=
 *       → { events: ServerEventRow[], nextCursor, totalEstimate }
 *
 *   GET /api/admin/server-events/stats
 *       → { total, byScope, byOutcome, byKind, byKindOverflow, filters }
 *
 *   GET /api/admin/server-events/:id
 *       → ServerEventRow | 404
 *
 *   GET /api/admin/server-events/operation/:operationId
 *       → { events: ServerEventRow[], truncated: boolean }
 *
 *   GET /api/admin/server-events/export
 *       ?format=json|ndjson|gzip & ...фильтры те же...
 *       → файл с полным пакетом {settings, filters, events, server}
 *
 * Фильтры берём из query-string, валидируем без жёсткой проверки типов —
 * 400 бросаем только на заведомо битые значения (не-числовой limit,
 * неизвестный scope и т.п.). Невалидный ISO `since` не падает, а
 * молча игнорируется (SQLite сравнит строки, выдаст ноль строк).
 *
 * Права: `authOrApiToken + isOwner(req.userId)`. Журнал содержит
 * потенциально чувствительные данные (имена задач, контекст по
 * сотрудникам), поэтому роль агента и оркестратора не должны его
 * видеть — это владельческая зона.
 */
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { execFileSync } from "node:child_process";
import {
  type ServerEventFilters,
  SERVER_EVENT_SCOPES,
  SERVER_EVENT_OUTCOMES,
  SERVER_EVENTS_EXPORT_MAX_EVENTS,
  buildExportPayload,
  getOperationChain,
  getServerEventById,
  getServerEventStats,
  listServerEvents,
  serializeNdjson,
} from "../lib/serverEventsRead.js";
import {
  type ServerEventScope,
  type ServerEventOutcome,
} from "../lib/serverEvents.js";

function ownerOr403(req: any, reply: any): boolean {
  if (isOwner(req.userId)) return true;
  reply.code(403).send({ error: "доступно только владельцу" });
  return false;
}

const SCOPE_SET = new Set<string>(SERVER_EVENT_SCOPES);
const OUTCOME_SET = new Set<string>(SERVER_EVENT_OUTCOMES);

function asScopeList(raw: unknown): ServerEventScope[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const out: ServerEventScope[] = [];
  for (const s of list) {
    const v = String(s).trim();
    if (!v) continue;
    if (!SCOPE_SET.has(v)) {
      throw new Error(`unknown scope: ${v}`);
    }
    out.push(v as ServerEventScope);
  }
  return out;
}

function asOutcome(raw: unknown): ServerEventOutcome | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const v = String(raw).trim();
  if (!OUTCOME_SET.has(v)) throw new Error(`unknown outcome: ${v}`);
  return v as ServerEventOutcome;
}

function asInt(value: unknown, name: string, max: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} должно быть неотрицательным числом`);
  }
  return Math.min(Math.floor(n), max);
}

function readFilters(query: Record<string, unknown>): ServerEventFilters {
  const filters: ServerEventFilters = {};
  if (query.since !== undefined) filters.since = String(query.since);
  if (query.until !== undefined) filters.until = String(query.until);
  filters.scopes = asScopeList(query.scope);
  if (query.kind !== undefined && query.kind !== "") {
    filters.kind = String(query.kind);
    filters.kindExact = query.kind_exact === "1" || query.kindExact === "1";
  }
  if (query.task_id !== undefined && query.task_id !== "") {
    filters.taskId = String(query.task_id);
  }
  if (query.subtask_id !== undefined && query.subtask_id !== "") {
    filters.subtaskId = String(query.subtask_id);
  }
  if (query.operation_id !== undefined && query.operation_id !== "") {
    filters.operationId = String(query.operation_id);
  }
  if (query.actor_id !== undefined && query.actor_id !== "") {
    filters.actorId = String(query.actor_id);
  }
  filters.outcome = asOutcome(query.outcome);
  if (query.message !== undefined && query.message !== "") {
    filters.messageContains = String(query.message);
  }
  const limit = asInt(query.limit, "limit", 1000);
  if (limit !== null) filters.limit = limit;
  if (query.cursor !== undefined && query.cursor !== "") {
    filters.cursor = String(query.cursor);
  }
  filters.order = query.order === "asc" ? "asc" : "desc";
  return filters;
}

/**
 * Достать из репозитория текущий commit сервера — для контекста экспорта.
 * Если мы не в git (CI, распакованный tar) — null, и это не ошибка.
 */
function readServerCommit(): { commit: string | null; node: string } {
  let commit: string | null = null;
  try {
    const out = execFileSync(
      "git",
      ["-C", process.cwd(), "log", "-1", "--format=%H"],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    if (out) commit = out;
  } catch {
    commit = null;
  }
  return { commit, node: process.version };
}

export function registerServerEventsRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  /**
   * Список событий с фильтрами. Курсорная пагинация — клиент повторяет
   * запрос с тем же набором фильтров + cursor из прошлого ответа.
   */
  app.get(
    "/api/admin/server-events",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      try {
        const filters = readFilters(req.query ?? {});
        return listServerEvents(filters);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.get(
    "/api/admin/server-events/stats",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      try {
        const filters = readFilters(req.query ?? {});
        return getServerEventStats(filters);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/server-events/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      const event = getServerEventById(req.params.id);
      if (!event) return reply.code(404).send({ error: "not found" });
      return event;
    },
  );

  app.get<{ Params: { operationId: string } }>(
    "/api/admin/server-events/operation/:operationId",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      const { events, truncated } = getOperationChain(req.params.operationId);
      return { events, truncated };
    },
  );

  /**
   * Выгрузка пакета диагностики. Один файл, который владелец кладёт
   * себе на диск и прикладывает к разбору сбоя. Содержит:
   *   - сами события (с редакцией секретов, как в журнале);
   *   - счётчики по scope/kind за тот же фильтр;
   *   - снимок серверных настроек;
   *   - версию Node и текущий коммит.
   *
   * Форматы:
   *   - json  (по умолчанию): один JSON-документ;
   *   - ndjson: события по одной на строку, без обёртки;
   *   - gzip:  тот же json, но сжатый `gzip` (через `node:zlib`).
   *
   * Лимит по количеству событий — SERVER_EVENTS_EXPORT_MAX_EVENTS (5000),
   * чтобы файл оставался вменяемого размера даже на «всё за неделю».
   */
  app.get(
    "/api/admin/server-events/export",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!ownerOr403(req, reply)) return;
      const formatRaw = String(req.query?.format ?? "json").toLowerCase();
      if (!["json", "ndjson", "gzip"].includes(formatRaw)) {
        return reply.code(400).send({ error: `unknown format: ${formatRaw}` });
      }

      try {
        const filters = readFilters(req.query ?? {});
        filters.limit = SERVER_EVENTS_EXPORT_MAX_EVENTS;
        const { events } = listServerEvents(filters);
        const stats = getServerEventStats(filters);
        const server = readServerCommit();

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `server-events-${stamp}.${
          formatRaw === "gzip" ? "json.gz" : formatRaw === "ndjson" ? "ndjson" : "json"
        }`;

        reply.header("Content-Disposition", `attachment; filename="${filename}"`);

        if (formatRaw === "ndjson") {
          reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
          return serializeNdjson(events);
        }

        const payload = buildExportPayload(
          filters,
          events,
          { total: stats.total, byScope: stats.byScope, byOutcome: stats.byOutcome },
          server,
        );
        const json = JSON.stringify(payload);

        if (formatRaw === "gzip") {
          const { gzipSync } = await import("node:zlib");
          reply.header("Content-Type", "application/gzip");
          return gzipSync(Buffer.from(json, "utf8"));
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return json;
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );
}