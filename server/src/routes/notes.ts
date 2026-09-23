// ═══════════ ЗАМЕТКИ (notes) ═══════════
//
// 26.08.2026. Самостоятельные заметки: своё название, сколько угодно в
// день, лежат в папках (journal_folders, те же что у Дневника).
//
// Почему отдельная сущность, а не расширение journal_entries: там id —
// сама дата, то есть «один день = одна запись». Владелец попросил
// «обычные заметки: сколько угодно в день, у каждой своё название, дата —
// просто когда создана», и в модели «ключ = дата» это невыразимо.
// Дневник по дням остаётся жить на journal_entries отдельным экраном.
//
// Контент — сериализованный TipTap JSON (строка), сервер его не парсит;
// разбор и рендер на клиенте. Превью для списка считает journalPreview.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { journalPreview } from "../lib/tiptapPlaintext.js";
import { tiptapToMarkdown } from "../lib/tiptapToMarkdown.js";
import {
  markdownToTiptap,
  deriveTitleFromMarkdown,
} from "../lib/markdownToTiptap.js";

// Таблица называется user_notes: имя notes занято заброшенной
// таблицей из миграции 010 (единая страница «Заметки», одна строка).
interface NoteRow {
  id: string;
  title: string;
  content: string;
  folder_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export function registerNoteRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Список для экранов папок: без полного контента — только превью.
  // Контент тянется отдельным запросом при открытии заметки, иначе
  // список из сотни заметок вёз бы мегабайты TipTap-JSON.
  app.get("/api/notes", { preHandler: authPre }, async () => {
    const rows = db
      .prepare(
        `SELECT id, title, content, folder_id, created_at, updated_at
         FROM user_notes ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as NoteRow[];
    return {
      notes: rows.map((r) => ({
        id: r.id,
        title: r.title,
        folder_id: r.folder_id,
        preview: journalPreview(r.content),
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  });

  // ?format=markdown — для АГЕНТОВ (26.08.2026). Они читают и пишут
  // markdown, а хранение — TipTap JSON; без перевода агент получал бы
  // дерево узлов и не мог с ним работать. Приложение ходит без параметра
  // и получает JSON как раньше.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/notes/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const row = db
        .prepare("SELECT * FROM user_notes WHERE id = ?")
        .get(req.params.id) as NoteRow | undefined;
      if (!row) return reply.code(404).send({ error: "Заметка не найдена" });
      if (req.query?.format === "markdown") {
        return { ...row, markdown: tiptapToMarkdown(row.content) };
      }
      return row;
    },
  );

  // Создание. folder_id приходит с экрана папки — заметка сразу ложится
  // куда надо, без последующего перетаскивания.
  app.post<{
    Body: {
      title?: string;
      content?: string;
      /** Для агентов: текст в markdown, сервер сам переведёт в TipTap. */
      markdown?: string;
      folder_id?: number | null;
    };
  }>(
    "/api/notes",
    { preHandler: authPre },
    async (req: any, reply) => {
      // markdown важнее content: если агент прислал оба, он явно имел в
      // виду markdown (content у него взяться неоткуда).
      const md =
        typeof req.body?.markdown === "string" ? req.body.markdown : null;
      const title = (
        req.body?.title ??
        (md !== null ? deriveTitleFromMarkdown(md) : "")
      )
        .toString()
        .slice(0, 200);
      const content =
        md !== null
          ? markdownToTiptap(md)
          : typeof req.body?.content === "string"
            ? req.body.content
            : "";
      const folderId = req.body?.folder_id ?? null;
      if (folderId !== null) {
        if (!Number.isFinite(folderId))
          return reply.code(400).send({ error: "Неверный folder_id" });
        const exists = db
          .prepare("SELECT id FROM journal_folders WHERE id = ?")
          .get(folderId) as { id: number } | undefined;
        if (!exists) return reply.code(400).send({ error: "Папка не найдена" });
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO user_notes (id, title, content, folder_id, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, title, content, folderId, req.userId);
      return db.prepare("SELECT * FROM user_notes WHERE id = ?").get(id);
    },
  );

  // Разбор markdown для РЕДАКТОРА: он живёт во фронте, а конвертер — здесь,
  // и тащить второй его экземпляр в бандл значило бы получить две правды.
  // Нужен он при вставке из буфера: TipTap принимает markdown как простой
  // текст, и таблица превращается в абзац с hardBreak вместо сетки —
  // ровно так были испорчены 9 заметок (найдено 22.09.2026).
  app.post<{ Body: { markdown?: string } }>(
    "/api/notes/markdown-to-doc",
    { preHandler: authPre },
    async (req: any, reply) => {
      const md = typeof req.body?.markdown === "string" ? req.body.markdown : null;
      if (md === null)
        return reply.code(400).send({ error: "нужно поле markdown" });
      return { doc: JSON.parse(markdownToTiptap(md)) };
    },
  );

  // Частичное обновление: шлём только то, что реально меняем. Именно
  // поэтому PATCH, а не PUT — у Дневника PUT с обязательным content
  // однажды чуть не стёр запись при смене папки (см. journal.ts).
  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      content?: string;
      /** Для агентов: markdown вместо TipTap JSON. */
      markdown?: string;
      folder_id?: number | null;
    };
  }>("/api/notes/:id", { preHandler: authPre }, async (req: any, reply) => {
    const { id } = req.params;
    const existing = db.prepare("SELECT id FROM user_notes WHERE id = ?").get(id) as
      | { id: string }
      | undefined;
    if (!existing) return reply.code(404).send({ error: "Заметка не найдена" });

    const sets: string[] = [];
    const params: unknown[] = [];
    const has = (k: string) =>
      req.body && Object.prototype.hasOwnProperty.call(req.body, k);

    if (has("title")) {
      sets.push("title = ?");
      params.push((req.body.title ?? "").toString().slice(0, 200));
    }
    if (has("markdown") && typeof req.body.markdown === "string") {
      sets.push("content = ?");
      params.push(markdownToTiptap(req.body.markdown));
      // Заголовок выводим из текста, если его не прислали явно: иначе в
      // списке останется старое название от прежнего содержимого.
      if (!has("title")) {
        sets.push("title = ?");
        params.push(deriveTitleFromMarkdown(req.body.markdown).slice(0, 200));
      }
    } else if (has("content") && typeof req.body.content === "string") {
      sets.push("content = ?");
      params.push(req.body.content);
    }
    if (has("folder_id")) {
      const raw = req.body.folder_id;
      if (raw !== null) {
        if (!Number.isFinite(raw))
          return reply.code(400).send({ error: "Неверный folder_id" });
        const exists = db
          .prepare("SELECT id FROM journal_folders WHERE id = ?")
          .get(raw) as { id: number } | undefined;
        if (!exists) return reply.code(400).send({ error: "Папка не найдена" });
      }
      sets.push("folder_id = ?");
      params.push(raw);
    }
    if (sets.length === 0) {
      return db.prepare("SELECT * FROM user_notes WHERE id = ?").get(id);
    }
    sets.push("updated_at = datetime('now')", "updated_by = ?");
    params.push(req.userId, id);
    db.prepare(`UPDATE user_notes SET ${sets.join(", ")} WHERE id = ?`).run(
      ...params,
    );
    return db.prepare("SELECT * FROM user_notes WHERE id = ?").get(id);
  });

  // ═══ Документация проекта — одним запросом ═══
  //
  // 26.08.2026. Агенту нужна не «папка» и не «список заметок», а ответ на
  // вопрос «что известно по этому проекту». Собирать это из трёх вызовов
  // (проект → папка → заметки поддерева) он не обязан.
  //
  // Заметки берём по ВСЕМУ поддереву: документацию раскладывают по
  // подпапкам, а свод нужен целиком. Контент не отдаём — только превью,
  // иначе ответ раздуется; полный текст берётся точечно через
  // /api/notes/:id?format=markdown.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/docs",
    { preHandler: authPre },
    async (req: any, reply) => {
      const project = db
        .prepare("SELECT id, name, notes_folder_id FROM projects WHERE id = ?")
        .get(req.params.id) as
        | { id: string; name: string; notes_folder_id: number | null }
        | undefined;
      if (!project) return reply.code(404).send({ error: "Проект не найден" });

      if (project.notes_folder_id === null) {
        return {
          project: { id: project.id, name: project.name },
          folder: null,
          notes: [],
          подсказка:
            "У проекта нет папки документации. Создать: POST /api/journal/folders " +
            "{name}, затем PATCH /api/projects/:id {notes_folder_id}.",
        };
      }

      // Поддерево папок: обходим вширь, пока находятся новые потомки.
      const all = db
        .prepare("SELECT id, parent_id, name FROM journal_folders")
        .all() as Array<{ id: number; parent_id: number | null; name: string }>;
      const ids = new Set<number>([project.notes_folder_id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of all) {
          if (f.parent_id !== null && ids.has(f.parent_id) && !ids.has(f.id)) {
            ids.add(f.id);
            grew = true;
          }
        }
      }

      const rows = db
        .prepare(
          `SELECT id, title, content, folder_id, updated_at
           FROM user_notes
           WHERE folder_id IS NOT NULL
           ORDER BY updated_at DESC`,
        )
        .all() as NoteRow[];
      const byId = new Map(all.map((f) => [f.id, f]));
      const root = byId.get(project.notes_folder_id);

      return {
        project: { id: project.id, name: project.name },
        folder: root ? { id: root.id, name: root.name } : null,
        notes: rows
          .filter((r) => r.folder_id !== null && ids.has(r.folder_id))
          .map((r) => ({
            id: r.id,
            title: r.title,
            папка: byId.get(r.folder_id as number)?.name ?? null,
            preview: journalPreview(r.content),
            updated_at: r.updated_at,
          })),
        "как читать":
          "Полный текст заметки: GET /api/notes/:id?format=markdown. " +
          "Записать: POST /api/notes {markdown, folder_id} или PATCH /api/notes/:id {markdown}.",
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/notes/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const res = db.prepare("DELETE FROM user_notes WHERE id = ?").run(req.params.id);
      if (res.changes === 0)
        return reply.code(404).send({ error: "Заметка не найдена" });
      return reply.code(204).send();
    },
  );
}