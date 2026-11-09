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
import { KB_CATEGORIES, KB_DROP_MARK, KB_COLUMNS } from "../lib/kbCategories.js";
import {
  enqueueNoteIndex,
  forgetNoteIndex,
  indexStates,
  noteIndexLabel,
} from "../lib/knowledgeIndexQueue.js";

export { KB_CATEGORIES, KB_DROP_MARK, KB_COLUMNS };

// Список категорий и пометка «мусор» живут в server/src/lib/kbCategories.ts:
// теми же значениями пользуется инструмент роли taskflow_kb_categorize,
// который пишет эти поля напрямую. Смысл категорий — в том же файле.
import { authOrApiToken } from "../auth.js";
import { journalPreview } from "../lib/tiptapPlaintext.js";
import { tiptapToMarkdown } from "../lib/tiptapToMarkdown.js";
import {
  markdownToTiptap,
  deriveTitleFromMarkdown,
} from "../lib/markdownToTiptap.js";
import { noteSearchText } from "../lib/noteSearchText.js";

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
  // folder_id (08.10.2026) — фильтр по папке; без параметра — все.
  app.get<{ Querystring: { folder_id?: string } }>(
    "/api/notes",
    { preHandler: authPre },
    async (req: any) => {
      const folderId = req.query?.folder_id;
      const where = folderId ? "WHERE folder_id = ?" : "";
      const params = folderId ? [Number(folderId)] : [];
      const rows = db
        .prepare(
          `SELECT id, title, content, folder_id, created_at, updated_at
           FROM user_notes ${where} ORDER BY updated_at DESC, created_at DESC`,
        )
        .all(...params) as NoteRow[];
      // Индексация — одним запросом на весь список: рядом с заметкой дневник
      // показывает, попала ли она в поиск.
      const states = indexStates(rows.map((r) => r.id));
      return {
        notes: rows.map((r) => ({
          id: r.id,
          title: r.title,
          folder_id: r.folder_id,
          preview: journalPreview(r.content),
          created_at: r.created_at,
          updated_at: r.updated_at,
          index_state: states.get(r.id)?.state ?? "indexed",
          index_error: states.get(r.id)?.error ?? null,
        })),
      };
    },
  );

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
      // Учёт обращения: по нему Помощник владельца проверяет свою пометку «мусор».
      // Модель открыла — значит заметка пригодилась, даже если не как
      // переиспользуемое знание, а просто чтобы держать контекст. Если не
      // открывала — мусор подтверждается (10.10.2026, схема базы знаний).
      try {
        db.prepare(
          "UPDATE user_notes SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
        ).run(req.params.id);
        db.prepare(
          "INSERT INTO note_accesses (id, note_id, actor_id) VALUES (?,?,?)",
        ).run(randomUUID(), req.params.id, req.userId);
      } catch {
        // Учёт — вспомогательный: его поломка не должна ронять чтение заметки.
      }
      const index = noteIndexLabel(row.id);
      const withIndex = { index_state: index.state, index_error: index.error };
      if (req.query?.format === "markdown") {
        return { ...row, ...withIndex, markdown: tiptapToMarkdown(row.content) };
      }
      return { ...row, ...withIndex };
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
      /** Схема базы знаний (cfa5cdcd). */
      kb_temp_category?: string | null;
      kb_category?: string | null;
      kb_source_task_id?: string | null;
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
        `INSERT INTO user_notes (id, title, content, folder_id, updated_by, search_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, title, content, folderId, req.userId, noteSearchText(content));
      // Заметка рождается, а индекс нужен уже сейчас: очередь сама выждет
      // дебаунс, чтобы серия автосохранений не заливала документ десять раз.
      enqueueNoteIndex(id);

      // Схема базы знаний (cfa5cdcd): заметка, рождённая в папке задачи,
      // сразу получает ВРЕМЕННУЮ метку «Из задачи: …» и источник. Иначе
      // цепочка рвётся на первом же шаге: метку не поставил никто, триггер
      // разбора видел ноль, категории не появлялись, срез оставался пустым.
      // Постоянную категорию проставляет Помощник владельца — не мы и не роль.
      try {
        if (folderId) {
          const owner = db
            .prepare(
              `SELECT id, title FROM tasks WHERE artifact_folder_id = ?
                 AND archived_at IS NULL LIMIT 1`,
            )
            .get(folderId) as { id: string; title: string } | undefined;
          if (owner) {
            db.prepare(
              "UPDATE user_notes SET kb_temp_category = ?, kb_source_task_id = ? WHERE id = ?",
            ).run(
              `Из задачи: ${String(owner.title ?? "").slice(0, 90)}`,
              owner.id,
              id,
            );
          }
        }
      } catch {
        // Метка — вспомогательная: её отсутствие не должно ронять запись.
      }

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
      /** Схема базы знаний (cfa5cdcd). Разбор ведёт Помощник владельца. */
      kb_temp_category?: string | null;
      kb_category?: string | null;
      kb_source_task_id?: string | null;
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
    // Разметка базы знаний — служебное действие Помощника владельца, а не
    // работа над заметкой. Срез по роли собирается по автору и по дате
    // правки (roleSlice.ts), поэтому общий для всех PATCH хвост
    // «updated_at + updated_by» уводил бы витрину знаний от ролей, которые
    // эти заметки создали: разбор 50 заметок сделал бы их автором того, кто
    // их разбирал. Правка текста, заголовка или папки — обычная работа, и
    // там хвост остаётся.
    let kbOnly = true;

    // Схема базы знаний (cfa5cdcd): категории ставит разбор Помощника владельца.
    // Значение приводится к ограниченному списку — чтобы в базу не попало
    // что попало: мусор с чужой пометкой хуже, чем отсутствие категории.
    for (const k of KB_COLUMNS) {
      if (!has(k)) continue;
      const raw = (req.body as any)[k];
      if (raw === null || raw === undefined || raw === "") {
        sets.push(`${k} = NULL`);
        continue;
      }
      const v = String(raw).trim().slice(0, 120);
      // Списком проверяется ТОЛЬКО постоянная категория. Временная метка —
      // свободная форма ("Из задачи: …"), и источник задачи тоже произвольный.
      if (k === "kb_category" && !KB_CATEGORIES.includes(v)) {
        return reply.code(400).send({
          error: `неизвестная категория «${v}»`,
          допустимые: KB_CATEGORIES,
        });
      }
      sets.push(`${k} = ?`);
      params.push(v);
    }

    if (has("title")) {
      kbOnly = false;
      sets.push("title = ?");
      params.push((req.body.title ?? "").toString().slice(0, 200));
    }
    if (has("markdown") && typeof req.body.markdown === "string") {
      kbOnly = false;
      const tip = markdownToTiptap(req.body.markdown);
      sets.push("content = ?");
      params.push(tip);
      sets.push("search_text = ?");
      params.push(noteSearchText(tip));
      // Заголовок выводим из текста, если его не прислали явно: иначе в
      // списке останется старое название от прежнего содержимого.
      if (!has("title")) {
        sets.push("title = ?");
        params.push(deriveTitleFromMarkdown(req.body.markdown).slice(0, 200));
      }
    } else if (has("content") && typeof req.body.content === "string") {
      kbOnly = false;
      sets.push("content = ?");
      params.push(req.body.content);
      sets.push("search_text = ?");
      params.push(noteSearchText(req.body.content));
    }
    if (has("folder_id")) {
      kbOnly = false;
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
    if (!kbOnly) {
      sets.push("updated_at = datetime('now')", "updated_by = ?");
      params.push(req.userId);
    }
    params.push(id);
    db.prepare(`UPDATE user_notes SET ${sets.join(", ")} WHERE id = ?`).run(
      ...params,
    );
    // Служебная разметка базы знаний (категории, метки) текст документа не
    // меняет — перезаливать из-за неё незачем.
    if (!kbOnly) enqueueNoteIndex(id);
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
        // Подпапки поддерева (папки задач) — клиент строит из них дерево «проект → папки → файлы».
        folders: all
          .filter((f) => ids.has(f.id) && f.id !== project.notes_folder_id)
          .map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name })),
        notes: rows
          .filter((r) => r.folder_id !== null && ids.has(r.folder_id))
          .map((r) => ({
            id: r.id,
            title: r.title,
            папка: byId.get(r.folder_id as number)?.name ?? null,
            folder_id: r.folder_id,
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
      forgetNoteIndex(req.params.id);
      return reply.code(204).send();
    },
  );
}