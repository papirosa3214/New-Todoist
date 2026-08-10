import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

export function registerSearchRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get<{ Querystring: { q?: string } }>(
    "/api/search",
    { preHandler: authPre },
    async (req: any) => {
      const query = (req.query.q || "").trim().toLowerCase();
      const userId = req.userId;

      // Empty or too short query
      if (!query || query.length < 1) {
        return { tasks: [], projects: [], labels: [] };
      }

      // Search tasks by title or description
      // SQLite has issues with case-insensitive search for Cyrillic via LOWER/UPPER
      // Use instr() with multiple case variants
      const upperQuery = query.toUpperCase();
      const capitalizedQuery =
        query.charAt(0).toUpperCase() + query.slice(1).toLowerCase();
      const tasks = db
        .prepare(
          `
        SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials,
               p.name as project_name, p.color as project_color
        FROM tasks t
        LEFT JOIN users u ON t.assignee_id = u.id
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE (t.creator_id = ? OR t.assignee_id = ?)
          AND (instr(t.title, ?) > 0 OR instr(t.title, ?) > 0 OR instr(t.title, ?) > 0
            OR instr(t.description, ?) > 0 OR instr(t.description, ?) > 0 OR instr(t.description, ?) > 0)
        ORDER BY t.created_at DESC
      `,
        )
        .all(
          userId,
          userId,
          query,
          upperQuery,
          capitalizedQuery,
          query,
          upperQuery,
          capitalizedQuery,
        ) as any[];

      // Enrich tasks with labels and subtasks
      const stmtLabels = db.prepare(`
        SELECT l.id, l.name, l.color FROM labels l
        JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
      `);
      const stmtSub = db.prepare(
        "SELECT * FROM subtasks WHERE task_id = ? ORDER BY position",
      );

      const enrichedTasks = tasks.map((t: any) => ({
        ...t,
        labels: stmtLabels.all(t.id),
        subtasks: stmtSub.all(t.id).map((s: any) => ({ ...s, done: !!s.done })),
      }));

      // Search projects by name
      const projects = db
        .prepare(
          `
        SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count
        FROM projects p
        WHERE p.owner_id = ?
          AND (instr(p.name, ?) > 0 OR instr(p.name, ?) > 0 OR instr(p.name, ?) > 0)
        ORDER BY p.created_at DESC
      `,
        )
        .all(userId, query, upperQuery, capitalizedQuery) as any[];

      // Search labels by name
      const labels = db
        .prepare(
          `
        SELECT l.*
        FROM labels l
        WHERE l.owner_id = ?
          AND (instr(l.name, ?) > 0 OR instr(l.name, ?) > 0 OR instr(l.name, ?) > 0)
        ORDER BY l.id
      `,
        )
        .all(userId, query, upperQuery, capitalizedQuery) as any[];

      return {
        tasks: enrichedTasks,
        projects,
        labels,
      };
    },
  );
}
