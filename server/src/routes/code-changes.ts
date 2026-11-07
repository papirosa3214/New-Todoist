// Карточка задачи → «Изменения кода»: что роль поменяла в своей ветке.
// LOCK-TASK-CODE-CHANGES-20261027. Только чтение, только владелец.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { taskCodeChanges } from "../lib/worktree/codeChanges.js";

export function registerCodeChangesRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/code-changes",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
      const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id);
      if (!task) return reply.code(404).send({ error: "Not found" });
      // Влитая ветка: диапазон, который записала очередь слияний.
      const row = db
        .prepare("SELECT main_sha_before, result_sha FROM worktree_merge_queue WHERE task_id = ? AND state = ?")
        .get(req.params.id, "merged") as { main_sha_before: string | null; result_sha: string | null } | undefined;
      const merged =
        row?.main_sha_before && row.result_sha ? { before: row.main_sha_before, after: row.result_sha } : null;
      return taskCodeChanges(req.params.id, { merged });
    },
  );
}
