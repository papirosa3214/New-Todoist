// ═══════════ Папки базы знаний: список и защищённая уборка ═══════════
//
// Карточка 1c93ff67 «Следить за чистотой и порядком в базе знаний».
//
// Зачем отдельный маршрут, если есть /api/journal/folders:
//   • маршрут Дневника удаляет папку «как есть» — без сверки с библиотекой,
//     задачей и очередью разбора. Роли (Помощник владельца в этой карточке)
//     просили операцию с защитами: нельзя корень библиотеки и его разделы,
//     нельзя папку живой (незакрытой) задачи, нельзя папку с неразобранными
//     заметками;
//   • правка идёт ЧЕРЕЗ приложение. Само удаление папки выполняет тот же
//     код, что и DELETE /api/journal/folders/:id (deleteJournalFolder в
//     routes/journalFolders.ts): заметки «выпадают» в корень (ON DELETE SET
//     NULL), подпапки уходят каскадом. Роль не правит базу мимо API.
//
// Доступ: как у прочих маршрутов трекера (authOrApiToken). Роль ходит сюда
// своим же JWT (asRole в runtime/inProcessRun.ts) — отдельный токен ей не
// нужен. Маршрут уборки — POST, а не DELETE: общая дверь authOrApiToken
// (deleteForbidden) запрещает делегированным ролям физическое удаление, а
// здесь удаление папки базы знаний — ровно та операция, ради которой
// карточка и заведена; защиты проверяются внутри маршрута.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import {
  cleanupCandidates,
  folderDeleteReasons,
  hotBackupDb,
  listFolderInventory,
  moveCategorizedNotes,
  type FolderInventoryRow,
} from "../lib/kbFolderOps.js";
import { deleteJournalFolder } from "./journalFolders.js";

export function registerKbFolderRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Список папок: id, имя, родитель, число заметок, привязанная задача и её
  // состояние, признак корня библиотеки — плюс вердикт по каждой папке
  // (можно ли удалять и почему нельзя) и кандидаты на уборку.
  app.get("/api/kb/folders", { preHandler: authPre }, async () => {
    const folders: FolderInventoryRow[] = listFolderInventory();
    return {
      корень_библиотеки: folders.find((f) => f.is_kb_root)?.id ?? null,
      папок: folders.length,
      папки: folders,
      кандидаты_на_уборку: cleanupCandidates(),
    };
  });

  // Защищённая уборка одной папки по id.
  //
  // Порядок: проверка защит → горячий бэкап БД → перенос заметок с
  // постоянной категорией в раздел библиотеки → удаление папки.
  app.post<{ Params: { id: string } }>(
    "/api/kb/folders/:id/prune",
    { preHandler: authPre },
    async (req: any, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "Неверный id" });

      const folder = db
        .prepare("SELECT id, name FROM journal_folders WHERE id = ?")
        .get(id) as { id: number; name: string } | undefined;
      if (!folder) return reply.code(404).send({ error: "Папка не найдена" });

      const reasons = folderDeleteReasons(id);
      if (reasons.length > 0) {
        return reply.code(409).send({ error: "Папку убрать нельзя", причины: reasons });
      }

      // Заметки с постоянной категорией уходят в раздел библиотеки — иначе
      // удаление папки оставило бы нужные заметки без дома.
      const { moved, left } = moveCategorizedNotes(id);
      if (left.length > 0) {
        return reply.code(409).send({
          error: "Часть заметок некуда перенести — папка не тронута",
          оставлены: left,
        });
      }

      // Заметки с пометкой «мусор» удалять нельзя: правило владельца от
      // 21.10.2026 — удаление в приложении это архивирование, а не стирание
      // строк. Они остаются в базе без папки (ON DELETE SET NULL) — сколько
      // их, показывает ответ.
      const leftover = db
        .prepare(
          "SELECT COUNT(*) AS n FROM user_notes WHERE folder_id = ? AND kb_category IS NULL",
        )
        .get(id) as { n: number };

      const backup = await hotBackupDb("kb-folder-prune");

      // Удаление — тот же код, что и DELETE /api/journal/folders/:id.
      if (!deleteJournalFolder(id)) {
        return reply.code(404).send({ error: "Папка не найдена" });
      }
      return {
        удалена: { id: folder.id, name: folder.name },
        перенесено_в_разделы: moved,
        осталось_без_папки: leftover.n,
        бэкап: backup,
      };
    },
  );
}
