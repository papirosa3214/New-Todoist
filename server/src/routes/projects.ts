import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db, { hashApiToken } from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getProjectForUser, getLabelForUser, visibleScope } from "../access.js";

const uid = () => crypto.randomUUID();

export function registerProjectLabelRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Projects ──
  app.get("/api/projects", { preHandler: authPre }, async (req: any) => {
    // Считаются только АКТИВНЫЕ задачи. Раньше считались все, вместе с
    // выполненными, и число рядом с проектом расходилось с тем, что
    // человек видит, провалившись внутрь: «Входящие — 10», а в списке
    // три (7 из них давно закрыты). Найдено Максимом 14.08.2026.
    // Экран проекта (ProjectTasksScreen) показывает именно активные —
    // счётчик обязан отвечать на тот же вопрос, что и экран под ним.
    const countSql = `(SELECT COUNT(*) FROM tasks
                        WHERE project_id = p.id AND status = 'active') as task_count`;

    // Кому какие проекты видны — общее правило из access.ts (visibleScope):
    // владельцу все, агенту свои и людские, прочему человеку только свои.
    //
    // Решение Максима 14.08.2026: «это его личный трекер, один человек и его
    // же агенты — стена между ними смысла не имеет». Раньше агенту отдавался
    // пустой список, хотя положить задачу в проект человека он был вправе, —
    // приходилось угадывать идентификатор проекта.
    const scope = visibleScope(req.userId, "p.owner_id");
    return db
      .prepare(`SELECT p.*, ${countSql} FROM projects p WHERE ${scope.sql}`)
      .all(...scope.params);
  });

  app.post<{ Body: { name: string; color?: string } }>("/api/projects", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название проекта" });
      }
      const id = uid();
      const { color } = req.body;
      db.prepare(
        "INSERT INTO projects (id, name, color, owner_id) VALUES (?,?,?,?)",
      ).run(id, name, color || "#4A9FD8", req.userId);
      return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    },
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; color?: string };
  }>("/api/projects/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const project = getProjectForUser(req.params.id, req.userId);
      if (!project) return reply.code(404).send({ error: "Not found" });

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название проекта" });
      }
      const color = req.body?.color || project.color;
      db.prepare("UPDATE projects SET name = ?, color = ? WHERE id = ?").run(
        name,
        color,
        req.params.id,
      );
      return db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const project = getProjectForUser(req.params.id, req.userId);
      if (!project) return reply.code(404).send({ error: "Not found" });

      db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );

  // ── Labels ──
  app.get("/api/labels", { preHandler: authPre }, async (req: any) => {
    // Та же видимость, что и у проектов (visibleScope в access.ts): метки
    // ставит владелец, а агент лишь пользуется его метками.
    const scope = visibleScope(req.userId, "owner_id");
    return db
      .prepare(`SELECT * FROM labels WHERE ${scope.sql}`)
      .all(...scope.params);
  });

  app.post<{ Body: { name: string; color?: string } }>("/api/labels", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название метки" });
      }
      const id = uid();
      const { color } = req.body;
      db.prepare(
        "INSERT INTO labels (id, name, color, owner_id) VALUES (?,?,?,?)",
      ).run(id, name, color || "#FF7A8A", req.userId);
      return db.prepare("SELECT * FROM labels WHERE id = ?").get(id);
    },
  });

  app.patch<{
    Params: { id: string };
    Body: { name?: string; color?: string };
  }>("/api/labels/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const label = getLabelForUser(req.params.id, req.userId);
      if (!label) return reply.code(404).send({ error: "Not found" });

      const name =
        typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "Укажите название метки" });
      }
      const color = req.body?.color || label.color;
      db.prepare("UPDATE labels SET name = ?, color = ? WHERE id = ?").run(
        name,
        color,
        req.params.id,
      );
      return db.prepare("SELECT * FROM labels WHERE id = ?").get(req.params.id);
    },
  });

  app.delete<{ Params: { id: string } }>(
    "/api/labels/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const label = getLabelForUser(req.params.id, req.userId);
      if (!label) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM task_labels WHERE label_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM labels WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );

  // ── Agents (users) ── directory used for the assignee picker. Scoped to
  // the caller's own account, the seeded system bots (is_system_bot = 1 —
  // set only by seed/migration, never reachable via /api/auth/register, so
  // an open registration can't self-mint a fake "system bot"), plus anyone
  // they already share a task with (as creator or assignee) — not the whole
  // user table, so an arbitrary freshly-registered account can't enumerate
  // every human on the system. System bots are visible to everyone because
  // assigning a task to one is how a new user forms their first connection.
  // Email is intentionally never selected: the frontend doesn't use it
  // (see src/screens/AgentsScreen.tsx, src/screens/TaskFormScreen.tsx).
  app.get("/api/agents", { preHandler: authPre }, async (req: any) => {
    return db
      .prepare(
        `SELECT id, name, role, type, avatar_color, avatar_url, initials, status
         FROM users
         WHERE is_system_bot = 1
            OR id = ?
            OR created_by = ?
            OR id IN (
              SELECT assignee_id FROM tasks WHERE creator_id = ? AND assignee_id IS NOT NULL
              UNION
              SELECT creator_id FROM tasks WHERE assignee_id = ? AND creator_id IS NOT NULL
            )`,
      )
      .all(req.userId, req.userId, req.userId, req.userId);
  });

  // ── Завести агента ── кнопка «Пригласить агента» на экране агентов.
  // Приглашения по почте на этой машине быть не может (SMTP не настроен), да
  // и агент — не человек с ящиком: «пригласить» здесь значит завести учётку
  // и выдать ключ доступа. Ключ показывается РОВНО ОДИН раз, в ответе на это
  // создание: в базе он лежит как есть, но наружу больше не отдаётся ни
  // одним маршрутом (/api/agents и /api/auth/me его вырезают).
  //
  // Кто может: только человек. Агенту незачем плодить себе подобных, а
  // украденный ключ агента иначе стал бы способом наделать учёток.
  app.post<{ Body: { name?: string } }>(
    "/api/agents",
    { preHandler: authPre },
    async (req: any, reply) => {
      const caller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      if (caller?.type === "ai") {
        return reply
          .code(403)
          .send({ error: "агент не может заводить других агентов" });
      }

      const name = (req.body?.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "нужно имя агента" });

      // Почта у агента техническая и наружу не показывается (см. /api/agents),
      // но колонка обязательна и уникальна — собираем из имени, а при
      // совпадении отвечаем понятной ошибкой, а не «UNIQUE constraint failed».
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-zа-я0-9]+/gi, "-")
          .replace(/^-|-$/g, "") || "agent";
      const email = `${slug}@taskflow.local`;
      const exists = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email);
      if (exists) {
        return reply
          .code(409)
          .send({ error: "агент с таким именем уже заведён" });
      }

      const id = uid();
      const apiToken = "tf_" + crypto.randomBytes(32).toString("hex");
      // Вход по паролю агенту не нужен — он ходит по ключу. Но колонка
      // обязательна, поэтому кладём заведомо непригодный хеш: подобрать к
      // нему пароль нельзя, а значит учётка не имеет второго входа.
      const unusablePassword = "!" + crypto.randomBytes(24).toString("hex");
      const initials = name.trim().charAt(0).toUpperCase();
      db.prepare(
        `INSERT INTO users (id, name, email, password_hash, role, type, avatar_color, avatar_url, initials, status, api_token, is_system_bot, created_by)
         VALUES (?, ?, ?, ?, 'agent', 'ai', '#A78BFA', ?, 'offline', ?, 0, ?)`,
        // В базу кладём ОТПЕЧАТОК ключа. Сам ключ уходит в ответе ниже и
        // больше нигде не хранится: показать его повторно невозможно, только
        // выпустить новый. Так утечка файла базы не даёт доступа агента.
      ).run(
        id,
        name,
        email,
        unusablePassword,
        initials,
        hashApiToken(apiToken),
        req.userId,
      );

      const agent = db
        .prepare(
          "SELECT id, name, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
        )
        .get(id);
      return reply.code(201).send({ agent, api_token: apiToken });
    },
  );
}
