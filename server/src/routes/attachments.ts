// Вложения задач и комментариев: загрузка файла, отдача и удаление.
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
//
// `@fastify/multipart` стоял в server/package.json с самого начала работы
// над вложениями, но ни разу не был зарегистрирован как плагин и нигде не
// импортировался — решение выше принято раньше, чем библиотека
// понадобилась, и её просто забыли убрать. Удалена 15.08.2026 (`npm
// uninstall`): раз этот путь работает и намеренно не multipart, держать
// неиспользуемую зависимость смысла нет — она тянет транзитивные пакеты и
// создаёт риск для аудита (npm audit проверяет то, чем даже не пользуются).
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import db, { DB_PATH } from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, getTaskForWrite } from "../access.js";
import { extractAttachmentText, AttachmentTextError } from "../lib/attachmentText.js";
import { extractTasksFromText, getUserPrompt } from "./ai.js";

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

// Что принимаем. Владелец 20.09.2026: «почему только текстовые документы —
// приложить вообще всё, это же контекст задачи: код, скрипт, ссылка».
// Поэтому принимаем любой текст (`text/*` покрывает .py/.js/.sh/.md и т.п.),
// частые кодовые/конфиговые типы и всё неопознанное (`application/octet-stream`)
// — расширение .py система часто не опознаёт и отдаёт именно им. Файл
// по-прежнему отдаётся как есть, но с `Content-Disposition: inline` и
// неизвестным типом браузер его не исполняет. Предел размера 15 МБ остаётся.
const ALLOWED_MIME = [
  /^image\//,
  /^text\//,
  /^application\/pdf$/,
  /^application\/msword$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\./,
  /^application\/(json|xml|yaml|x-yaml|javascript|x-javascript|x-sh|x-shellscript|x-python|x-ruby|x-perl|x-httpd-php|sql|graphql|toml|x-ndjson)$/,
  /^application\/octet-stream$/,
];

function mimeAllowed(mime: string): boolean {
  return ALLOWED_MIME.some((re) => re.test(mime));
}

/** Файл не приняли — со статусом, который надо вернуть клиенту. */
export class UploadRejected extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Общая часть заливки: проверить байты, тип и имя, положить файл на диск и
 * завести строку в базе. Куда именно она ссылается — на задачу, на
 * комментарий или на сообщение чата — знает только вызывающий, он и пишет
 * свой INSERT. Раньше всё это жило внутри одного маршрута; когда файлы
 * понадобились чату (28.08.2026), проверки пришлось бы копировать — а
 * разъехавшийся предел размера или список типов в двух местах никто бы не
 * заметил, пока файл не пролез мимо.
 */
export function saveUploadedFile(
  req: { body: unknown; name?: unknown; mime?: unknown },
  insert: (fields: {
    id: string;
    fileName: string;
    mime: string;
    size: number;
    storedName: string;
  }) => void,
): string {
  const body = req.body;
  if (!body || !Buffer.isBuffer(body) || body.length === 0) {
    throw new UploadRejected(400, "пустой файл");
  }
  if (body.length > MAX_SIZE) {
    throw new UploadRejected(
      413,
      `файл больше ${Math.round(MAX_SIZE / 1024 / 1024)} МБ`,
    );
  }

  const mime = String(req.mime || "application/octet-stream")
    .split(";")[0]
    .trim();
  if (!mimeAllowed(mime)) {
    throw new UploadRejected(415, `такие файлы не принимаем: ${mime}`);
  }

  // Имя приходит закодированным (в нём бывают пробелы и кириллица).
  // Битую кодировку не роняем в 500 — берём как есть.
  let fileName = "файл";
  if (typeof req.name === "string" && req.name.trim()) {
    try {
      fileName = decodeURIComponent(req.name).trim();
    } catch {
      fileName = req.name.trim();
    }
  }
  // Из имени берём только его само: ни путей, ни разделителей.
  fileName = path.basename(fileName).slice(0, 200);

  const id = uid();
  const ext = path.extname(fileName).slice(0, 12);
  const storedName = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), body);
  insert({ id, fileName, mime, size: body.length, storedName });
  return id;
}

// Кому файл виден. У вложения задачи — тому, кто видит задачу. У вложения
// чата задачи нет вовсе: чат общий канал (v1, routes/chat.ts — «сообщение
// видит каждый»), поэтому виден любому участнику. Ещё не подобранный файл
// (обе ссылки NULL) виден только тому, кто его залил: он существует ровно
// между выбором файла и отправкой сообщения.
export function canRead(att: any, userId: string): boolean {
  if (att.task_id) return Boolean(getTaskForRead(att.task_id, userId));
  if (att.chat_message_id) return true;
  return att.user_id === userId;
}

export function attachmentRow(id: string) {
  return db
    .prepare(
      `SELECT a.id, a.task_id, a.comment_id, a.kind, a.file_name, a.mime, a.size, a.created_at,
              u.name as user_name
       FROM attachments a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
    )
    .get(id);
}

export function registerAttachmentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // Загрузить файл к задаче.
  //
  // `?kind=comment` (по умолчанию) — файл для ленты: комментарий может ещё
  // не существовать, тогда вложение висит «ничьим» до отправки комментария,
  // который его и подберёт (POST /api/tasks/:taskId/comments с
  // attachment_ids).
  //
  // `?kind=task` — файл самой задачи: то, что приложено к её заметке
  // (19.08.2026). Такой в ленту не попадает и никаким комментарием подобран
  // быть не может — выборка при отправке комментария сужена до
  // kind = 'comment' (routes/subtasks.ts).
  app.post<{
    Params: { taskId: string };
    Querystring: { name?: string; kind?: string };
  }>(
    "/api/tasks/:taskId/attachments",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForWrite(req.params.taskId, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      // Вид — только из двух известных: неизвестное слово в query не должно
      // заводить в базе третий, никем не читаемый вид вложений.
      const kind = req.query?.kind === "task" ? "task" : "comment";

      try {
        const id = saveUploadedFile(
          {
            body: req.body,
            name: req.query?.name,
            mime: req.headers["content-type"],
          },
          (f) =>
            db
              .prepare(
                `INSERT INTO attachments (id, task_id, comment_id, kind, user_id, file_name, mime, size, stored_name)
                 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                f.id,
                req.params.taskId,
                kind,
                req.userId,
                f.fileName,
                f.mime,
                f.size,
                f.storedName,
              ),
        );
        return reply.code(201).send({ attachment: attachmentRow(id) });
      } catch (e) {
        if (e instanceof UploadRejected)
          return reply.code(e.status).send({ error: e.message });
        throw e;
      }
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
      if (!canRead(att, req.userId)) {
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
  // Задачи из вложения (просьба владельца 20.09.2026): вытаскиваем из файла
  // ТЕКСТ (pdf — pdftotext, doc/docx/odt — libreoffice, txt/md — как есть) и
  // отдаём ЛОКАЛЬНОЙ модели, которая предлагает список задач. Ничего не
  // создаём: клиент показывает список и создаёт по подтверждению (как у
  // заметок в NoteExtractedTasksSheet).
  app.post<{ Params: { id: string } }>(
    "/api/attachments/:id/tasks",
    { preHandler: authPre },
    async (req: any, reply) => {
      const att = db
        .prepare("SELECT * FROM attachments WHERE id = ?")
        .get(req.params.id) as any;
      if (!att || !canRead(att, req.userId)) {
        return reply.code(404).send({ error: "Вложение не найдено" });
      }

      const full = path.join(UPLOAD_DIR, att.stored_name);
      if (!fs.existsSync(full)) {
        return reply.code(410).send({ error: "файл потерян на диске" });
      }

      let text: string;
      try {
        text = await extractAttachmentText(full, att.mime);
      } catch (e) {
        const message =
          e instanceof AttachmentTextError ? e.message : (e as Error).message;
        return reply
          .code(422)
          .send({ error: `Не удалось прочитать файл: ${message}` });
      }
      if (text.trim().length < 3) {
        return reply.code(422).send({ error: "В файле не нашлось текста" });
      }

      try {
        const userPrompt = await getUserPrompt(req.userId, "extract_tasks");
        const tasks = await extractTasksFromText(
          text,
          undefined,
          undefined,
          undefined,
          userPrompt,
          16_000,
        );
        return { tasks, chars: text.length };
      } catch (e) {
        return reply
          .code(502)
          .send({ error: `Модель не справилась: ${(e as Error).message}` });
      }
    },
  );
}
