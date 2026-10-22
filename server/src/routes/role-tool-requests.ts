// Запрос роли на инструмент, которого ей не дали (17.10.2026).
//
// Проблема, которую это закрывает: закрытые роли действия прятались из
// каталога (universalTaskflow discover фильтровал их по authorize). Роль не
// знала, что действие существует, поэтому не могла ни пострадать от стены
// осознанно, ни попросить её снять — журнал role_tool_missing пустовал годами.
//
// Теперь каталог показывает закрытое (available:false), а роль может поставить
// заявку: taskflow_tool_request → эта таблица → уведомление владельцу в
// «Состояние системы». Уведомление, а не карточка: сигнал о нехватке прав —
// не задача (правило владельца 10.10.2026 про сторожей и лавину: не больше
// одной тревоги в сутки на пару «роль + инструмент»).
//
// Сама заявка пишется всегда; уведомление — не чаще раза в сутки на пару,
// иначе роль, застрявшая на одном инструменте, завалит ленту.

import * as crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { logEvent } from "../agentState.js";

export const ROLE_TOOL_REQUEST_SCHEMA = `CREATE TABLE IF NOT EXISTS role_tool_gain_requests (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  actor_id TEXT,
  tool TEXT NOT NULL,
  why TEXT NOT NULL,
  attempted TEXT,
  task_id TEXT,
  subtask_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_role_tool_gain_requests_status ON role_tool_gain_requests(status, created_at DESC);`;

export const ROLE_TOOL_REQUEST_NOTIFICATION_TYPE = "role_tool_request";

const DAY_MS = 24 * 60 * 60 * 1000;

function ownerId(): string | null {
  const row = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/** Роль вызывающего: role_key, а если он пуст — по имени учётки. */
function roleKeyOf(user: { id?: string; role_key?: string | null } | undefined): string | null {
  if (!user) return null;
  if (user.role_key) return user.role_key;
  if (user.id?.startsWith("role_")) return user.id.slice("role_".length);
  if (user.id === "u-secretary") return "secretary";
  return null;
}

export interface ToolRequestInput {
  role: string;
  actorId?: string;
  tool: string;
  why: string;
  attempted?: string;
  taskId?: string;
  subtaskId?: string;
}

export interface ToolRequestResult {
  id: string;
  notified: boolean;
}

/**
 * Записать заявку и (не чаще раза в сутки на пару) уведомить владельца.
 * Отдельная функция, а не только эндпоинт: ею пользуются тесты.
 */
export function recordRoleToolRequest(input: ToolRequestInput): ToolRequestResult {
  const tool = input.tool.trim();
  const why = input.why.trim();
  const id = crypto.randomUUID();
  // Роль присылает id карточки и шага сама; уведомление и лента событий
  // ссылаются на внешние ключи, поэтому проверяем existence — опечатка в id
  // не должна ронять заявку в 500.
  const taskId = input.taskId && db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(input.taskId) ? input.taskId : undefined;
  const subtaskId =
    input.subtaskId && db.prepare("SELECT 1 FROM subtasks WHERE id = ?").get(input.subtaskId) ? input.subtaskId : undefined;
  const actorId = input.actorId && db.prepare("SELECT 1 FROM users WHERE id = ?").get(input.actorId) ? input.actorId : undefined;
  db.prepare(
    `INSERT INTO role_tool_gain_requests(id,role,actor_id,tool,why,attempted,task_id,subtask_id)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).run(id, input.role, actorId ?? null, tool, why, input.attempted ?? null, taskId ?? null, subtaskId ?? null);
  // В ленту событий пишем только заявку из карточки: у task_events task_id
  // обязателен, а заявка может прийти и из чата. Сама заявка уже в таблице
  // выше — журнал здесь только для видимости рядом с работой роли.
  if (taskId) {
    try {
      logEvent({
        taskId,
        actorId: actorId ?? null,
        kind: "role_tool_request",
        field: input.role,
        fromValue: why.slice(0, 500),
        toValue: tool.slice(0, 100),
      });
    } catch {
      // Журнал — вспомогательный: отсутствие события запросу не мешает.
    }
  }
  const owner = ownerId();
  let notified = false;
  if (owner) {
    // Лавина: одна и та же заявка в сутки — одно уведомление.
    const since = new Date(Date.now() - DAY_MS).toISOString().replace("T", " ").slice(0, 19);
    const seen = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications
          WHERE user_id = ? AND type = ? AND created_at > ? AND text LIKE ?`,
      )
      .get(owner, ROLE_TOOL_REQUEST_NOTIFICATION_TYPE, since, `%${tool}%`) as { n: number };
    if (!seen.n) {
      db.prepare("INSERT INTO notifications(id,user_id,type,task_id,text,actor_id) VALUES(?,?,?,?,?,?)").run(
        crypto.randomUUID(),
        owner,
        ROLE_TOOL_REQUEST_NOTIFICATION_TYPE,
        taskId ?? null,
        `Роль «${input.role}» просит инструмент ${tool}: ${why.slice(0, 300)}`,
        actorId ?? null,
      );
      notified = true;
    }
  }
  return { id, notified };
}

export function registerRoleToolRequestRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.post("/api/role-tool-requests", { preHandler: authPre }, async (req: any, reply: any) => {
    const tool = String(req.body?.tool ?? "").trim();
    const why = String(req.body?.why ?? "").trim();
    if (!tool) return reply.code(400).send({ error: "tool обязателен" });
    if (!why) return reply.code(400).send({ error: "why обязательно: зачем нужен инструмент" });
    // users.role — это ВЛАСТЬ (owner/agent/viewer/orchestrator/service), а роль
    // как такая лежит в users.role_key ('secretary', 'builder', ...). Путать их
    // нельзя: триггеры миграции 058 отклоняют.role = 'secretary'.
    const actor = db.prepare("SELECT id, role_key, role, type FROM users WHERE id = ?").get(req.userId) as
      | { id: string; role_key?: string | null; role?: string; type?: string }
      | undefined;
    // Роль вызывающего: role_key, а если он пуст — по имени учётки (ролевые
    // учётки называются role_<key>, помощник владельца — историческая
    // u-secretary; так же их строит roleRouting.roleUserId).
    const role = String(roleKeyOf(actor) ?? "").trim();
    if (!role) return reply.code(400).send({ error: "роль вызывающего не определяется: нет role_key" });
    const result = recordRoleToolRequest({
      role,
      actorId: req.userId,
      tool,
      why,
      attempted: req.body?.attempted ? String(req.body.attempted).slice(0, 500) : undefined,
      taskId: req.body?.task_id ?? undefined,
      subtaskId: req.body?.subtask_id ?? undefined,
    });
    return reply.code(201).send({ id: result.id, notified: result.notified, status: "open" });
  });

  // Список заявок: владельцу — все, роли — свои.
  app.get("/api/role-tool-requests", { preHandler: authPre }, async (req: any, reply: any) => {
    const actor = db.prepare("SELECT id, role_key, role, type FROM users WHERE id = ?").get(req.userId) as
      | { id: string; role_key?: string | null; role?: string; type?: string }
      | undefined;
    const isOwner = actor?.type === "human" && actor?.role === "owner";
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    const rows = (
      status
        ? db
            .prepare(
              `SELECT id,role,tool,why,attempted,task_id,subtask_id,status,created_at,decided_at
                 FROM role_tool_gain_requests WHERE status = ? ORDER BY created_at DESC LIMIT 200`,
            )
            .all(status)
        : db
            .prepare(
              `SELECT id,role,tool,why,attempted,task_id,subtask_id,status,created_at,decided_at
                 FROM role_tool_gain_requests ORDER BY created_at DESC LIMIT 200`,
            )
            .all()
    ) as any[];
    const visible = isOwner ? rows : rows.filter((r) => r.role === roleKeyOf(actor));
    return { requests: visible };
  });

  app.post("/api/role-tool-requests/:id/decision", { preHandler: authPre }, async (req: any, reply: any) => {
    const actor = db.prepare("SELECT id, role, type FROM users WHERE id = ?").get(req.userId) as
      | { id: string; role?: string; type?: string }
      | undefined;
    if (!(actor?.type === "human" && actor.role === "owner")) {
      return reply.code(403).send({ error: "решение по заявке принимает владелец" });
    }
    const status = String(req.body?.status ?? "");
    if (!["granted", "rejected"].includes(status)) {
      return reply.code(400).send({ error: "status: granted или rejected" });
    }
    const changed = db
      .prepare("UPDATE role_tool_gain_requests SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ? AND status = 'open'")
      .run(status, req.userId, req.params.id).changes;
    if (!changed) return reply.code(404).send({ error: "заявка не найдена или уже решена" });
    return { ok: true, id: req.params.id, status };
  });
}