import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken, ownerOrApiToken } from "../auth.js";
import {
  applyOverride,
  compose,
  composeLayer,
  getLayerSpec,
  globalVersionForRole,
  listHistory,
  LAYER_CATALOG,
  readHistoryEntry,
  readOriginalOnly,
  type ComposedLayer,
  type RunMode,
} from "../lib/roleContextResolver.js";

/**
 * REST API управления контекстом запуска ролей (карточка
 * `15c2db1f-521f-4fae-8e47-6ac18458c966`, дизайн заметки
 * `54ff50a1-37ed-45ac-badd-9cbfab02a5d5`, §7).
 *
 * GET — эффективный текст всех/одного слоя для роли в режиме.
 * PATCH — правка (owner, if_match=version, иначе 428).
 * POST .../reset — сброс к оригиналу (owner).
 * POST .../restore — восстановление версии (owner).
 *
 * Эндпоинт НЕ подменяет runtime: подключение к inProcessRun/chats/
 * secretaryReply/consultation/task_context.py — отдельный шаг 4.
 * Здесь только хранение, чтение и API для будущего редактора (шаг 5).
 */

const RUN_MODES = new Set<RunMode>(["work", "resume", "reply", "review", "subtask", "chat", "voice"]);

function isRunMode(value: string): value is RunMode {
  return RUN_MODES.has(value as RunMode);
}

/** Прочитать `if-match` из заголовка (`"3"`) или из тела (`if_match: 3`).
 *  Вернуть number или null, если ничего не передано (по дизайну — 428). */
function readIfMatch(req: { headers: Record<string, unknown>; body?: unknown }): number | null {
  const header = req.headers["if-match"];
  if (typeof header === "string") {
    const m = header.match(/^"?(\d+)"?$/);
    if (m) return Number(m[1]);
  }
  if (req.body && typeof req.body === "object") {
    const body = req.body as { if_match?: unknown };
    if (typeof body.if_match === "number") return body.if_match;
    if (typeof body.if_match === "string" && body.if_match.trim()) {
      const n = Number(body.if_match);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** Сконвертировать ComposedLayer в JSON, который уйдёт клиенту.
 *  updatedAt форматируем в привычный для системы YYYY-MM-DD HH:MM:SS. */
function toJson(layer: ComposedLayer): Record<string, unknown> {
  return {
    layer: layer.layer,
    effective: layer.effective,
    source: layer.source,
    origin: layer.origin,
    version: layer.version,
    updated_at: layer.updatedAt,
    updated_by: layer.updatedBy,
    read_only: layer.readOnly,
    modes: layer.modes,
  };
}

function isKnownRole(roleKey: string): boolean {
  // Допускаем и scope='command' с role_key='*' (общая инструкция) —
  // для command-override отдельный путь не нужен, проверка роли
  // делается по scope через :role/-path.
  if (roleKey === "*") return true;
  const row = db
    .prepare("SELECT 1 FROM roles WHERE key = ? LIMIT 1")
    .get(roleKey) as { 1: number } | undefined;
  return Boolean(row);
}

export function registerRuntimeContextRoutes(app: FastifyInstance): void {
  // Каталог слоёв — статическая структура, отдаётся без авторизации,
  // чтобы и редактор, и runtime могли прочитать структуру реестра.
  app.get("/api/runtime/context/catalog", async () => {
    return { layers: LAYER_CATALOG };
  });

  // Список эффективных слоёв для роли в режиме. Показывает «что уйдёт
  // в модель при таком-то запуске», без права правки.
  app.get<{ Querystring: { role?: string; mode?: string } }>(
    "/api/runtime/context",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      const role = req.query.role;
      const mode = req.query.mode ?? "work";
      if (!role || !isKnownRole(role)) {
        return reply.code(422).send({ error: "неизвестная роль" });
      }
      if (!isRunMode(mode)) {
        return reply.code(422).send({ error: `неизвестный режим: ${mode}` });
      }
      const layers = compose(role, mode);
      return {
        role,
        mode,
        version: globalVersionForRole(role),
        layers: layers.map(toJson),
      };
    },
  );

  // Один слой — для UI вкладок (effective + источник + версия).
  app.get<{ Params: { role: string; layer: string } }>(
    "/api/runtime/context/:role/:layer",
    { preHandler: authOrApiToken },
    async (req, reply) => {
      const role = req.params.role;
      const layer = req.params.layer;
      if (!isKnownRole(role)) return reply.code(404).send({ error: "роль не найдена" });
      if (!getLayerSpec(layer)) return reply.code(404).send({ error: "слой не найден" });
      const composed = composeLayer(role, layer);
      if (!composed) return reply.code(404).send({ error: "слой не применим к роли" });
      return {
        ...toJson(composed),
        history: listHistory("role", role, layer, 50),
      };
    },
  );

  // Правка слоя: владелец, if_match обязателен (428 если нет).
  // 409 если версия не совпала — в теле возвращаем текущую версию,
  // чтобы UI мог показать диалог «обновить и применить».
  app.patch<{ Params: { role: string; layer: string }; Body: { text?: unknown; if_match?: unknown } }>(
    "/api/runtime/context/:role/:layer",
    { preHandler: ownerOrApiToken },
    async (req: any, reply) => {
      const role = req.params.role;
      const layer = req.params.layer;
      const spec = getLayerSpec(layer);
      if (!spec) return reply.code(404).send({ error: "слой не найден" });
      if (!isKnownRole(role)) return reply.code(404).send({ error: "роль не найдена" });
      if (spec.readOnly) {
        return reply.code(422).send({ error: `слой ${layer} только для просмотра` });
      }
      const text = req.body?.text;
      if (typeof text !== "string" || !text.trim()) {
        return reply.code(422).send({ error: "text — непустая строка" });
      }
      const ifMatch = readIfMatch(req);
      if (ifMatch === null) {
        return reply.code(428).send({
          error: "If-Match обязателен (заголовок или тело if_match)",
        });
      }
      const current = composeLayer(role, layer);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== ifMatch) {
        return reply.code(409).send({
          error: "версия не совпала — кто-то уже отредактировал",
          current: current ? toJson(current) : null,
        });
      }
      const applied = applyOverride({
        scope: spec.scope,
        roleKey: role,
        layer,
        text,
        sourceKind: spec.sourceKind,
        sourceRef: `${spec.originRef} (override v${currentVersion + 1})`,
        createdBy: req.userId,
        action: "set",
      });
      return toJson(applied);
    },
  );

  // Сброс к оригиналу (owner). Новый active=1 с оригинальным текстом
  // и source_ref=исходник.
  app.post<{ Params: { role: string; layer: string } }>(
    "/api/runtime/context/:role/:layer/reset",
    { preHandler: ownerOrApiToken },
    async (req: any, reply) => {
      const role = req.params.role;
      const layer = req.params.layer;
      const spec = getLayerSpec(layer);
      if (!spec) return reply.code(404).send({ error: "слой не найден" });
      if (!isKnownRole(role)) return reply.code(404).send({ error: "роль не найдена" });
      if (spec.readOnly) {
        return reply.code(422).send({ error: `слой ${layer} только для просмотра` });
      }
      // Оригинальный текст читаем напрямую, минуя активный override —
      // иначе reset вернул бы сам override.
      const originalText = readOriginalOnly(role, layer);
      if (originalText === null) {
        return reply.code(404).send({ error: "слой не применим к роли" });
      }
      const applied = applyOverride({
        scope: spec.scope,
        roleKey: role,
        layer,
        text: originalText,
        sourceKind: spec.sourceKind,
        sourceRef: spec.originRef,
        createdBy: req.userId,
        action: "reset",
      });
      return toJson(applied);
    },
  );

  // Восстановление версии из истории (по дизайну §6).
  app.post<{
    Params: { role: string; layer: string };
    Body: { version?: unknown };
  }>(
    "/api/runtime/context/:role/:layer/restore",
    { preHandler: ownerOrApiToken },
    async (req: any, reply) => {
      const role = req.params.role;
      const layer = req.params.layer;
      const spec = getLayerSpec(layer);
      if (!spec) return reply.code(404).send({ error: "слой не найден" });
      if (!isKnownRole(role)) return reply.code(404).send({ error: "роль не найдена" });
      if (spec.readOnly) {
        return reply.code(422).send({ error: `слой ${layer} только для просмотра` });
      }
      const version = req.body?.version;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        return reply.code(422).send({ error: "version — целое число ≥ 1" });
      }
      const entry = readHistoryEntry(spec.scope, role, layer, version);
      if (!entry) {
        return reply.code(404).send({ error: `версия ${version} не найдена в истории` });
      }
      const applied = applyOverride({
        scope: spec.scope,
        roleKey: role,
        layer,
        text: entry.text,
        sourceKind: entry.sourceKind,
        sourceRef: entry.sourceRef,
        createdBy: req.userId,
        action: "restore",
        reason: `restore v${version}`,
      });
      return toJson(applied);
    },
  );
}