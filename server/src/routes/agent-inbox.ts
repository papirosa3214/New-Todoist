// Карточка 5f292e87 (MVP надёжная доставки поручений). HTTP-эндпоинты для
// agent_inbox: запись при сообщении в чат, чтение pending для агента,
// переходы статусов. Эндпоинт enqueue вызывается из chat.ts после INSERT
// в chat_messages (если у сообщения есть task_id и адресат != null).
//
// Маршрутизация: явный адресат пользователя имеет приоритет, иначе fallback
// в Оркестратора (routing_rules.team_catalog.json).
//
// Устаревшие события (версия карточки уехала вперёд) отбрасываются прямо
// в mark: любой переход сначала сверяет task_version с актуальной, и
// устаревшее тихо уходит в blocked. Триггер (trigger.py) вызывает тот же
// mark при приёме события — до claim, так что процесс по устаревшему
// поручению не запускается вовсе.

import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForWrite } from "../access.js";
import { registryRecord } from "../agentState.js";
import { readFileSync } from "fs";
import { join } from "path";

const uid = () => crypto.randomUUID();

type Verdict = "approved" | "changes_requested" | "blocked";
const TEAM_CATALOG_PATH = join(import.meta.dirname, "..", "..", "scripts", "team_catalog.json");

interface TeamCatalog {
  profiles: Record<string, { id: string; auto_route?: boolean; title: string }>;
  routing_rules: { explicit_addressee_wins: boolean; fallback_to_orchestrator: boolean };
}

function loadCatalog(): TeamCatalog {
  try {
    return JSON.parse(readFileSync(TEAM_CATALOG_PATH, "utf-8")) as TeamCatalog;
  } catch {
    return { profiles: {}, routing_rules: { explicit_addressee_wins: true, fallback_to_orchestrator: true } };
  }
}

export function routeAddressee(
  explicitTo: string | null,
  fromUserId: string,
  catalog: TeamCatalog,
): string {
  // Явный адресат — приоритет.
  if (explicitTo && explicitTo !== fromUserId) {
    return explicitTo;
  }
  // Иначе fallback в Оркестратора/диспетчера (в каталоге профиль назван
  // «Технический диспетчер», а не «Оркестратор» — ловим оба).
  const orch = Object.entries(catalog.profiles).find(([, p]) => {
    const t = p.title.toLowerCase();
    return t.includes("оркестратор") || t.includes("диспетчер");
  });
  if (orch) return orch[1].id;
  return fromUserId;
}

export { loadCatalog };

export async function registerAgentInboxRoutes(app: FastifyInstance): Promise<void> {
  const catalog = loadCatalog();

  // POST /api/agent-inbox/enqueue — записать поручение. Вызывается из
  // chat.ts после INSERT в chat_messages (когда у сообщения task_id и
  // адресат != null). UNIQUE на chat_message_id обеспечивает дедупликацию.
  app.post<{ Body: {
    chat_message_id: string;
    to_user_id?: string;
    body_text: string;
    task_id?: string;
    task_version?: number;
    kind?: "text" | "voice";
    event_type?: "chat" | "assignment" | "review_return";
  } }>("/api/agent-inbox/enqueue", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const body = req.body ?? {};
    if (!body.chat_message_id || !body.body_text) {
      return reply.code(400).send({ error: "chat_message_id и body_text обязательны" });
    }

    const fromUser = req.userId;
    const explicitTo = body.to_user_id || null;
    const routed = routeAddressee(explicitTo, fromUser, catalog);
    const to = routed;

    const inbox_id = uid();
    const eventType = body.event_type ?? "chat";
    const kind = body.kind ?? "text";

    try {
      db.prepare(
        `INSERT INTO agent_inbox
           (id, chat_message_id, to_user_id, body_text, task_id, task_version, kind, event_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', datetime('now'))`
      ).run(
        inbox_id, body.chat_message_id, to, body.body_text,
        body.task_id ?? null, body.task_version ?? null,
        kind, eventType,
      );
    } catch (e: any) {
      // Дедупликация — ТОЛЬКО по chat_message_id (Reviewer 5f292e87: чат
      // ловил любой UNIQUE). Прочие конфликты — пробрасываем.
      if (String(e?.message || "").includes("agent_inbox.chat_message_id")) {
        return reply.code(200).send({ inbox_id: null, dedup: true });
      }
      throw e;
    }
    registryRecord({
      source: "agent_inbox",
      trigger: "POST /api/agent-inbox/enqueue",
      toUserId: to,
      data: { inbox_id, chat_message_id: body.chat_message_id, task_id: body.task_id, kind, event_type: eventType },
      result: "inbox_sent",
    });
    const chosen = routed === fromUser
      ? { id: routed, title: "self (fallback)" }
      : Object.entries(catalog.profiles).find(([, p]) => p.id === routed)?.[1]
        ?? { id: routed, title: routed };
    const basis = explicitTo && explicitTo !== fromUser
      ? "explicit_addressee"
      : (routed === fromUser ? "self" : "fallback_orchestrator");
    return reply.code(201).send({
      inbox_id, to, event_type: eventType, kind,
      routed_to: { id: chosen.id, title: chosen.title },
      basis,
    });
  });

  // GET /api/agent-inbox/pending — для агента получить свои непринятые.
  app.get<{ Querystring: { to_user_id?: string } }>("/api/agent-inbox/pending", { preHandler: authOrApiToken }, async (req: any, reply) => {
    // Только свой inbox: адресат обязан совпадать с вызывающим, иначе агент
    // читал бы чужие поручения (Reviewer 5f292e87: pending не сверяет адресата).
    const to = req.query?.to_user_id || req.userId;
    if (to !== req.userId) return reply.code(403).send({ error: "можно читать только свой inbox" });
    const rows = db.prepare(
      `SELECT id, chat_message_id, to_user_id, body_text, task_id, task_version, kind,
              event_type, status, created_at
         FROM agent_inbox
        WHERE to_user_id = ? AND status = 'sent'
        ORDER BY created_at ASC
        LIMIT 50`
    ).all(to);
    return reply.send({ items: rows });
  });

  // POST /api/agent-inbox/:id/mark — перевести статус. Проверяет версию
  // карточки и тихо отбрасывает устаревшие события.
  app.post<{
    Params: { id: string };
    Body: { status: "received" | "acting" | "done" | "blocked";
            blocked_reason?: string }
  }>("/api/agent-inbox/:id/mark", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const id = req.params?.id;
    if (!id) return reply.code(400).send({ error: "id обязателен" });

    const newStatus = (req.body ?? {}).status;
    if (!["received", "acting", "done", "blocked"].includes(newStatus)) {
      return reply.code(400).send({ error: "status должен быть received/acting/done/blocked" });
    }

    const row = db.prepare("SELECT * FROM agent_inbox WHERE id = ?").get(id) as any;
    if (!row) return reply.code(404).send({ error: "not found" });
    // Поручение чужое — не трогаем (Reviewer 5f292e87: mark не сверяет адресата).
    if (row.to_user_id !== req.userId) {
      return reply.code(403).send({ error: "это поручение не для вас" });
    }

    // Защита от устаревших событий: проверка версии карточки.
    if (row.task_id) {
      const task = getTaskForWrite(row.task_id, req.userId);
      if (task) {
        const currentVersion = (task as any).current_revision ?? null;
        if (currentVersion != null && row.task_version != null && row.task_version < currentVersion) {
          // Устаревшее событие — тихо отбрасываем.
          db.prepare(
            `UPDATE agent_inbox SET status = 'blocked', blocked_reason = ?
              WHERE id = ?`
          ).run(`устаревшее событие (rev ${row.task_version} < ${currentVersion})`, id);
          registryRecord({
            source: "agent_inbox",
            trigger: "POST /api/agent-inbox/:id/mark",
            toUserId: row.to_user_id,
            data: { inbox_id: id, task_id: row.task_id, event_type: row.event_type },
            result: "blocked",
            error: `устаревшее событие (rev ${row.task_version} < ${currentVersion})`,
          });
          return reply.code(200).send({ id, status: "blocked", dropped: true });
        }
      }
    }

    // Только соседние переходы (Review 07.09.2026): успех идёт строго по
    // цепочке sent → received → acting → done, без перескоков (sent →
    // acting/done и received → done запрещены). blocked — конечное «не
    // вышло»: в него можно упасть из любого неконечного статуса (сбой
    // запуска, устаревшее событие), из него и из done выхода нет.
    const NEXT: Record<string, string[]> = {
      sent: ["received", "blocked"],
      received: ["acting", "blocked"],
      acting: ["done", "blocked"],
      done: [],
      blocked: [],
    };
    if (!(NEXT[row.status] ?? []).includes(newStatus)) {
      return reply.code(409).send({
        error: "переход назад запрещён: только соседние статусы вперёд",
        from: row.status,
        to: newStatus,
      });
    }

    const tsColumn = newStatus === "received" ? "received_at"
      : newStatus === "acting" ? "acting_at"
      : newStatus === "done" ? "done_at" : null;
    const sets = ["status = ?"];
    const params: any[] = [newStatus];
    if (tsColumn) sets.push(`${tsColumn} = datetime('now')`);
    if (newStatus === "blocked") {
      sets.push("blocked_reason = ?");
      params.push((req.body ?? {}).blocked_reason || "");
    }
    // Атомарный UPDATE с ожидаемым статусом: если соседний процесс уже
    // поменял статус (повторная доставка, гонка двух сессий), WHERE не
    // сойдётся — отдадим 409, а не перезапишем чужой переход.
    params.push(id, row.status);
    const updated = db
      .prepare(`UPDATE agent_inbox SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...params);
    if (updated.changes === 0) {
      return reply.code(409).send({
        error: "статус уже изменился (гонка), перечитайте событие",
        from: row.status,
      });
    }

    registryRecord({
      source: "agent_inbox",
      trigger: "POST /api/agent-inbox/:id/mark",
      toUserId: row.to_user_id,
      data: { inbox_id: id, task_id: row.task_id, event_type: row.event_type },
      result: newStatus,
    });
    return reply.send({ id, status: newStatus });
  });

  // GET /api/agent-inbox/registry — читаемый реестр диспетчеризации
  // (режим наблюдения, карточка 5f292e87).
  app.get<{ Querystring: { limit?: string } }>("/api/agent-inbox/registry", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    const rows = db.prepare(
      `SELECT id, source, trigger, to_user_id, data, result, error, created_at
         FROM dispatch_registry
        ORDER BY created_at DESC
        LIMIT ?`
    ).all(limit);
    return reply.send({ items: rows });
  });
}