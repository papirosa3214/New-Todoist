import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getProjectForUser, getLabelForUser } from "../access.js";

const uid = () => crypto.randomUUID();

export function registerProjectLabelRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ── Projects ──
  app.get("/api/projects", { preHandler: authPre }, async (req: any) => {
    return db
      .prepare(
        "SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count FROM projects p WHERE p.owner_id = ?",
      )
      .all(req.userId);
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
    return db
      .prepare("SELECT * FROM labels WHERE owner_id = ?")
      .all(req.userId);
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
        `SELECT id, name, role, type, avatar_color, initials, status
         FROM users
         WHERE is_system_bot = 1
            OR id = ?
            OR id IN (
              SELECT assignee_id FROM tasks WHERE creator_id = ? AND assignee_id IS NOT NULL
              UNION
              SELECT creator_id FROM tasks WHERE assignee_id = ? AND creator_id IS NOT NULL
            )`,
      )
      .all(req.userId, req.userId, req.userId);
  });
}
