import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET || "taskflow-dev-secret-2026";

function uid(): string {
  return crypto.randomUUID();
}

export function registerAuthRoutes(app: FastifyInstance) {
  // ═══════ REGISTER ═══════
  app.post<{ Body: { name: string; email: string; password: string; role?: string; type?: string } }>(
    "/api/auth/register",
    async (req, reply) => {
      const { name, email, password, role = "agent", type = "human" } = req.body;
      if (!name || !email || !password) {
        return reply.code(400).send({ error: "name, email, password required" });
      }
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) return reply.code(409).send({ error: "Email already registered" });

      const id = uid();
      const hash = bcrypt.hashSync(password, 10);
      const initials = name.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
      const colors = ["#35B8A3", "#A78BFA", "#FF9A14", "#E44332", "#4A9FD8", "#FF7A8A"];
      const color = colors[Math.floor(Math.random() * colors.length)];

      db.prepare(
        "INSERT INTO users (id, name, email, password_hash, role, type, avatar_color, initials) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, name, email, hash, role, type, color, initials);

      const token = app.jwt.sign({ id }, { expiresIn: "30d" });
      const user = db.prepare("SELECT id, name, email, role, type, avatar_color, initials, status FROM users WHERE id = ?").get(id);
      return { token, user };
    },
  );

  // ═══════ LOGIN ═══════
  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    async (req, reply) => {
      const { email, password } = req.body;
      if (!email || !password) return reply.code(400).send({ error: "email, password required" });

      const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = app.jwt.sign({ id: user.id }, { expiresIn: "30d" });
      const { password_hash, ...safe } = user;
      return { token, user: safe };
    },
  );

  // ═══════ ME ═══════
  app.get("/api/auth/me", {
    preHandler: async (req: any, reply) => {
      try {
        const token = req.headers.authorization?.replace("Bearer ", "");
        if (!token) return reply.code(401).send({ error: "No token" });
        req.userId = app.jwt.verify(token).id;
      } catch {
        reply.code(401).send({ error: "Invalid token" });
      }
    },
    handler: async (req: any) => {
      const user = db.prepare(
        "SELECT id, name, email, role, type, avatar_color, initials, status FROM users WHERE id = ?",
      ).get(req.userId);
      return { user };
    },
  });
}

export { JWT_SECRET };
