// API для владельца: GET список параметров, PUT изменение, POST сброс.
// Контракт: docs/2026-10-08-server-settings-registry.md.
//
// Все три эндпоинта — только владелец. Чтение самого реестра (не путать
// с API) открыто для модулей сервера (getSetting()).
//
// Логика:
//  — GET /api/admin/server-settings            → все метаданные + значения +
//                                               updated_at для UI.
//  — GET /api/admin/server-settings/log        → журнал изменений
//                                               (последние 50 записей).
//  — PUT /api/admin/server-settings/:key       → изменение; body { value,
//                                               reason?: string }. PUT без
//                                               тела или с чужим ключом —
//                                               400/404. PUT с невалидным
//                                               значением — 400 с текстом.
//  — POST /api/admin/server-settings/:key/reset → сброс к дефолту.
//
// Проверка прав: `authOrApiToken + isOwner(req.userId)`. Оркестратор
// (пользователь с ролью orchestrator) и агенты не имеют права менять
// серверные параметры — это владельческая ответственность.
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { SERVER_SETTINGS, type DefaultsKey } from "../lib/serverSettingsRegistry.js";
import {
  getServerSettingsLog,
  resetSetting,
  setSetting,
  snapshotSettings,
} from "../lib/serverSettings.js";

function ownerOr403(req: any, reply: any): boolean {
  if (isOwner(req.userId)) return true;
  reply.code(403).send({ error: "доступно только владельцу" });
  return false;
}

export function registerAdminServerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/admin/server-settings", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!ownerOr403(req, reply)) return;
    const values = snapshotSettings();
    const updatedRows = (await import("../db.js")).default
      .prepare("SELECT key, updated_at FROM server_settings")
      .all() as Array<{ key: string; updated_at: string }>;
    const updated_at: Record<string, string> = {};
    for (const r of updatedRows) updated_at[r.key] = r.updated_at;
    return {
      settings: SERVER_SETTINGS,
      values,
      updated_at,
    };
  });

  app.get("/api/admin/server-settings/log", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!ownerOr403(req, reply)) return;
    return { log: getServerSettingsLog(50) };
  });

  app.put<{
    Params: { key: string };
    Body: { value?: unknown; reason?: string };
  }>("/api/admin/server-settings/:key", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!ownerOr403(req, reply)) return;
    const { key } = req.params;
    const meta = SERVER_SETTINGS.find((s) => s.key === key);
    if (!meta) return reply.code(404).send({ error: `неизвестный ключ "${key}"` });
    const body = req.body ?? {};
    if (!("value" in body)) {
      return reply.code(400).send({ error: "нужно поле value" });
    }
    try {
      setSetting(key as DefaultsKey, body.value as never, req.userId, body.reason);
      // Изменения серверных параметров не привязаны к конкретной задаче;
      // журнал реестра (`server_settings_log`) и так хранит actor/reason/
      // before/after. Дополнительный `task_events` тут создал бы запись
      // с несуществующим task_id — пропускаем.
      return { ok: true, value: body.value };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{
    Params: { key: string };
    Body: { reason?: string };
  }>("/api/admin/server-settings/:key/reset", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!ownerOr403(req, reply)) return;
    const { key } = req.params;
    const meta = SERVER_SETTINGS.find((s) => s.key === key);
    if (!meta) return reply.code(404).send({ error: `неизвестный ключ "${key}"` });
    try {
      resetSetting(key as DefaultsKey, req.userId, req.body?.reason);
      // См. выше — сброс тоже логируется только в `server_settings_log`.
      return { ok: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}