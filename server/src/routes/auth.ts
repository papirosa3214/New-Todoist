import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db, { hashApiToken } from "../db.js";
import { authMiddleware, authOrApiToken } from "../auth.js";

function generateApiToken(): string {
  return "tf_" + crypto.randomBytes(32).toString("hex");
}

function uid(): string {
  return crypto.randomUUID();
}

// Общий ключ для лимита логина/регистрации: IP + email из тела запроса.
// Чистый IP не годится — это домашний LAN, у Максима с телефона и агентов
// с сервера один и тот же адрес (или localhost), и лимит по IP запирал бы
// всех разом. Email в паре сужает лимит до конкретной учётки, которую
// подбирают, не трогая остальных.
function loginRateLimitKey(req: any): string {
  const email =
    typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
  return `${req.ip}:${email}`;
}

export function registerAuthRoutes(app: FastifyInstance) {
  // ═══════ REGISTER ═══════
  app.post<{
    Body: {
      name: string;
      email: string;
      password: string;
      // Accepted but deliberately ignored below — registration is open, and
      // trusting client-supplied role/type let anyone self-grant
      // role:"owner" or type:"ai" (privilege escalation + impersonating a
      // system agent). Every self-registered account is a plain human user;
      // "system bot" is a separate, server-only flag (users.is_system_bot)
      // that registration can never set.
      role?: string;
      type?: string;
    };
  }>(
    "/api/auth/register",
    {
      // Регистрация тоже незащищённая: без лимита её можно использовать
      // для перебора занятых email (409 против общей ошибки) или для спама
      // учётками. Порог мягче, чем у логина — заводить агента/аккаунт
      // руками штука редкая, но не разовая.
      //
      // hook: 'preHandler' — ОБЯЗАТЕЛЬНО. По умолчанию @fastify/rate-limit
      // вешается на onRequest, который срабатывает ДО разбора тела запроса:
      // req.body там ещё undefined, keyGenerator получал бы пустой email
      // для любого запроса, и лимит по факту считался бы только по IP —
      // ровно то, от чего предостерегает комментарий у loginRateLimitKey.
      // Проверено 15.08.2026: без hook пятая неудачная попытка логина под
      // одним email блокировала следующую попытку под ДРУГИМ email с того
      // же IP — то есть общий, а не персональный лимит.
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: loginRateLimitKey,
        },
      },
    },
    async (req, reply) => {
      const { name, email, password } = req.body;
      const role = "agent";
      const type = "human";
      if (!name || !email || !password) {
        return reply
          .code(400)
          .send({ error: "name, email, password required" });
      }
      const existing = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email);
      if (existing)
        return reply.code(409).send({ error: "Email already registered" });

      const id = uid();
      const hash = bcrypt.hashSync(password, 10);
      const initials = name
        .split(" ")
        .map((w: string) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
      const colors = [
        "#35B8A3",
        "#A78BFA",
        "#FF9A14",
        "#E44332",
        "#4A9FD8",
        "#FF7A8A",
      ];
      const color = colors[Math.floor(Math.random() * colors.length)];

      db.prepare(
        "INSERT INTO users (id, name, email, password_hash, role, type, avatar_color, initials) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, name, email, hash, role, type, color, initials);

      const token = app.jwt.sign({ id }, { expiresIn: "30d" });
      const user = db
        .prepare(
          "SELECT id, name, email, role, type, avatar_color, initials, status FROM users WHERE id = ?",
        )
        .get(id);
      return { token, user };
    },
  );

  // ═══════ LOGIN ═══════
  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    {
      // Пять попыток в минуту на пару IP+email — перебор пароля этим не
      // остановить полностью, но замедляет на порядки, и не задевает
      // повседневные опечатки (Максим на телефоне и агенты логин не
      // используют вовсе, они на постоянном api_token — см. AGENT-API.md).
      // hook: 'preHandler' — см. развёрнутый комментарий у /api/auth/register:
      // без него keyGenerator видит пустой email и лимит фактически по IP.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: loginRateLimitKey,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      if (!email || !password)
        return reply.code(400).send({ error: "email, password required" });

      const user = db
        .prepare("SELECT * FROM users WHERE email = ?")
        .get(email) as any;
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = app.jwt.sign({ id: user.id }, { expiresIn: "30d" });
      // Strip both the password hash AND the agent api_token — this response
      // must never carry the same bearer secret the /api-token endpoint issues.
      const { password_hash, api_token, ...safe } = user;
      return { token, user: safe };
    },
  );

  // ═══════ ME ═══════
  // Accepts either a JWT or an api_token — lets agents verify their token
  // and fetch their own profile the same way the web frontend does.
  app.get("/api/auth/me", {
    preHandler: authOrApiToken,
    handler: async (req: any) => {
      const user = db
        .prepare(
          "SELECT id, name, email, role, type, avatar_color, initials, status FROM users WHERE id = ?",
        )
        .get(req.userId);
      return { user };
    },
  });

  // ═══════ API TOKEN (for agents) ═══════
  // Issues/rotates the caller's api_token. JWT-only on purpose: an api_token
  // must never be usable to mint another api_token.
  app.post("/api/auth/api-token", {
    preHandler: authMiddleware,
    handler: async (req: any) => {
      const token = generateApiToken();
      // В базу — только отпечаток; сам ключ возвращается вызывающему один
      // раз и больше нигде не хранится (см. hashApiToken в db.ts).
      db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(
        hashApiToken(token),
        req.userId,
      );
      return { api_token: token };
    },
  });
}
