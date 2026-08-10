import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";

const uid = () => crypto.randomUUID();

export function registerProjectLabelRoutes(app: FastifyInstance) {
  const authPre = async (req: any, reply: any) => {
    try {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return reply.code(401).send({ error: "No token" });
      req.userId = app.jwt.verify(token).id;
    } catch { reply.code(401).send({ error: "Invalid token" }); }
  };

  // ── Projects ──
  app.get("/api/projects", { preHandler: authPre }, async (req: any) => {
    return db.prepare(
      "SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count FROM projects p WHERE p.owner_id = ?",
    ).all(req.userId);
  });

  app.post<{ Body: { name: string; color?: string } }>("/api/projects", {
    preHandler: authPre,
    handler: async (req: any) => {
      const id = uid();
      const { name, color } = req.body;
      db.prepare("INSERT INTO projects (id, name, color, owner_id) VALUES (?,?,?,?)").run(id, name, color || "#4A9FD8", req.userId);
      return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    },
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", { preHandler: authPre }, async (req) => {
    db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run(req.params.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  // ── Labels ──
  app.get("/api/labels", { preHandler: authPre }, async (req: any) => {
    return db.prepare("SELECT * FROM labels WHERE owner_id = ?").all(req.userId);
  });

  app.post<{ Body: { name: string; color?: string } }>("/api/labels", {
    preHandler: authPre,
    handler: async (req: any) => {
      const id = uid();
      const { name, color } = req.body;
      db.prepare("INSERT INTO labels (id, name, color, owner_id) VALUES (?,?,?,?)").run(id, name, color || "#FF7A8A", req.userId);
      return db.prepare("SELECT * FROM labels WHERE id = ?").get(id);
    },
  });

  app.delete<{ Params: { id: string } }>("/api/labels/:id", { preHandler: authPre }, async (req) => {
    db.prepare("DELETE FROM task_labels WHERE label_id = ?").run(req.params.id);
    db.prepare("DELETE FROM labels WHERE id = ?").run(req.params.id);
    return { ok: true };
  });

  // ── Agents (users) ──
  app.get("/api/agents", { preHandler: authPre }, async () => {
    return db.prepare(
      "SELECT id, name, email, role, type, avatar_color, initials, status FROM users",
    ).all();
  });
}
