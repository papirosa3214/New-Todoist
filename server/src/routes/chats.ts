// Чаты с ролями-агентами (владелец 21.09.2026, план
// docs/superpowers/plans/2026-09-21-chat-online-pi-runtime.md, этап 1).
//
// Чат — отдельная сущность, которую создаёт пользователь: персональный (одна
// роль) или групповой (несколько ролей). Это НЕ старые каналы owner/agents —
// те живут как были; чаты аддитивны (миграция 053).
//
// Здесь только «скелет»: создание чата, участники, история, отправка сообщения
// в ленту чата. Живой ответ рантайма Пи (онлайн-сессия) — следующий этап; пока
// сообщение просто ложится в чат и рассылается участникам по WS.
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { broadcastToUsers } from "../ws.js";

const uid = () => crypto.randomUUID();

type ChatKind = "direct" | "group";
const KINDS: ChatKind[] = ["direct", "group"];

function memberIds(chatId: string): string[] {
  return (
    db
      .prepare("SELECT member_id FROM chat_members WHERE chat_id = ?")
      .all(chatId) as Array<{ member_id: string }>
  ).map((r) => r.member_id);
}

function isMember(chatId: string, userId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND member_id = ?")
    .get(chatId, userId);
}

function chatRow(chatId: string) {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as
    | { id: string; title: string | null; kind: ChatKind; created_by: string; task_id: string | null; created_at: string; updated_at: string }
    | undefined;
  if (!chat) return null;
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.role, u.type, u.avatar_color, u.avatar_url, u.initials
         FROM chat_members cm JOIN users u ON u.id = cm.member_id
        WHERE cm.chat_id = ? ORDER BY cm.added_at`,
    )
    .all(chatId);
  return { ...chat, members };
}

export async function registerChatsRoutes(app: FastifyInstance): Promise<void> {
  const authPre = authOrApiToken;

  // Создать чат. member_ids — роли-агенты (или любые существующие учётки).
  // Создатель добавляется участником автоматически: он — сторона разговора.
  app.post<{
    Body: { title?: string; kind?: string; member_ids?: string[]; task_id?: string | null };
  }>("/api/chats", { preHandler: authPre }, async (req: any, reply) => {
    const kind = (req.body?.kind || "group") as ChatKind;
    if (!KINDS.includes(kind))
      return reply.code(400).send({ error: `kind должен быть: ${KINDS.join(", ")}` });

    const requested = Array.isArray(req.body?.member_ids)
      ? req.body!.member_ids.filter((m: unknown) => typeof m === "string" && m)
      : [];
    if (kind === "direct" && requested.length !== 1)
      return reply.code(400).send({ error: "персональный чат — ровно один участник" });
    if (requested.length === 0)
      return reply.code(400).send({ error: "нужен хотя бы один участник" });

    // Все участники должны существовать. Создателя тоже включаем в состав.
    const all = [...new Set([req.userId, ...requested])];
    const placeholders = all.map(() => "?").join(",");
    const found = (
      db.prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...all) as Array<{ id: string }>
    ).map((r) => r.id);
    const missing = all.filter((id) => !found.includes(id));
    if (missing.length)
      return reply.code(400).send({ error: `нет таких участников: ${missing.join(", ")}` });

    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : null;
    const taskId = req.body?.task_id || null;
    if (taskId) {
      const t = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
      if (!t) return reply.code(400).send({ error: "нет такой задачи" });
    }

    const id = uid();
    const txn = db.transaction(() => {
      db.prepare(
        `INSERT INTO chats (id, title, kind, created_by, task_id) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, title, kind, req.userId, taskId);
      const ins = db.prepare(
        "INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?)",
      );
      for (const m of all) ins.run(id, m);
    });
    txn();

    return { chat: chatRow(id) };
  });

  // Мои чаты: где я участник. С превью последнего сообщения.
  app.get("/api/chats", { preHandler: authPre }, async (req: any) => {
    const rows = db
      .prepare(
        `SELECT c.* FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id
          WHERE cm.member_id = ?
          ORDER BY c.updated_at DESC`,
      )
      .all(req.userId) as Array<{ id: string }>;
    return {
      chats: rows.map((c) => {
        const last = db
          .prepare(
            `SELECT text, created_at, from_user_id FROM chat_messages
              WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(c.id);
        return { ...chatRow(c.id), last_message: last ?? null };
      }),
    };
  });

  // Один чат с участниками. Доступ — только участнику.
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      return { chat: chatRow(req.params.id) };
    },
  );

  // История сообщений чата (по возрастанию времени).
  app.get<{ Params: { id: string } }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const messages = db
        .prepare(
          `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
                  f.avatar_url as from_user_avatar_url, f.initials as from_user_initials
             FROM chat_messages m
             LEFT JOIN users f ON f.id = m.from_user_id
            WHERE m.chat_id = ? ORDER BY m.created_at ASC`,
        )
        .all(req.params.id);
      return { messages };
    },
  );

  // Сообщение в чат. Пока просто ложится в ленту и рассылается участникам;
  // живой ответ роли — следующий этап.
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/api/chats/:id/messages",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isMember(req.params.id, req.userId))
        return reply.code(404).send({ error: "Чат не найден" });
      const text = String(req.body?.text || "").trim();
      if (!text) return reply.code(400).send({ error: "пустое сообщение" });

      const id = uid();
      db.prepare(
        `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id)
         VALUES (?, ?, ?, 'chat', ?)`,
      ).run(id, req.userId, text, req.params.id);
      db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(
        req.params.id,
      );

      const message = db
        .prepare(
          `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
                  f.avatar_url as from_user_avatar_url, f.initials as from_user_initials
             FROM chat_messages m
             LEFT JOIN users f ON f.id = m.from_user_id
            WHERE m.id = ?`,
        )
        .get(id);

      const audience = memberIds(req.params.id).filter((m) => m !== req.userId);
      broadcastToUsers([...audience, req.userId], {
        type: "chat:new",
        message,
      });
      return { message };
    },
  );

  // Добавить участника (создатель чата).
  app.post<{ Params: { id: string }; Body: { member_id?: string } }>(
    "/api/chats/:id/members",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "менять участников может создатель чата" });
      const memberId = String(req.body?.member_id || "").trim();
      if (!memberId) return reply.code(400).send({ error: "нужен member_id" });
      if (!db.prepare("SELECT id FROM users WHERE id = ?").get(memberId))
        return reply.code(400).send({ error: "нет такого участника" });
      db.prepare(
        "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)",
      ).run(req.params.id, memberId);
      return { chat: chatRow(req.params.id) };
    },
  );

  // Убрать участника (создатель чата; себя убрать нельзя).
  app.delete<{ Params: { id: string; memberId: string } }>(
    "/api/chats/:id/members/:memberId",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "менять участников может создатель чата" });
      if (req.params.memberId === req.userId)
        return reply.code(400).send({ error: "себя из чата не убрать" });
      db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND member_id = ?").run(
        req.params.id,
        req.params.memberId,
      );
      return { chat: chatRow(req.params.id) };
    },
  );

  // Удалить чат (создатель). Сообщения уходят каскадом (chat_messages.chat_id).
  app.delete<{ Params: { id: string } }>(
    "/api/chats/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const chat = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(req.params.id) as
        | { created_by: string }
        | undefined;
      if (!chat) return reply.code(404).send({ error: "Чат не найден" });
      if (chat.created_by !== req.userId)
        return reply.code(403).send({ error: "удалить чат может создатель" });
      db.prepare("DELETE FROM chats WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );
}
