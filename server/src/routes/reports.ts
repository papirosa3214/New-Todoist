// Отчёты по задаче: собрать из markdown (светлый HTML + PDF) и положить
// «зеркалом» — физически документом в папке проекта, а в карточке задачи
// он появляется отдельной секцией, не вложением.
//
// Владелец 20.09.2026: «отметка, когда сделан, кем и по какой задаче» — это
// титул и колонтитул HTML/PDF; «зеркало файла, который физически лежит в
// доках проекта» — заметка в notes_folder_id проекта + запись в task_reports.
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, getTaskForWrite } from "../access.js";
import { buildReport } from "../lib/report.js";
import { markdownToTiptap } from "../lib/markdownToTiptap.js";

const uid = () => crypto.randomUUID();

function authorName(userId: string): string {
  const row = db
    .prepare("SELECT name FROM users WHERE id = ?")
    .get(userId) as { name?: string } | undefined;
  return row?.name ?? "TaskFlow";
}

export function registerReportRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Собрать отчёт: markdown → HTML+PDF, зеркало-заметка в доках проекта.
  app.post<{
    Params: { id: string };
    Body: { title?: string; markdown?: string };
  }>(
    "/api/tasks/:id/reports",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });

      const title = String(req.body?.title || "Отчёт").trim().slice(0, 200);
      const markdown = String(req.body?.markdown || "").trim();
      if (markdown.length < 20) {
        return reply.code(400).send({ error: "markdown слишком короткий" });
      }

      const author = authorName(req.userId);
      const date = new Date().toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        dateStyle: "long",
        timeStyle: "short",
      });

      let built: { id: string; htmlPath: string; pdfPath: string };
      try {
        built = await buildReport({
          title,
          markdown,
          taskId: task.id,
          taskTitle: task.title,
          author,
          date,
        });
      } catch (e) {
        return reply
          .code(502)
          .send({ error: `не удалось собрать отчёт: ${(e as Error).message}` });
      }

      // Зеркало: документ в папке проекта.
      let noteId: string | null = null;
      const projectId = (task as { project_id?: string | null }).project_id;
      if (projectId) {
        const project = db
          .prepare("SELECT notes_folder_id FROM projects WHERE id = ?")
          .get(projectId) as { notes_folder_id?: number | null } | undefined;
        const folderId = project?.notes_folder_id;
        if (folderId) {
          noteId = uid();
          const header =
            `# ${title}\n\n` +
            `_Отчёт по задаче «${task.title}» · ${author} · ${date}_\n\n`;
          const content = markdownToTiptap(header + markdown);
          db.prepare(
            `INSERT INTO user_notes (id, title, content, folder_id, updated_by)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(noteId, `Отчёт: ${title}`, content, folderId, req.userId);
        }
      }

      db.prepare(
        `INSERT INTO task_reports
           (id, task_id, note_id, title, author_id, author_name, html_path, pdf_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        built.id,
        task.id,
        noteId,
        title,
        req.userId,
        author,
        built.htmlPath,
        built.pdfPath,
      );

      return { id: built.id, note_id: noteId, title, author, date };
    },
  );

  // Список отчётов задачи — для секции «Отчёты» в карточке.
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/reports",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Задача не найдена" });
      const rows = db
        .prepare(
          `SELECT id, note_id, title, author_name, created_at
             FROM task_reports WHERE task_id = ? ORDER BY created_at DESC`,
        )
        .all(req.params.id);
      return { reports: rows };
    },
  );

  // Отдать файл отчёта (pdf|html). Доступ — как к самой задаче.
  app.get<{ Params: { id: string; format: string } }>(
    "/api/reports/:id/:format",
    { preHandler: authPre },
    async (req: any, reply) => {
      const row = db
        .prepare(
          `SELECT r.*, r.task_id AS task_id FROM task_reports r WHERE r.id = ?`,
        )
        .get(req.params.id) as any;
      if (!row) return reply.code(404).send({ error: "Отчёт не найден" });
      if (!getTaskForRead(row.task_id, req.userId)) {
        return reply.code(404).send({ error: "Отчёт не найден" });
      }
      const fmt = String(req.params.format).toLowerCase();
      const file = fmt === "pdf" ? row.pdf_path : fmt === "html" ? row.html_path : null;
      if (!file || !fs.existsSync(file)) {
        return reply.code(404).send({ error: "Файл отчёта не найден" });
      }
      reply.header(
        "Content-Type",
        fmt === "pdf" ? "application/pdf" : "text/html; charset=utf-8",
      );
      reply.header(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(row.title)}.${fmt}`,
      );
      return reply.send(fs.createReadStream(file));
    },
  );
}
