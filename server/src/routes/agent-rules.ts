// Маршруты `/api/agent/rules/*` — единственный внешний путь к манифесту
// правил и подтверждениям. Обходят `taskflow_chat_send` намеренно: эти
// операции записывают структурированные поля (rule_ref, status) и
// пишут события в `task_events` — чат-роут для того не приспособлен, а
// смешение каналов сломает приёмник событий.
// Этап B карточки 51763de5-…, контракт — `45d948af-…`/`4ec246d6-…`.

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import {
  RuleValidationError,
  acknowledgeRule,
  canPublish,
  pendingRulesForRole,
  publishRule,
  rulesForOwner,
  validatePublishArgs,
} from "../lib/agentRules.js";

export async function registerAgentRulesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agent/rules/list — владелец/оркестратор смотрит манифест и
  // список неподтверждённых правил для конкретной роли. Базовый
  // `/api/agent/rules` уже занят существующим маршрутом
  // (server/src/routes/agent-state.ts:120) — там AGENT_RULES для экрана
  // Control Center; чтобы не ломать обратную совместимость и не править
  // существующий маршрут, новые операции живут под собственным суффиксом.
  app.get<{
    Querystring: { role?: string; scope?: string };
  }>("/api/agent/rules/list", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const role = typeof req.query?.role === "string" ? req.query.role : null;
    const scope = typeof req.query?.scope === "string" ? req.query.scope : null;

    // Любой запрашивающий получает и общий манифест, и свой pending_for_role,
    // потому что `rulesForOwner()` отдаёт только метаданные (без черновика
    // и payload), а `pendingRulesForRole(role)` — то, что именно этой роли
    // осталось подтвердить. Если role не указан, отдаём null: для агента,
    // запрашивающего чужую роль, это явный сигнал, что спрашивать нечего.
    const manifest = rulesForOwner();
    const pending = role ? { [role]: pendingRulesForRole(role) } : null;
    void scope;
    return { manifest, pending_for_role: pending };
  });

  app.get<{
    Querystring: { role?: string };
  }>("/api/agent/rules/pending", { preHandler: authOrApiToken }, async (req: any) => {
    const role = typeof req.query?.role === "string" ? req.query.role : null;
    if (!role) return { error: "role_required", pending_for_role: [] };
    return { pending_for_role: pendingRulesForRole(role) };
  });

  app.post<{
    Body: {
      rule_id: string;
      version: number | string;
      content: string;
      role_scope?: string[] | "*" | null;
    };
  }>("/api/agent/rules/publish", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const userId = req.userId as string;
    if (!canPublish(userId)) {
      return reply.code(403).send({ error: "owner_or_orchestrator_required" });
    }
    // Fastify парсит JSON-тело в req.body; ожидаем snake_case как во всех
    // существующих маршрутах и приводим к camelCase перед передачей в lib.
    const body = req.body ?? {};
    let validated;
    try {
      validated = validatePublishArgs({
        ruleId: body.rule_id,
        version: body.version,
        content: body.content,
        roleScope: body.role_scope,
      });
    } catch (err) {
      if (err instanceof RuleValidationError) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
      throw err;
    }
    const result = publishRule({ ...validated, publishedBy: userId });
    return {
      ok: true,
      existed: result.existed,
      ref: result.ref,
      chat_message_id: result.chatMessageId,
    };
  });

  app.post<{
    Body: {
      rule_id: string;
      version: number | string;
      role: string;
      session_id?: string | null;
    };
  }>("/api/agent/rules/acknowledge", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const userId = req.userId as string;
    const body = req.body ?? {};
    const role = (body.role ?? "").trim();
    if (!role) return reply.code(400).send({ error: "role_required" });

    // Агент подтверждает «от своего имени»: в личной сессии — своей ролью,
    // не чужой. Учётки `role_<key>` указывают прямо на роль, и user.role_key
    // (если есть) — самая надёжная проверка. На свежей 058-ой миграции
    // role_key живёт рядом со старой role.
    const userRow = db
      .prepare("SELECT role_key, role FROM users WHERE id = ?")
      .get(userId) as { role_key: string | null; role: string } | undefined;
    if (!userRow) return reply.code(401).send({ error: "unknown_user" });
    const ownRole = userRow.role_key ?? null;
    if (ownRole && ownRole !== role) {
      return reply.code(403).send({ error: "cannot_acknowledge_for_other_role" });
    }
    // Владелец трекера (userRow.role === 'owner') может подтверждать
    // правила, адресованные лично ему — это часть NFR-контракта роли
    // владельца в общем канале.

    const ruleId = body.rule_id;
    const version = Number(body.version);
    if (typeof ruleId !== "string" || !Number.isInteger(version)) {
      return reply.code(400).send({ error: "rule_id_and_version_required" });
    }
    const sessionId = typeof body.session_id === "string" ? body.session_id : null;

    let result;
    try {
      result = acknowledgeRule({
        ruleId,
        version,
        role,
        sessionId,
        actorUserId: userId,
      });
    } catch (err) {
      if (err instanceof RuleValidationError) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
      throw err;
    }
    if (result.ok) {
      return {
        ok: true,
        ref: result.ref,
        acknowledged_at: result.acknowledgedAt,
        chat_message_id: result.chatMessageId,
      };
    }
    return reply
      .code(409)
      .send({ error: result.error, current_version: result.currentVersion });
  });
}
