// API памяти ролей (владелец 02.10.2026) — см. lib/memory.ts.
//
//   GET    /api/memories                — список для экрана «Память» (владелец)
//   GET    /api/memories/:id            — запись целиком, у файла — его куски
//   POST   /api/memories                — запомнить (владелец или роль)
//   PATCH  /api/memories/:id            — исправить
//   DELETE /api/memories/:id            — забыть
//   POST   /api/memories/files          — загрузить файл в память (владелец)
//   GET    /api/memories/recall?q=      — что роль помнит по теме
//
// Роль пишет сама (решение владельца): по умолчанию в свою память, может и
// в общую/проектную. Правит и удаляет роль только свои записи; владелец —
// любые, он же закрепляет и переносит между областями.
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOrchestrator, isOwner } from "../access.js";
import {
  deleteMemory,
  getMemory,
  listMemories,
  MemoryError,
  recall,
  remember,
  rememberFile,
  updateMemory,
  type Author,
} from "../lib/memory.js";
import { saveUploadedFile, UploadRejected, UPLOAD_DIR } from "./attachments.js";
import { extractAttachmentText } from "../lib/attachmentText.js";

const TEXT_LIMIT = 24_000;

/** Кто пишет: владелец/оркестратор — «owner», ИИ-роль — «role» с её ключом. */
function authorOf(userId: string): { author: Author; roleKey: string | null } | null {
  if (isOwner(userId) || isOrchestrator(userId)) return { author: { id: userId, kind: "owner" }, roleKey: null };
  const row = db.prepare("SELECT type, role_key FROM users WHERE id = ?").get(userId) as { type?: string; role_key?: string | null } | undefined;
  if (row?.type === "ai") return { author: { id: userId, kind: "role" }, roleKey: row.role_key ?? null };
  return null;
}

function failure(reply: any, error: unknown) {
  if (error instanceof MemoryError) return reply.code(error.status).send({ error: error.message });
  throw error;
}

/** Текст файла: всё текстовое читаем как есть, pdf/doc — через извлечение. */
async function fileText(filePath: string, mime: string, fileName: string): Promise<string> {
  const textual =
    /^text\//.test(mime) ||
    /^application\/(json|xml|yaml|x-yaml|javascript|x-sh|x-python|sql|toml|x-ndjson)$/.test(mime) ||
    (mime === "application/octet-stream" && /\.(md|txt|csv|json|ya?ml|py|js|ts|swift|sh|sql|toml|ini|log)$/i.test(fileName));
  if (textual) return fs.readFileSync(filePath, "utf8").replace(/\u0000/g, "").slice(0, TEXT_LIMIT);
  return extractAttachmentText(filePath, mime);
}

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  const authPre = authOrApiToken;

  app.get<{ Querystring: { scope?: string; role_key?: string; project_id?: string; q?: string; limit?: string } }>(
    "/api/memories",
    { preHandler: authPre },
    async (req: any, reply) => {
      const who = authorOf(req.userId);
      if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
      // Роль видит свою память и общую — список целиком смотрит владелец.
      const filter = { ...req.query, limit: req.query.limit ? Number(req.query.limit) : undefined };
      if (who.author.kind === "role") {
        const mine = listMemories({ ...filter, scope: "role", role_key: who.roleKey ?? "" });
        const team = listMemories({ ...filter, scope: "team" });
        return { memories: [...mine, ...team] };
      }
      return { memories: listMemories(filter) };
    },
  );

  app.get<{ Querystring: { q?: string; project_id?: string; role_key?: string; limit?: string } }>(
    "/api/memories/recall",
    { preHandler: authPre },
    async (req: any, reply) => {
      const who = authorOf(req.userId);
      if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
      const q = String(req.query.q ?? "").trim();
      if (!q) return reply.code(400).send({ error: "нужен q — о чём вспомнить" });
      const roleKey = who.author.kind === "role" ? who.roleKey : (req.query.role_key ?? null);
      return { items: await recall({ roleKey, projectId: req.query.project_id ?? null, query: q, limit: req.query.limit ? Number(req.query.limit) : 8 }) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/memories/:id", { preHandler: authPre }, async (req: any, reply) => {
    const who = authorOf(req.userId);
    if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
    const memory = getMemory(req.params.id);
    if (!memory) return reply.code(404).send({ error: "запись не найдена" });
    if (who.author.kind === "role" && memory.scope === "role" && memory.role_key !== who.roleKey) {
      return reply.code(404).send({ error: "запись не найдена" });
    }
    const chunks = memory.kind === "file"
      ? (db.prepare("SELECT idx, text FROM memory_chunks WHERE memory_id = ? ORDER BY idx").all(memory.id) as Array<{ idx: number; text: string }>)
      : [];
    return { memory, chunks };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/memories", { preHandler: authPre }, async (req: any, reply) => {
    const who = authorOf(req.userId);
    if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
    const body = { ...(req.body ?? {}) };
    if (who.author.kind === "role") {
      body.scope ??= "role";
      if (body.scope === "role") body.role_key = who.roleKey;
      delete body.pinned;
    }
    try {
      const result = await remember(body, who.author);
      return reply.code(result.updated ? 200 : 201).send(result);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/memories/:id", { preHandler: authPre }, async (req: any, reply) => {
    const who = authorOf(req.userId);
    if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
    try {
      return { memory: await updateMemory(req.params.id, req.body ?? {}, who.author) };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/memories/:id", { preHandler: authPre }, async (req: any, reply) => {
    const who = authorOf(req.userId);
    if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
    try {
      deleteMemory(req.params.id, who.author);
      return { ok: true };
    } catch (error) {
      return failure(reply, error);
    }
  });

  // Файл в память (владелец 02.10.2026: «закидывать туда файлы»): тело —
  // сам файл, как у /api/chats/attachments; имя и область — в query.
  app.post<{ Querystring: { name?: string; scope?: string; role_key?: string; project_id?: string; title?: string } }>(
    "/api/memories/files",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "файлы в память загружает владелец" });
      let saved: { id: string; fileName: string; mime: string; storedName: string } | null = null;
      try {
        saveUploadedFile(
          { body: req.body, name: req.query?.name, mime: req.headers["content-type"] },
          (fields) => {
            saved = fields;
            db.prepare(
              `INSERT INTO attachments (id, task_id, comment_id, chat_message_id, kind, user_id, file_name, mime, size, stored_name)
               VALUES (?, NULL, NULL, NULL, 'comment', ?, ?, ?, ?, ?)`,
            ).run(fields.id, req.userId, fields.fileName, fields.mime, fields.size, fields.storedName);
          },
        );
      } catch (error) {
        if (error instanceof UploadRejected) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
      const file = saved as unknown as { id: string; fileName: string; mime: string; storedName: string };
      let text: string;
      try {
        text = await fileText(path.join(UPLOAD_DIR, file.storedName), file.mime, file.fileName);
      } catch (error) {
        return reply.code(422).send({ error: `не удалось прочитать текст файла: ${error instanceof Error ? error.message : String(error)}` });
      }
      try {
        const memory = await rememberFile(
          {
            scope: req.query.scope,
            role_key: req.query.role_key,
            project_id: req.query.project_id,
            title: (req.query.title && String(req.query.title).trim()) || file.fileName,
            text,
            attachment_id: file.id,
          },
          { id: req.userId, kind: "owner" },
        );
        return reply.code(201).send({ memory });
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
}
