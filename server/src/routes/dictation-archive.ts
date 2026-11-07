import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import db, { DB_PATH } from "../db.js";
import { authOrApiToken } from "../auth.js";

// Тот же приём, что в routes/attachments.ts — отдельного модуля идентификаторов
// в проекте нет.
const uid = () => crypto.randomUUID();

// ═══════════ АРХИВ ДИКТОВОК ═══════════
//
// Задача от владельца 18.08.2026: аудио диктовок не удалять сразу, а
// накапливать на телефоне и выгружать на .110, когда он в сети; удалять с
// телефона только после подтверждения сервером. Срок хранения на сервере —
// ВЕЧНО, это его прямое решение («пусть вечно хранит»).
//
// Почему отдельный маршрут, а не вложения задачи: диктовка бывает и в
// комментарии, и до того, как задача вообще создана, — привязать её к task_id
// нечем. Механизм хранения тот же, что у вложений (routes/attachments.ts):
// байты на диск под случайным именем, метаданные в БД.
//
// Рядом с аудио кладём распознанный текст и движок (whisper/apple/server) —
// без них архив бесполезен: именно сравнение «что сказал» и «что распознало»
// и есть смысл затеи.

const UPLOAD_DIR =
  process.env.DICTATION_DIR ||
  path.join(path.dirname(DB_PATH), "uploads", "dictation");

// 25 МБ на запись: диктовка задачи — это секунды звука, всё крупнее означает
// ошибку на клиенте, а не длинную мысль.
const MAX_SIZE = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
  "audio/wav",
  "audio/mpeg",
]);

function extensionFor(mime: string): string {
  switch (mime.split(";")[0].trim()) {
    case "audio/webm":
      return ".webm";
    case "audio/wav":
      return ".wav";
    case "audio/mpeg":
      return ".mp3";
    default:
      return ".m4a";
  }
}

export function registerDictationArchiveRoutes(app: FastifyInstance) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS dictation_recordings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      /* Что распознал движок — сырой текст, без правок клиента. */
      recognized_text TEXT,
      /* whisper | apple | server — чем распознавали. */
      engine TEXT,
      /* Время записи НА ТЕЛЕФОНЕ: выгрузка может случиться много позже, и
         серверное created_at про момент диктовки ничего не скажет. */
      recorded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  app.post<{
    Querystring: { text?: string; engine?: string; recordedAt?: string };
  }>(
    "/api/audio/archive",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const body: Buffer = req.body;
      if (!body || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "Пустое тело запроса" });
      }
      if (body.length > MAX_SIZE) {
        return reply.code(413).send({ error: "Запись слишком большая" });
      }

      const mime = String(req.headers["content-type"] || "audio/mp4")
        .split(";")[0]
        .trim();
      if (!ALLOWED_MIME.has(mime)) {
        return reply.code(415).send({ error: `Формат ${mime} не принимается` });
      }

      const id = uid();
      const storedName = `${id}${extensionFor(mime)}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), body);

      db.prepare(
        `INSERT INTO dictation_recordings
           (id, user_id, stored_name, mime, size, recognized_text, engine, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        req.userId,
        storedName,
        mime,
        body.length,
        req.query.text ?? null,
        req.query.engine ?? null,
        req.query.recordedAt ?? null,
      );

      // Клиент удаляет свою копию ТОЛЬКО получив этот ответ — поэтому здесь
      // важно ответить уже после того, как файл и строка записаны.
      return reply.send({ id, size: body.length });
    },
  );

  // Список — чтобы архив можно было посмотреть, а не только пополнять.
  app.get("/api/audio/archive", { preHandler: authOrApiToken }, async (req: any) => {
    const rows = db
      .prepare(
        `SELECT id, mime, size, recognized_text, engine, recorded_at, created_at
           FROM dictation_recordings
          WHERE user_id = ?
          ORDER BY COALESCE(recorded_at, created_at) DESC
          LIMIT 500`,
      )
      .all(req.userId);
    return { recordings: rows };
  });

  // Отдача самого звука — чтобы запись можно было послушать.
  app.get<{ Params: { id: string } }>(
    "/api/audio/archive/:id",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const row: any = db
        .prepare(
          `SELECT stored_name, mime FROM dictation_recordings
            WHERE id = ? AND user_id = ?`,
        )
        .get(req.params.id, req.userId);
      if (!row) return reply.code(404).send({ error: "Запись не найдена" });

      const full = path.join(UPLOAD_DIR, row.stored_name);
      if (!fs.existsSync(full)) {
        return reply.code(410).send({ error: "Файл записи отсутствует" });
      }
      return reply.type(row.mime).send(fs.createReadStream(full));
    },
  );
}
