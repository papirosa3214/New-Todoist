import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { seesEveryTask, visibleScope } from "../access.js";

// SQLite's built-in LOWER() only folds ASCII — it does NOT lowercase Cyrillic
// (verified on this machine: both the sqlite3 CLI and the better-sqlite3 build
// used by this server return "Максим" unchanged from `SELECT LOWER('Максим')`).
// Register a JS-backed SQL function so case-insensitive search works for
// Cyrillic (and any other Unicode text) via JS's locale-aware toLowerCase().
// Registered once at module load (ESM modules are evaluated once), not per
// request, so it's cheap and safe to call from every query below.
db.function("lower_uni", (value: unknown) =>
  value == null ? null : String(value).toLowerCase(),
);

export function registerSearchRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get<{ Querystring: { q?: string } }>(
    "/api/search",
    { preHandler: authPre },
    async (req: any) => {
      const rawQuery = (req.query.q || "").trim();
      const userId = req.userId;

      // Split query into words and filter empty tokens
      const words = rawQuery
        .split(/\s+/)
        .map((w: string) => w.toLowerCase())
        .filter((w: string) => w.length > 0);

      // Empty query returns empty results
      if (words.length === 0) {
        return { tasks: [], projects: [], labels: [] };
      }

      // Build SQL WHERE clause with AND-ed word conditions
      // Each word must appear in title or description, but not necessarily in same field
      // Кому какие задачи видны — то же правило, что и у /api/tasks
      // (access.ts): владельцу и его агентам все, прочему человеку свои.
      // Раньше поиск жил по собственному, ещё более узкому предикату
      // (только creator/assignee) — и находил не то, что показывает доска.
      const seesAll = seesEveryTask(userId);
      const wordConditions: string[] = [];
      const params: any[] = seesAll ? [] : [userId, userId];

      for (const word of words) {
        // Case-insensitive match in title or description via lower_uni().
        // `word` is already lowercased above, so no extra variants are needed.
        wordConditions.push(
          `(instr(lower_uni(t.title), ?) > 0
            OR instr(lower_uni(COALESCE(t.description, '')), ?) > 0)`,
        );

        params.push(word, word);
      }

      // Search tasks by title or description
      const tasks = db
        .prepare(
          `
        SELECT t.*, u.name as assignee_name, u.type as assignee_type, u.avatar_color as assignee_color, u.avatar_url as assignee_avatar_url, u.initials as assignee_initials,
               p.name as project_name, p.color as project_color
        FROM tasks t
        LEFT JOIN users u ON t.assignee_id = u.id
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE ${seesAll ? "1 = 1" : "(t.creator_id = ? OR t.assignee_id = ?)"}
          AND ${wordConditions.join(" AND ")}
        ORDER BY t.created_at DESC
      `,
        )
        .all(...params) as any[];

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

      // Build project search conditions
      const projectScope = visibleScope(userId, "p.owner_id");
      const projectWordConditions: string[] = [];
      const projectParams: any[] = [...projectScope.params];

      for (const word of words) {
        projectWordConditions.push(`instr(lower_uni(p.name), ?) > 0`);
        projectParams.push(word);
      }

      // Search projects by name
      const projects = db
        .prepare(
          `
        SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count
        FROM projects p
        WHERE ${projectScope.sql}
          AND ${projectWordConditions.join(" AND ")}
        ORDER BY p.created_at DESC
      `,
        )
        .all(...projectParams) as any[];

      // Build labels search conditions
      const labelScope = visibleScope(userId, "l.owner_id");
      const labelWordConditions: string[] = [];
      const labelParams: any[] = [...labelScope.params];

      for (const word of words) {
        labelWordConditions.push(`instr(lower_uni(l.name), ?) > 0`);
        labelParams.push(word);
      }

      // Search labels by name
      const labels = db
        .prepare(
          `
        SELECT l.*
        FROM labels l
        WHERE ${labelScope.sql}
          AND ${labelWordConditions.join(" AND ")}
        ORDER BY l.id
      `,
        )
        .all(...labelParams) as any[];

      return {
        tasks: enrichedTasks,
        projects,
        labels,
      };
    },
  );
}
