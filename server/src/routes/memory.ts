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
import { memoryObserverStats } from "../lib/memoryObserverLog.js";
import { saveUploadedFile, UploadRejected, UPLOAD_DIR } from "./attachments.js";
import { extractAttachmentText } from "../lib/attachmentText.js";

const TEXT_LIMIT = 24_000;

/** Ключ роли по учётке: users.role_key, а если он пуст — из id учётки
 *  (role_<key> и историческое исключение u-secretary). Раньше пустой
 *  users.role_key давал 400 «для памяти роли нужен role_key», а поле
 *  role_key в схеме инструмента не было — вызвать нельзя было ни одним
 *  корректным аргументом (19.10–02.11.2026). */
function roleKeyOf(userId: string, roleKey: string | null | undefined): string | null {
  const key = String(roleKey ?? "").trim();
  if (key) return key;
  if (userId === "u-secretary") return "secretary";
  if (userId.startsWith("role_")) return userId.slice("role_".length);
  return null;
}

/** Кто пишет: владелец/оркестратор — «owner», ИИ-роль — «role» с её ключом. */
function authorOf(userId: string): { author: Author; roleKey: string | null } | null {
  const row = db.prepare("SELECT type, role_key FROM users WHERE id = ?").get(userId) as { type?: string; role_key?: string | null } | undefined;
  const roleKey = roleKeyOf(userId, row?.role_key);
  // Секретарь и роли с правом orchestrate пишут как владелец, но «своя» память у них
  // остаётся памятью их роли — иначе scope=role падает без role_key.
  if (isOwner(userId) || isOrchestrator(userId)) return { author: { id: userId, kind: "owner" }, roleKey };
  if (row?.type === "ai") return { author: { id: userId, kind: "role" }, roleKey };
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

  app.get<{ Querystring: { days?: string } }>(
    "/api/admin/memory-observer/stats",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "доступно только владельцу" });
      return memoryObserverStats(Number(req.query?.days ?? 7));
    },
  );

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

  app.get<{ Querystring: { q?: string; project_id?: string; role_key?: string; limit?: string; mode?: string; ids?: string } }>(
    "/api/memories/recall",
    { preHandler: authPre },
    async (req: any, reply) => {
      const who = authorOf(req.userId);
      if (!who) return reply.code(403).send({ error: "нет доступа к памяти" });
      const mode = req.query.mode === "index" || req.query.mode === "detail" ? req.query.mode : "full";
      const ids = String(req.query.ids ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const q = String(req.query.q ?? "").trim();
      if (!q && mode !== "detail") return reply.code(400).send({ error: "нужен q — о чём вспомнить" });
      const roleKey = who.author.kind === "role" ? who.roleKey : (req.query.role_key ?? who.roleKey);
      return {
        items: await recall({
          roleKey,
          projectId: req.query.project_id ?? null,
          query: q,
          limit: req.query.limit ? Number(req.query.limit) : 8,
          mode,
          ids,
        }),
      };
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
      // Роль пишет в память своей роли: ключ берём из учётки. Чужой ключ
      // из аргументов не принимаем — и не молча затираем, а объясняем:
      // иначе роль писала бы в чужую память и не поняла бы почему.
      if (body.scope === "role") {
        const asked = String(body.role_key ?? "").trim();
        if (asked && asked !== who.roleKey) {
          return reply.code(403).send({ error: `роль пишет в память своей роли (${who.roleKey ?? "?"}), не в память роли ${asked}` });
        }
        body.role_key = who.roleKey;
      }
      delete body.pinned;
    } else if (body.scope === "role" && !body.role_key && who.roleKey) {
      body.role_key = who.roleKey;
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
