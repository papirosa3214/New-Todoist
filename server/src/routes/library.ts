// ═══════════ TaskFlow Library ═══════════
//
// 08.10.2026. Корневая папка библиотеки знаний (journal_folders с пометкой
// is_kb_root=1, миграция 119_kb_root_folder). Внутри 4 подпапки: Roles,
// Workflows, Norms, Knowledge Base — их читают роли через taskflow_kb_search
// в первую очередь и сами пополняют.
//
// Здесь только список подпапок и число заметок в каждой. Содержимое
// заметок тянется через /api/notes?folder_id=<id> — общий пул.
//
// Эндпоинт прокси к существующей схеме journal_folders/user_notes. Не
// требует bootstrap: без корневой папки возвращает 404.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getKbRoot } from "../lib/notesFolders.js";

export function registerLibraryRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get("/api/library", { preHandler: authPre }, async (_req: any, reply: any) => {
    const root = getKbRoot();
    if (!root) {
      return reply.code(404).send({
        error: "TaskFlow Library не инициализирована",
        detail:
          "Запустите bootstrap: cd server && npx tsx scripts/bootstrap-taskflow-library.ts",
      });
    }
    const subfolders = db
      .prepare(
        `SELECT f.id, f.name, f.position,
                (SELECT COUNT(*) FROM user_notes n WHERE n.folder_id = f.id) AS notes_count
           FROM journal_folders f
          WHERE f.parent_id = ?
          ORDER BY f.position, f.name`,
      )
      .all(root.id) as Array<{ id: number; name: string; position: number; notes_count: number }>;
    return {
      root: { id: root.id, name: root.name },
      subfolders,
    };
  });
}