import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db, { hashApiToken } from "../db.js";
import { authMiddleware, authOrApiToken, lanOwnerId } from "../auth.js";

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
  // ═══════ ВХОД БЕЗ ПАРОЛЯ ИЗ ДОМАШНЕЙ СЕТИ ═══════
  // Требование Максима 19.08.2026: «в своей домашней сети не хочу постоянно
  // вбивать пароли». Фронтенд дёргает этот маршрут, когда токена нет, и молча
  // получает сессию владельца — экран входа не показывается вовсе.
  //
  // Работает только при TASKFLOW_LAN_NO_AUTH=1 и только для приватных адресов
  // (проверка в lanOwnerId, заголовкам X-Forwarded-For не верим). Снаружи
  // маршрут отвечает 404, как будто его нет.
  app.post<{ Body?: never }>(
    "/api/auth/lan",
    {
      // iOS-клиент шлёт `Content-Type: application/json` с пустым телом `{}`
      // — без явного `Body: undefined` Fastify отвечает 400
      // "Body cannot be empty when content-type is set". Эндпоинт body не
      // использует, поэтому разрешаем пустой/отсутствующий body.
      schema: { body: undefined },
    },
    async (req, reply) => {
      const ownerId = lanOwnerId(req);
      if (!ownerId) return reply.code(404).send({ error: "Not found" });
      const user = db
        .prepare("SELECT id, name, email, role, type FROM users WHERE id = ?")
        .get(ownerId);
      const token = app.jwt.sign({ id: ownerId }, { expiresIn: "30d" });
      return { token, user };
    },
  );

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
      // Регистрация закрыта (18.08.2026, решение Максима). Трекер личный:
      // владелец один, агентов заводит он сам через POST /api/agents. Порт
      // при этом слушается на 0.0.0.0, то есть открытая форма позволяла
      // любому в локальной сети завести себе учётку — а с правилом доступа
      // по роли это ещё и лишний круг проверок в access.ts.
      //
      // Два исключения, оба узкие:
      //   • база без единого пользователя — первичная настройка, иначе в
      //     свежей установке некому было бы войти;
      //   • TASKFLOW_ALLOW_REGISTRATION=1 — осознанное временное открытие
      //     (им же пользуются тесты, см. server/test/setup.ts).
      const usersExist = db.prepare("SELECT id FROM users LIMIT 1").get();
      if (usersExist && process.env.TASKFLOW_ALLOW_REGISTRATION !== "1") {
        return reply.code(403).send({ error: "Регистрация закрыта" });
      }

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
        "INSERT INTO users (id, name, email, password_hash, role, type, avatar_color, avatar_url, initials) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(id, name, email, hash, role, type, color, null, initials);

      const token = app.jwt.sign({ id }, { expiresIn: "30d" });
      const user = db
        .prepare(
          "SELECT id, name, email, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
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

      // Поле называется email (так шлёт веб), но принимаем и ЛОГИН —
      // просьба Максима 01.09.2026: «можно не имейл, а просто логин».
      // Логином считается имя учётки («Максим») или короткое имя из почты
      // («maksim» для maksim@test.com) — отдельного поля в таблице для
      // этого не заводим, миграция ради одного человека не нужна.
      const identifier = String(email).trim();
      let user = db
        .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
        .get(identifier) as any;
      if (!user) {
        // Сравнение регистра — в JS, а не в SQL: sqlite-шный lower() знает
        // только латиницу, и «Логинов» под логином «логинов» не находился
        // (тест loginByUsername.test.ts ловит именно это). Учёток в трекере
        // единицы — полный проход дешевле, чем расширение сборки sqlite.
        const needle = identifier.toLowerCase();
        // Неоднозначность (две учётки с одинаковым именем или одинаковым
        // началом почты в разных доменах) — отказ, а не «первый попавшийся»:
        // иначе пароль одного человека открывал бы чужую запись.
        const candidates = (db.prepare("SELECT * FROM users").all() as any[]).filter(
          (candidate) =>
            String(candidate.name ?? "").toLowerCase() === needle ||
            String(candidate.email ?? "").toLowerCase().split("@")[0] === needle,
        );
        if (candidates.length === 1) user = candidates[0];
      }
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }
      // Учётка в архиве не входит (владелец 01.10.2026).
      if (user.archived) {
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
    handler: async (req: any, reply: any) => {
      const user = db
        .prepare(
          "SELECT id, name, email, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
        )
        .get(req.userId);
      // Токен разобрался, а пользователя с таким id уже нет (учётку удалили,
      // база сменилась). Раньше отсюда уходило 200 с пустым телом: фронт
      // получал undefined вместо профиля и показывал «Не удалось загрузить
      // профиль» — то есть человек видел поломку там, где надо просто войти
      // заново. Поймано 21.08.2026 на своём же скриншот-прогоне.
      if (!user) {
        return reply
          .code(401)
          .send({ error: "Пользователь не найден — войдите заново" });
      }
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

  // ═══════ UPDATE PROFILE (Email, Password, Name) ═══════
  app.put<{
    Body: {
      name?: string;
      email?: string;
      password?: string;
      currentPassword?: string;
    };
  }>("/api/auth/profile", {
    preHandler: authMiddleware,
    handler: async (req: any, reply: any) => {
      const user = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(req.userId) as any;
      if (!user) {
        return reply.code(404).send({ error: "Пользователь не найден" });
      }

      const { name, email, password, currentPassword } = req.body || {};

      // If email is changing, verify no other user has it
      if (email && email.toLowerCase().trim() !== user.email.toLowerCase()) {
        const conflict = db
          .prepare(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?",
          )
          .get(email.trim(), req.userId);
        if (conflict) {
          return reply
            .code(409)
            .send({ error: "Этот email/логин уже занят другим пользователем" });
        }
      }

      // If password is changing, verify current password if set
      if (password) {
        if (password.length < 4) {
          return reply
            .code(400)
            .send({ error: "Пароль должен быть не менее 4 символов" });
        }
        if (user.password_hash && currentPassword) {
          if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
            return reply.code(400).send({ error: "Неверный текущий пароль" });
          }
        }
      }

      const newName = name?.trim() || user.name;
      const newEmail = email?.trim().toLowerCase() || user.email;
      const newHash = password
        ? bcrypt.hashSync(password, 10)
        : user.password_hash;
      const initials =
        newName
          .split(" ")
          .map((w: string) => w[0])
          .join("")
          .toUpperCase()
          .slice(0, 2) || user.initials;

      db.prepare(
        "UPDATE users SET name = ?, email = ?, password_hash = ?, initials = ? WHERE id = ?",
      ).run(newName, newEmail, newHash, initials, req.userId);

      const updated = db
        .prepare(
          "SELECT id, name, email, role, type, avatar_color, avatar_url, initials, status FROM users WHERE id = ?",
        )
        .get(req.userId);

      const token = app.jwt.sign({ id: req.userId }, { expiresIn: "30d" });
      return { user: updated, token };
    },
  });
}
