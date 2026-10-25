import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { isServiceUser } from "./agent-state.js";

const uid = () => crypto.randomUUID();

export function registerNotificationRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // GET /api/system-state?from=<ISO начала дня клиента> — сводка «Состояние
  // системы» (владелец 12.10.2026): поломки за день и все ещё не починенные,
  // починено или нет, кто работал и сколько. Источник — служебные карточки
  // починки (incidents.ts). Только владельцу.
  app.get("/api/system-state", { preHandler: authPre }, async (req: any, reply) => {
    if (!isOwner(req.userId)) {
      return reply.code(403).send({ error: "состояние системы доступно только владельцу" });
    }
    const raw = typeof req.query.from === "string" ? req.query.from : "";
    const parsed = raw ? new Date(raw) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    if (Number.isNaN(parsed.getTime())) return reply.code(400).send({ error: "from: ожидается дата ISO" });
    const from = parsed.toISOString();

    const rows = db
      .prepare(
        `SELECT t.id, t.incident_key, t.title, t.status, t.agent_state, t.created_at, t.completed_at,
                u.name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.incident_key IS NOT NULL AND t.archived_at IS NULL
            AND (t.status = 'active'
                 OR datetime(t.created_at) >= datetime(?)
                 OR datetime(t.completed_at) >= datetime(?))
          ORDER BY (t.status = 'active') DESC, t.created_at DESC`,
      )
      .all(from, from) as Array<{
        id: string; incident_key: string; title: string; status: string; agent_state: string | null;
        created_at: string; completed_at: string | null; assignee_name: string | null;
      }>;

    // Время работы — по заходам исполнителей. У незавершённого захода конец
    // берём по последнему признаку жизни, а не «сейчас»: зависший заход не
    // должен рисовать часы работы, которой не было.
    const workStmt = db.prepare(
      `SELECT a.executor_id AS id, COALESCE(x.name, a.executor_id) AS name,
              CAST(SUM(MAX(0, (julianday(COALESCE(a.ended_at, a.heartbeat_at, a.started_at))
                               - julianday(a.started_at)) * 86400)) AS INTEGER) AS seconds
         FROM attempts a LEFT JOIN users x ON x.id = a.executor_id
        WHERE a.task_id = ?
        GROUP BY a.executor_id`,
    );
    const totals = new Map<string, { id: string; name: string; seconds: number }>();
    const incidents = rows.map((r) => {
      const workers = workStmt.all(r.id) as Array<{ id: string; name: string; seconds: number }>;
      for (const w of workers) {
        const t = totals.get(w.id) ?? { id: w.id, name: w.name, seconds: 0 };
        t.seconds += w.seconds;
        totals.set(w.id, t);
      }
      return {
        id: r.id,
        key: r.incident_key,
        title: r.title,
        fixed: r.status !== "active",
        state: r.agent_state,
        assignee_name: r.assignee_name,
        created_at: r.created_at,
        completed_at: r.completed_at,
        work_seconds: workers.reduce((n, w) => n + w.seconds, 0),
        workers,
      };
    });
    const open = incidents.filter((i) => !i.fixed).length;

    // Закрытые (архивные) поломки — владелец 20.10.2026: карточка починки
    // ушла в архив, значит поломка закрыта и её запись обязана исчезнуть из
    // «Состояния системы». Сами архивные поломки в `incidents` не попадают
    // (`t.archived_at IS NULL`), но клиенту нужно знать, КАКИЕ ключи и
    // карточки закрыты: строка проверки из суточной сводки сторожей
    // привязывается к поломке по `incident_key` или по id карточки, и без
    // этого списка клиент не может убрать такую строку.
    //
    // Ограничение 200 — защита от бесконечного роста ответа: поломки
    // случаются редко, а свежие закрытые нужны в первую очередь.
    const closed = db
      .prepare(
        `SELECT id, incident_key AS key FROM tasks
          WHERE incident_key IS NOT NULL AND archived_at IS NOT NULL
          ORDER BY archived_at DESC
          LIMIT 200`,
      )
      .all() as Array<{ id: string; key: string }>;

    return {
      from,
      counts: {
        total: incidents.length,
        open,
        fixed: incidents.length - open,
        in_work: incidents.filter((i) => !i.fixed && (i.assignee_name || i.work_seconds > 0)).length,
      },
      incidents,
      closed,
      workers: [...totals.values()].sort((a, b) => b.seconds - a.seconds),
    };
  });

  // POST /api/notifications — служебная дверь для планировщика (шаг 5).
  // Только service user. Создаёт уведомление для указанного user_id
  // (как правило, владельца) с типом task_dead и текстом причины.
  app.post<{
    Body: {
      user_id: string;
      type: string;
      task_id?: string;
      text: string;
      actor_id?: string;
    };
  }>("/api/notifications", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      if (!isServiceUser(req.userId)) {
        return reply.code(403).send({
          error:
            "создавать уведомления через API может только служебный ключ",
        });
      }
      const { user_id, type, task_id, text, actor_id } = req.body || {};
      if (typeof user_id !== "string" || !user_id) {
        return reply.code(400).send({ error: "user_id обязателен" });
      }
      if (typeof type !== "string" || !type) {
        return reply.code(400).send({ error: "type обязателен" });
      }
      if (typeof text !== "string" || !text.trim()) {
        return reply.code(400).send({ error: "text обязателен" });
      }
      const id = uid();
      db.prepare(
        `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        user_id,
        type,
        task_id ?? null,
        text.trim(),
        actor_id ?? null,
      );
      const inserted = db.prepare("SELECT id FROM notifications WHERE id=?").get(id);
      return inserted ? reply.code(201).send({ id }) : reply.code(200).send({ suppressed: true });
    },
  });

  app.get("/api/notifications", { preHandler: authPre }, async (req: any) => {
    // Приватный проект (задача 9d583c58…) и архивный проект (карточка
    // a1be7d63…) не должны утекать через task_title: уведомление со
    // ссылкой на задачу такого проекта не отдаётся никому, кроме
    // владельца (приватность). Архивное не отдаём и владельцу — для него
    // есть отдельные ручки Архива.
    const privacyClause = isOwner(req.userId)
      ? "(t.id IS NULL OR p.id IS NULL OR p.archived_at IS NULL)"
      : "(t.id IS NULL OR p.id IS NULL OR (p.is_private = 0 OR p.is_private IS NULL) AND p.archived_at IS NULL)";
    // `?unread=true` — только непрочитанные. Необязательный параметр:
    // клиент без него получает полный список, как раньше (старые сборки
    // не ломаются). Нужен телефону: лента уведомлений весит ~463 КБ
    // (61 КБ в gzip), а на старте и при переподключении клиенту достаточно
    // счётчика непрочитанных, а не всей ленты.
    const unreadOnly = req.query?.unread === "true" || req.query?.unread === "1";
    const unreadClause = unreadOnly ? "AND n.read = 0" : "";
    return db
      .prepare(
        `
      SELECT n.*, u.name as user_name, u.avatar_color as user_color, u.initials as user_initials,
             t.title as task_title,
             a.id as actor_id, a.name as actor_name, a.initials as actor_initials, a.avatar_color as actor_color, a.avatar_url as actor_avatar_url
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      LEFT JOIN tasks t ON n.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN users a ON n.actor_id = a.id
      WHERE n.user_id = ? AND ${privacyClause}
        ${unreadClause}
        AND (n.task_id IS NULL OR t.archived_at IS NULL)
        AND NOT (n.type IN ('assigned','commented','reviewed','agent_state') AND EXISTS (SELECT 1 FROM users owner WHERE owner.id=n.user_id AND owner.role='owner'))
      ORDER BY n.created_at DESC
    `,
      )
      .all(req.userId);
  });

  app.post(
    "/api/notifications/read-all",
    { preHandler: authPre },
    async (req: any) => {
      db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(
        req.userId,
      );
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    { preHandler: authPre },
    async (req: any, reply) => {
      const result = db
        .prepare(
          "UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?",
        )
        .run(req.params.id, req.userId);
      if (result.changes === 0)
        return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/notifications/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const result = db
        .prepare("DELETE FROM notifications WHERE id = ? AND user_id = ?")
        .run(req.params.id, req.userId);
      if (result.changes === 0)
        return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );
}
