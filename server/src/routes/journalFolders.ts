// ═══════════ Дневник — папки заметок ═══════════
//
// CRUD для древовидных папок, в которые раскладываются заметки Дневника
// (см. .hermes/plans/journal-folders.md, миграция 012_journal_folders,
// 26.08.2026). Сами папки лежат в одной общей ленте на аккаунт —
// общий дневник владельца и агентов.
//
// Дерево собирается из плоского списка на клиенте (там и UI, и
// drag-and-drop); сервер держит только parent_id и сортировку
// position между братьями.
//
// ВАЖНО: заметка не должна пропадать при удалении папки — поэтому
// ON DELETE SET NULL на folder_id (см. миграцию). API удаления
// папки просто молча снимает папку со своих записей и удаляет
// саму папку (плюс её подпапки каскадом — ON DELETE CASCADE на
// parent_id).
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ApiJournalFolder {
  id: number;
  parent_id: number | null;
  name: string;
  position: number;
}

function toApi(row: FolderRow): ApiJournalFolder {
  return {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    position: row.position,
  };
}

export function registerJournalFolderRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get("/api/journal/folders", { preHandler: authPre }, async () => {
    const rows = db
      .prepare(
        "SELECT id, parent_id, name, position, created_at, updated_at FROM journal_folders ORDER BY parent_id IS NULL DESC, parent_id, position, id",
      )
      .all() as FolderRow[];
    return { folders: rows.map(toApi) };
  });

  app.post<{ Body: { name: string; parent_id?: number | null; position?: number } }>(
    "/api/journal/folders",
    { preHandler: authPre },
    async (req: any, reply) => {
      const name = (req.body?.name ?? "").toString().trim();
      if (!name) return reply.code(400).send({ error: "Имя папки не может быть пустым" });
      if (name.length > 80) return reply.code(400).send({ error: "Имя папки слишком длинное" });
      const parentId = req.body?.parent_id ?? null;
      const position = typeof req.body?.position === "number" ? req.body.position : 0;
      // Защита от циклов: parent_id не должен указывать на существующий
      // потомок (здесь parent_id === null, так что цикл исключён на
      // первом уровне; цикл может возникнуть только если клиент шлёт
      // существующий parent_id — он не существующий потомок по построению,
      // но проверка на null тоже не лишняя).
      if (parentId !== null) {
        const exists = db
          .prepare("SELECT id FROM journal_folders WHERE id = ?")
          .get(parentId) as { id: number } | undefined;
        if (!exists) return reply.code(400).send({ error: "Родительская папка не найдена" });
      }
      const result = db
        .prepare(
          `INSERT INTO journal_folders (parent_id, name, position)
           VALUES (?, ?, ?)`,
        )
        .run(parentId, name, position);
      const id = Number(result.lastInsertRowid);
      const row = db
        .prepare(
          "SELECT id, parent_id, name, position, created_at, updated_at FROM journal_folders WHERE id = ?",
        )
        .get(id) as FolderRow;
      return { folder: toApi(row) };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; parent_id?: number | null; position?: number } }>(
    "/api/journal/folders/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "Неверный id" });
      const existing = db
        .prepare("SELECT id FROM journal_folders WHERE id = ?")
        .get(id) as { id: number } | undefined;
      if (!existing) return reply.code(404).send({ error: "Папка не найдена" });

      const updates: string[] = [];
      const params: unknown[] = [];
      if (typeof req.body?.name === "string") {
        const name = req.body.name.trim();
        if (!name) return reply.code(400).send({ error: "Имя папки не может быть пустым" });
        if (name.length > 80) return reply.code(400).send({ error: "Имя папки слишком длинное" });
        updates.push("name = ?");
        params.push(name);
      }
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "parent_id")) {
        const parentId = req.body.parent_id;
        if (parentId !== null) {
          if (!Number.isFinite(parentId))
            return reply.code(400).send({ error: "Неверный parent_id" });
          if (parentId === id)
            return reply.code(400).send({ error: "Папка не может быть родителем самой себя" });
          // Защита от циклов: новый родитель не должен быть потомком этой папки.
          // Идём вверх по parent_id от parentId — если встретили `id`, цикл.
          let cur: number | null = parentId;
          const seen = new Set<number>();
          while (cur !== null) {
            if (seen.has(cur)) break;
            seen.add(cur);
            if (cur === id)
              return reply
              .code(400)
              .send({ error: "Нельзя переместить папку внутрь её потомка" });
            const row = db
              .prepare("SELECT parent_id FROM journal_folders WHERE id = ?")
              .get(cur) as { parent_id: number | null } | undefined;
            cur = row?.parent_id ?? null;
          }
        }
        updates.push("parent_id = ?");
        params.push(parentId);
      }
      if (typeof req.body?.position === "number") {
        updates.push("position = ?");
        params.push(req.body.position);
      }
      if (updates.length === 0) {
        const row = db
          .prepare(
            "SELECT id, parent_id, name, position, created_at, updated_at FROM journal_folders WHERE id = ?",
          )
          .get(id) as FolderRow;
        return { folder: toApi(row) };
      }
      updates.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(
        `UPDATE journal_folders SET ${updates.join(", ")} WHERE id = ?`,
      ).run(...params);
      const row = db
        .prepare(
          "SELECT id, parent_id, name, position, created_at, updated_at FROM journal_folders WHERE id = ?",
        )
        .get(id) as FolderRow;
      return { folder: toApi(row) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/journal/folders/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: "Неверный id" });
      // Заметки получают folder_id = NULL через ON DELETE SET NULL
      // (см. миграцию 012_journal_folders) — заметки «выпадают» в корень
      // «Без папки», не теряются. Подпапки каскадом удаляются по parent_id
      // (ON DELETE CASCADE).
      const result = db.prepare("DELETE FROM journal_folders WHERE id = ?").run(id);
      if (result.changes === 0) return reply.code(404).send({ error: "Папка не найдена" });
      return reply.code(204).send();
    },
  );
}