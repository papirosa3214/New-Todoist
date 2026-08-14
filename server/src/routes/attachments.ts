// Вложения комментариев: загрузка файла, отдача и удаление.
//
// Файл приходит СЫРЫМИ БАЙТАМИ, без multipart-обёртки — тем же приёмом,
// что и запись микрофона (routes/transcribe.ts + addContentTypeParser в
// index.ts): фронт и так держит File/Blob, лишний раунд упаковки и разбора
// ничего не даёт. Имя файла едет в query (`?name=`), тип — в Content-Type.
//
// Байты ложатся на диск в server/uploads под случайным именем, в базе
// остаётся запись (см. таблицу attachments в db.ts). Имя в хранилище
// случайное намеренно: пользовательское имя может быть каким угодно —
// с «..», со слэшами, в другой раскодировке — и подставлять его в путь
// нельзя. Настоящее имя показывается в интерфейсе из базы.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import db, { DB_PATH } from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForUser } from "../access.js";

const uid = () => crypto.randomUUID();

// Рядом с файлом базы: у них одна судьба — вместе копировать, вместе
// переносить. Путь берётся из db.ts, где его вычисляет сама база, а не
// собирается здесь заново: собственный вариант уже создал папку не в том
// месте, потому что считался от текущего каталога процесса.
export const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), "uploads");

// 15 МБ — с запасом на скриншот и обычный документ. Общий bodyLimit сервера
// 25 МБ (index.ts, ради аудио), так что этот предел строже и срабатывает
// первым, с понятным текстом вместо сырой ошибки Fastify.
const MAX_SIZE = 15 * 1024 * 1024;

// Что принимаем. Не «всё подряд»: файл потом отдаётся браузеру, и список
// держит его в предсказуемых рамках. Исполняемое и архивы сюда не входят
// сознательно — для задач это не вложения, а способ занести на машину что
// угодно.
const ALLOWED_MIME = [
  /^image\//,
  /^application\/pdf$/,
  /^text\/plain$/,
  /^application\/msword$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\./,
];

function mimeAllowed(mime: string): boolean {
  return ALLOWED_MIME.some((re) => re.test(mime));
}

export function attachmentRow(id: string) {
  return db
    .prepare(
      `SELECT a.id, a.task_id, a.comment_id, a.file_name, a.mime, a.size, a.created_at,
              u.name as user_name
       FROM attachments a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
    )
    .get(id);
}

export function registerAttachmentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // Загрузить файл к задаче. Комментарий может ещё не существовать —
  // тогда вложение висит «ничьим» до отправки комментария, который его и
  // подберёт (POST /api/tasks/:taskId/comments с attachment_ids).
  app.post<{ Params: { taskId: string }; Querystring: { name?: string } }>(
    "/api/tasks/:taskId/attachments",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForUser(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

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
          .send({ error: `такие файлы не принимаем: ${mime}` });
      }

      // Имя приходит закодированным (в нём бывают пробелы и кириллица).
      // Битую кодировку не роняем в 500 — берём как есть.
      let fileName = "файл";
      const raw = req.query?.name;
      if (typeof raw === "string" && raw.trim()) {
        try {
          fileName = decodeURIComponent(raw).trim();
        } catch {
          fileName = raw.trim();
        }
      }
      // Из имени берём только его само: ни путей, ни разделителей.
      fileName = path.basename(fileName).slice(0, 200);

      const id = uid();
      const ext = path.extname(fileName).slice(0, 12);
      const storedName = `${id}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), body);

      db.prepare(
        `INSERT INTO attachments (id, task_id, comment_id, user_id, file_name, mime, size, stored_name)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        req.params.taskId,
        req.userId,
        fileName,
        mime,
        body.length,
        storedName,
      );

      return reply.code(201).send({ attachment: attachmentRow(id) });
    },
  );

  // Отдать файл. Доступ — как к самой задаче: чужое вложение не откроется,
  // даже если знать его идентификатор.
  app.get<{ Params: { id: string } }>(
    "/api/attachments/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const att = db
        .prepare("SELECT * FROM attachments WHERE id = ?")
        .get(req.params.id) as any;
      if (!att) return reply.code(404).send({ error: "Not found" });
      if (!getTaskForUser(att.task_id, req.userId)) {
        return reply.code(404).send({ error: "Not found" });
      }

      const full = path.join(UPLOAD_DIR, att.stored_name);
      if (!fs.existsSync(full)) {
        return reply.code(410).send({ error: "файл потерян на диске" });
      }
      // filename* с кодировкой — иначе кириллица в имени приезжает мусором.
      reply.header("Content-Type", att.mime);
      reply.header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(att.file_name)}`,
      );
      return reply.send(fs.createReadStream(full));
    },
  );

  // Удалить вложение — только тот, кто его загрузил. Файл с диска тоже
  // убираем: запись без файла и файл без записи одинаково бесполезны.
  app.delete<{ Params: { id: string } }>(
    "/api/attachments/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const att = db
        .prepare("SELECT * FROM attachments WHERE id = ? AND user_id = ?")
        .get(req.params.id, req.userId) as any;
      if (!att) return reply.code(404).send({ error: "Not found" });

      const full = path.join(UPLOAD_DIR, att.stored_name);
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {
        // Файла нет или не удалился — запись всё равно убираем, иначе в
        // ленте останется вложение, которое нельзя ни открыть, ни убрать.
      }
      db.prepare("DELETE FROM attachments WHERE id = ?").run(req.params.id);
      return { ok: true };
    },
  );
}
