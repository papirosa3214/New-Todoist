// Аватарки-картинки для пользователей и агентов — вместо инициалов+цвета
// (тот fallback остаётся: Avatar.tsx на фронте сам решает, что рисовать,
// avatar_url пуст → буквы, как и раньше).
//
// Тот же приём, что и вложения комментариев (attachments.ts): сырые байты,
// без multipart, имя в query необязательно (у аватарки нет «настоящего
// имени», которое стоило бы хранить). Хранится под случайным UUID-именем.
//
// Раздача — ЗДЕСЬ БЕЗ authOrApiToken, сознательно и это единственное
// отличие от attachments.ts. Avatar.tsx рендерит avatar_url как обычный
// <img src>: браузер/WKWebView не пришлёт Authorization-заголовок на такой
// запрос, и чужая аватарка в списке задач (не своей, а исполнителя) просто
// не загрузится, если раздачу закрыть авторизацией. Безопасность — через
// неугадываемое имя файла (UUID), тот же компромисс, на который идёт
// подавляющее большинство сервисов с публичными аватарками.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { UPLOAD_DIR as ATTACHMENTS_DIR } from "./attachments.js";

const uid = () => crypto.randomUUID();

export const AVATAR_DIR = path.join(ATTACHMENTS_DIR, "avatars");

const MAX_SIZE = 5 * 1024 * 1024; // 5 МБ — с запасом, аватарка не документ

const ALLOWED_MIME = [
  /^image\/png$/,
  /^image\/jpeg$/,
  /^image\/webp$/,
  /^image\/gif$/,
  // ⚠️ SVG здесь больше НЕ принимается (24.10.2026, аудит безопасности).
  // SVG — это не картинка, а документ: в нём есть `<script>`, обработчики
  // событий и внешние ссылки. Открытый напрямую (аватар подставляется в
  // `<img src>`, но ссылка на него попадает в HTML и в переписку) такой файл
  // исполняется в origin приложения — XSS без единого заголовка авторизации.
  // Растровая картинка (png/jpeg/webp/gif) вредоносного кода не несёт.
];

function mimeAllowed(mime: string): boolean {
  return ALLOWED_MIME.some((re) => re.test(mime));
}

// Три состояния «живой» аватарки агента (27.08.2026): дефолт (простаивает)
// + необязательные варианты на agent_state='in_progress'/'blocked' — какую
// колонку читать/писать решает ?variant= в запросе. Явный список вместо
// произвольной строки в SQL — единственная защита от инъекции имени
// колонки, раз колонка выбирается динамически.
const VARIANT_COLUMN: Record<string, string> = {
  working: "avatar_url_working",
  blocked: "avatar_url_blocked",
};

function avatarColumn(variant: unknown): string {
  return typeof variant === "string" && VARIANT_COLUMN[variant]
    ? VARIANT_COLUMN[variant]
    : "avatar_url";
}

// Своя аватарка, аватарка агента, которого сам завёл (created_by), или
// системного бота (is_system_bot=1 — общий для всех, та же логика, что и
// в GET /api/agents, projects.ts:190). Не «владелец = любой залогиненный»:
// чужого личного агента, если тот вдруг заведётся, менять нельзя.
function canManageAvatar(actorId: string, targetId: string): boolean {
  if (actorId === targetId) return true;
  const row = db
    .prepare(
      `SELECT 1 FROM users WHERE id = ? AND (created_by = ? OR is_system_bot = 1)`,
    )
    .get(targetId, actorId);
  return !!row;
}

export function registerAvatarRoutes(app: FastifyInstance) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });

  const uploadAvatar = async (req: any, reply: any, targetId: string) => {
      if (!canManageAvatar(req.userId, targetId)) {
        return reply.code(404).send({ error: "Not found" });
      }

      const body: Buffer = req.body;
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "пустой файл" });
      }
      if (body.length > MAX_SIZE) {
        return reply.code(413).send({
          error: `файл больше ${Math.round(MAX_SIZE / 1024 / 1024)} МБ`,
        });
      }

      const mime = (req.headers["content-type"] || "application/octet-stream")
        .split(";")[0]
        .trim();
      if (!mimeAllowed(mime)) {
        return reply
          .code(415)
          .send({ error: `изображение в этом формате не принимаем: ${mime}` });
      }

      const column = avatarColumn(req.query?.variant);
      const ext = mime === "image/svg+xml" ? ".svg" : `.${mime.split("/")[1]}`;
      const storedName = `${uid()}${ext}`;

      // Старый файл этого же варианта, если был, убираем — иначе на диске
      // копится мусор при каждой смене без единого способа его найти
      // (колонка в базе уже перезаписана на новый путь).
      const prev = db
        .prepare(`SELECT ${column} AS url FROM users WHERE id = ?`)
        .get(targetId) as { url: string | null } | undefined;
      if (prev?.url) {
        const prevName = path.basename(prev.url);
        const prevFull = path.join(AVATAR_DIR, prevName);
        try {
          if (fs.existsSync(prevFull)) fs.unlinkSync(prevFull);
        } catch {
          // Не критично — новая аватарка всё равно встанет.
        }
      }

      fs.writeFileSync(path.join(AVATAR_DIR, storedName), body);
      const avatarUrl = `/api/avatars/${storedName}`;
      db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(
        avatarUrl,
        targetId,
      );

      return reply.code(201).send({ avatar_url: avatarUrl });
  };
  const removeAvatar = async (req: any, reply: any, targetId: string) => {
      if (!canManageAvatar(req.userId, targetId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const column = avatarColumn(req.query?.variant);
      const row = db
        .prepare(`SELECT ${column} AS url FROM users WHERE id = ?`)
        .get(targetId) as { url: string | null } | undefined;
      if (row?.url) {
        const full = path.join(AVATAR_DIR, path.basename(row.url));
        try {
          if (fs.existsSync(full)) fs.unlinkSync(full);
        } catch {
          // см. выше — не критично
        }
      }
      db.prepare(`UPDATE users SET ${column} = NULL WHERE id = ?`).run(
        targetId,
      );
      return { ok: true };
  };

  app.post<{ Params: { id: string }; Querystring: { variant?: string } }>(
    "/api/users/:id/avatar",
    { preHandler: authOrApiToken },
    (req: any, reply) => uploadAvatar(req, reply, req.params.id),
  );
  app.delete<{ Params: { id: string }; Querystring: { variant?: string } }>(
    "/api/users/:id/avatar",
    { preHandler: authOrApiToken },
    (req: any, reply) => removeAvatar(req, reply, req.params.id),
  );
  // Своя аватарка без id в пути: именно сюда ходит iOS-клиент
  // (`APIClient.uploadAvatar` → POST /api/avatars). Раньше маршрута не было —
  // загрузка из настроек всегда отвечала ошибкой (владелец, 06.10.2026).
  app.post<{ Querystring: { variant?: string } }>(
    "/api/avatars",
    { preHandler: authOrApiToken },
    (req: any, reply) => uploadAvatar(req, reply, req.userId),
  );
  app.delete<{ Querystring: { variant?: string } }>(
    "/api/avatars",
    { preHandler: authOrApiToken },
    (req: any, reply) => removeAvatar(req, reply, req.userId),
  );

  // Публичная раздача — см. комментарий вверху файла про причину.
  app.get<{ Params: { name: string } }>(
    "/api/avatars/:name",
    async (req, reply) => {
      const name = path.basename(req.params.name);
      const full = path.join(AVATAR_DIR, name);
      if (!fs.existsSync(full)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const ext = path.extname(name).toLowerCase();
      const mime =
        ext === ".svg"
          ? "image/svg+xml"
          : ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : "image/jpeg";
      reply.header("Content-Type", mime);
      // Заголовки безопасности на ПУБЛИЧНУЮ раздачу (24.10.2026, аудит
      // безопасности). Маршрут открыт без авторизации — аватар видят все,
      // у кого есть ссылка, — поэтому исполняемое содержимое тут недопустимо.
      //   nosniff — браузер не угадывает тип по содержимому;
      //   CSP sandbox — даже если файл оказался исполняемым, он работает в
      //   песочнице без скриптов и без доступа к origin;
      //   attachment — файл скачивается, а не открывается как документ.
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
      reply.header("Content-Disposition", "attachment");
      // Картинки под UUID-именем неизменяемы (новая смена — новое имя) —
      // можно кешировать надолго без риска отдать протухшую версию.
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.send(fs.createReadStream(full));
    },
  );
}
