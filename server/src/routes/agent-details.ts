// src/routes/agent-details.ts
//
// LOCK-146, серверная половина (iOS — `AgentRow.swift` / `AgentsViewModel.swift`).
// Эндпоинты под карточку агента в Настройки → Команда:
//   - GET  /api/agents/:id/details       — полная информация + модель + права +
//                                          подключённые MCP/скиллы
//   - GET  /api/mcp-servers/catalog      — каталог доступных MCP-серверов
//                                          (Composio, Smithery и т.п.)
//   - POST /api/agents/:id/mcp-servers   — подключить MCP-сервер агенту
//   - DELETE /api/agents/:id/mcp-servers/:server_id — отключить
//   - GET  /api/skills/catalog           — каталог скиллов
//   - POST /api/agents/:id/skills        — установить скилл агенту
//   - DELETE /api/agents/:id/skills/:skill_id — удалить
//   - PUT  /api/agents/:id/model         — задать модель (LLM)
//   - PUT  /api/agents/:id/prompt        — задать индивидуальный системный промпт
//   - PUT  /api/agents/:id/connection    — внешний runtime или прямой API
//   - PUT  /api/agents/:id/permissions   — задать JSON per-action прав
//   - PUT  /api/agents/:id/api-token     — сохранить свой ключ доступа
//                                          (хранится хешем; наружу не отдаётся)
//   - POST /api/agents/:id/rotate-token  — выпустить новый ключ (один раз
//                                          показывается в ответе)
//
// Все мутации — только владелец (роль=owner). Чтение — любой авторизованный,
// у кого есть этот агент в своём `/api/agents` (та же логика видимости, что
// у исходного списка). MCP/скилл-каталог — публичный для авторизованных.

import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

// ── Общие помощники ────────────────────────────────────────────────────────

/** sha256 от строки (hex, lowercase). */
function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Сгенерировать новый сырой токен формата "tf_..." + хеш для хранения. */
function mintApiToken(): { raw: string; hash: string } {
  const raw = "tf_" + crypto.randomBytes(32).toString("hex");
  return { raw, hash: sha256Hex(raw) };
}

/** Видимость агента для caller — та же логика, что в GET /api/agents. */
function agentVisibleTo(agentId: string, callerId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM users
        WHERE id = ?
          AND (is_system_bot = 1
               OR id = ?
               OR created_by = ?
               OR id IN (
                 SELECT assignee_id FROM tasks
                  WHERE creator_id = ? AND assignee_id IS NOT NULL
                 UNION
                 SELECT creator_id FROM tasks
                  WHERE assignee_id = ? AND creator_id IS NOT NULL
               ))`,
    )
    .get(agentId, callerId, callerId, callerId, callerId);
  return !!row;
}

/** Только владелец — все мутации закрыты этим гардом. */
function requireOwner(reply: any, callerId: string): boolean {
  const row = db
    .prepare("SELECT role FROM users WHERE id = ?")
    .get(callerId) as { role?: string } | undefined;
  if (row?.role !== "owner") {
    reply.code(403).send({ error: "только владелец" });
    return false;
  }
  return true;
}

/**
 * iOS собирает URL через `appendingPathComponent`, поэтому уже кодированный
 * slash из каталожного id (`composio%2Fgithub`) становится `%252F`. Fastify
 * снимает первый слой при разборе маршрута; второй снимаем здесь, сохраняя id
 * одним path-параметром.
 */
function decodeCatalogPathId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Прочитать permissions агента. Если NULL — вернуть дефолт по роли. */
function defaultPermissions(role: string, type: string): Record<string, boolean> {
  if (role === "owner") {
    return {
      can_create_tasks: true,
      can_delete_tasks: true,
      can_manage_projects: true,
      can_invite_agents: true,
      can_change_settings: true,
    };
  }
  if (role === "orchestrator") {
    return {
      can_create_tasks: true,
      can_delete_tasks: false,
      can_manage_projects: true,
      can_invite_agents: true,
      can_change_settings: false,
    };
  }
  if (type === "ai") {
    return {
      can_create_tasks: true,
      can_delete_tasks: false,
      can_manage_projects: false,
      can_invite_agents: false,
      can_change_settings: false,
    };
  }
  // viewer / обычный человек
  return {
    can_create_tasks: false,
    can_delete_tasks: false,
    can_manage_projects: false,
    can_invite_agents: false,
    can_change_settings: false,
  };
}

function readPermissions(raw: string | null, role: string, type: string): Record<string, boolean> {
  if (!raw) return defaultPermissions(role, type);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // повреждённый JSON — отдадим дефолт, не падаем
  }
  return defaultPermissions(role, type);
}

// ── Регистрация маршрутов ──────────────────────────────────────────────────

export function registerAgentDetailsRoutes(app: FastifyInstance): void {

  // ── Чтение полной карточки ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/agents/:id/details",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const agentId = req.params.id;
      if (!agentVisibleTo(agentId, req.userId)) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      const row = db
        .prepare(
          `SELECT id, name, role, type, model, prompt, permissions,
                  execution_mode, model_provider, model_base_url,
                  model_credential_ref,
                  avatar_color, avatar_url, avatar_url_working, avatar_url_blocked,
                  initials, status, last_seen_at, created_at, is_system_bot,
                  created_by, api_token_set_at
             FROM users WHERE id = ?`,
        )
        .get(agentId) as Record<string, unknown> | undefined;
      if (!row) {
        return reply.code(404).send({ error: "агент не найден" });
      }

      const mcpServers = db
        .prepare(
          `SELECT s.server_id AS id, s.enabled, s.config_json,
                  c.name, c.provider, c.description, c.url, c.default_config_json,
                  s.added_at
             FROM agent_mcp_servers s
             JOIN mcp_server_catalog c ON c.id = s.server_id
            WHERE s.agent_id = ?
         ORDER BY c.name`,
        )
        .all(agentId) as Array<Record<string, unknown>>;

      const skills = db
        .prepare(
          `SELECT s.skill_id AS id, s.config_json,
                  c.name, c.description, c.install_url, c.default_config_json,
                  s.added_at
             FROM agent_skills s
             JOIN skill_catalog c ON c.id = s.skill_id
            WHERE s.agent_id = ?
         ORDER BY c.name`,
        )
        .all(agentId) as Array<Record<string, unknown>>;

      return {
        ...row,
        permissions: readPermissions(
          row.permissions as string | null,
          row.role as string,
          row.type as string,
        ),
        mcpServers: mcpServers.map((s) => ({
          id: s.id,
          name: s.name,
          provider: s.provider,
          description: s.description,
          url: s.url,
          enabled: s.enabled === 1,
          config: s.config_json ? JSON.parse(s.config_json as string) : null,
          defaultConfig: s.default_config_json
            ? JSON.parse(s.default_config_json as string)
            : null,
          addedAt: s.added_at,
        })),
        skills: skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          installUrl: s.install_url,
          config: s.config_json ? JSON.parse(s.config_json as string) : null,
          defaultConfig: s.default_config_json
            ? JSON.parse(s.default_config_json as string)
            : null,
          addedAt: s.added_at,
        })),
      };
    },
  );

  // ── Каталог MCP-серверов ─────────────────────────────────────────────────
  app.get(
    "/api/mcp-servers/catalog",
    { preHandler: authOrApiToken },
    async () => {
      const rows = db
        .prepare(
          `SELECT id, name, provider, description, url, default_config_json
             FROM mcp_server_catalog
         ORDER BY provider, name`,
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        description: r.description,
        url: r.url,
        defaultConfig: r.default_config_json
          ? JSON.parse(r.default_config_json as string)
          : null,
      }));
    },
  );

  // ── Подключить MCP-сервер агенту ─────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { serverId?: string; config?: unknown; enabled?: boolean };
  }>(
    "/api/agents/:id/mcp-servers",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const serverId = String(req.body?.serverId ?? "").trim();
      if (!serverId) {
        return reply.code(400).send({ error: "нужен serverId" });
      }
      const agent = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(agentId) as { type?: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      if (agent.type !== "ai") {
        return reply.code(400).send({ error: "MCP-серверы только для ИИ-агентов" });
      }
      const exists = db
        .prepare("SELECT 1 FROM mcp_server_catalog WHERE id = ?")
        .get(serverId);
      if (!exists) {
        return reply.code(404).send({ error: "MCP-сервер не найден в каталоге" });
      }
      const enabled = req.body?.enabled === false ? 0 : 1;
      const config = req.body?.config
        ? JSON.stringify(req.body.config)
        : null;
      db.prepare(
        `INSERT INTO agent_mcp_servers (agent_id, server_id, enabled, config_json)
              VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, server_id) DO UPDATE SET
              enabled = excluded.enabled,
              config_json = excluded.config_json`,
      ).run(agentId, serverId, enabled, config);
      return { ok: true };
    },
  );

  // ── Отключить MCP-сервер у агента ───────────────────────────────────────
  app.delete<{ Params: { id: string; serverId: string } }>(
    "/api/agents/:id/mcp-servers/:serverId",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const serverId = decodeCatalogPathId(req.params.serverId);
      db.prepare(
        "DELETE FROM agent_mcp_servers WHERE agent_id = ? AND server_id = ?",
      ).run(req.params.id, serverId);
      return { ok: true };
    },
  );

  // ── Каталог скиллов ──────────────────────────────────────────────────────
  app.get(
    "/api/skills/catalog",
    { preHandler: authOrApiToken },
    async () => {
      const rows = db
        .prepare(
          `SELECT id, name, description, install_url, default_config_json
             FROM skill_catalog
         ORDER BY name`,
        )
        .all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        installUrl: r.install_url,
        defaultConfig: r.default_config_json
          ? JSON.parse(r.default_config_json as string)
          : null,
      }));
    },
  );

  // ── Установить скилл агенту ──────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { skillId?: string; config?: unknown };
  }>(
    "/api/agents/:id/skills",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const skillId = String(req.body?.skillId ?? "").trim();
      if (!skillId) {
        return reply.code(400).send({ error: "нужен skillId" });
      }
      const agent = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(agentId) as { type?: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      if (agent.type !== "ai") {
        return reply.code(400).send({ error: "скиллы только для ИИ-агентов" });
      }
      const exists = db
        .prepare("SELECT 1 FROM skill_catalog WHERE id = ?")
        .get(skillId);
      if (!exists) {
        return reply.code(404).send({ error: "скилл не найден в каталоге" });
      }
      const config = req.body?.config
        ? JSON.stringify(req.body.config)
        : null;
      db.prepare(
        `INSERT INTO agent_skills (agent_id, skill_id, config_json)
              VALUES (?, ?, ?)
         ON CONFLICT(agent_id, skill_id) DO UPDATE SET
              config_json = excluded.config_json`,
      ).run(agentId, skillId, config);
      return { ok: true };
    },
  );

  // ── Удалить скилл у агента ──────────────────────────────────────────────
  app.delete<{ Params: { id: string; skillId: string } }>(
    "/api/agents/:id/skills/:skillId",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const skillId = decodeCatalogPathId(req.params.skillId);
      db.prepare(
        "DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?",
      ).run(req.params.id, skillId);
      return { ok: true };
    },
  );

  // ── Задать модель агента ─────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { model?: string | null } }>(
    "/api/agents/:id/model",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const agent = db
        .prepare("SELECT id FROM users WHERE id = ?")
        .get(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      const raw = req.body?.model;
      const model =
        raw == null || (typeof raw === "string" && raw.trim() === "")
          ? null
          : String(raw).trim();
      db.prepare("UPDATE users SET model = ? WHERE id = ?").run(model, agentId);
      return { ok: true, model };
    },
  );

  // ── Способ исполнения: внешний агент или прямой API ────────────────────
  app.put<{
    Params: { id: string };
    Body: {
      mode?: "agent_runtime" | "direct_api";
      provider?: string | null;
      model?: string | null;
      baseUrl?: string | null;
      credentialRef?: string | null;
    };
  }>(
    "/api/agents/:id/connection",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const agent = db
        .prepare("SELECT id, type FROM users WHERE id = ?")
        .get(agentId) as { id: string; type: string } | undefined;
      if (!agent) return reply.code(404).send({ error: "агент не найден" });
      if (agent.type !== "ai") {
        return reply.code(400).send({ error: "способ исполнения настраивается только для ИИ-агентов" });
      }

      const mode = req.body?.mode;
      if (mode !== "agent_runtime" && mode !== "direct_api") {
        return reply.code(400).send({ error: "mode должен быть agent_runtime или direct_api" });
      }
      const clean = (value: unknown): string | null =>
        typeof value === "string" && value.trim() ? value.trim() : null;
      const provider = clean(req.body?.provider);
      const model = clean(req.body?.model);
      const baseUrl = clean(req.body?.baseUrl);
      const credentialRef = clean(req.body?.credentialRef);

      if (mode === "direct_api" && (!provider || !model || !credentialRef)) {
        return reply.code(400).send({
          error: "для прямого API нужны provider, model и credentialRef",
        });
      }

      db.prepare(
        `UPDATE users
            SET execution_mode = ?, model_provider = ?, model = ?,
                model_base_url = ?, model_credential_ref = ?
          WHERE id = ?`,
      ).run(
        mode,
        mode === "direct_api" ? provider : null,
        model,
        mode === "direct_api" ? baseUrl : null,
        mode === "direct_api" ? credentialRef : null,
        agentId,
      );
      return {
        ok: true,
        mode,
        provider: mode === "direct_api" ? provider : null,
        model,
        baseUrl: mode === "direct_api" ? baseUrl : null,
        credentialRef: mode === "direct_api" ? credentialRef : null,
      };
    },
  );

  // ── Задать индивидуальный системный промпт агента ──────────────────────
  app.put<{ Params: { id: string }; Body: { prompt?: string | null } }>(
    "/api/agents/:id/prompt",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const agent = db
        .prepare("SELECT id FROM users WHERE id = ?")
        .get(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      const raw = req.body?.prompt;
      if (raw != null && typeof raw !== "string") {
        return reply.code(400).send({ error: "prompt должен быть строкой или null" });
      }
      const prompt = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      db.prepare("UPDATE users SET prompt = ? WHERE id = ?").run(prompt, agentId);
      return { ok: true, prompt };
    },
  );

  // ── Задать per-action права ─────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { permissions?: Record<string, boolean> } }>(
    "/api/agents/:id/permissions",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const perms = req.body?.permissions;
      if (!perms || typeof perms !== "object") {
        return reply.code(400).send({ error: "нужен объект permissions" });
      }
      const cleaned: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(perms)) {
        if (typeof v === "boolean") cleaned[k] = v;
      }
      db.prepare("UPDATE users SET permissions = ? WHERE id = ?").run(
        JSON.stringify(cleaned),
        agentId,
      );
      return { ok: true, permissions: cleaned };
    },
  );

  // ── Сохранить свой API-токен ────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { token?: string } }>(
    "/api/agents/:id/api-token",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const token = String(req.body?.token ?? "").trim();
      if (!token) {
        return reply.code(400).send({ error: "нужен token" });
      }
      const agent = db
        .prepare("SELECT id, name FROM users WHERE id = ?")
        .get(agentId);
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      db.prepare(
        `UPDATE users
            SET api_token = ?,
                api_token_set_at = datetime('now')
          WHERE id = ?`,
      ).run(sha256Hex(token), agentId);
      return { ok: true };
    },
  );

  // ── Перевыпустить API-токен (один раз показывается в ответе) ────────────
  app.post<{ Params: { id: string } }>(
    "/api/agents/:id/rotate-token",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!requireOwner(reply, req.userId)) return;
      const agentId = req.params.id;
      const agent = db
        .prepare("SELECT id, name FROM users WHERE id = ?")
        .get(agentId) as { id?: string; name?: string } | undefined;
      if (!agent) {
        return reply.code(404).send({ error: "агент не найден" });
      }
      const { raw, hash } = mintApiToken();
      db.prepare(
        `UPDATE users
            SET api_token = ?,
                api_token_set_at = datetime('now')
          WHERE id = ?`,
      ).run(hash, agentId);
      return { agentId: agent.id, name: agent.name, apiToken: raw };
    },
  );
}
