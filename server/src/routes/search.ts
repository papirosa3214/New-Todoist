import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

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
      const wordConditions: string[] = [];
      const params: any[] = [userId, userId]; // Start with userId for creator_id and assignee_id

      for (const word of words) {
        const upperWord = word.toUpperCase();
        const capitalizedWord =
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

        // Each word condition: match in title or description with any of 3 case variants
        wordConditions.push(
          `(instr(t.title, ?) > 0 OR instr(t.title, ?) > 0 OR instr(t.title, ?) > 0
            OR instr(COALESCE(t.description, ''), ?) > 0 OR instr(COALESCE(t.description, ''), ?) > 0 OR instr(COALESCE(t.description, ''), ?) > 0)`,
        );

        // Add parameters for this word (3 variants × 2 fields = 6 params per word)
        params.push(word, upperWord, capitalizedWord); // for title
        params.push(word, upperWord, capitalizedWord); // for description
      }

      // Search tasks by title or description
      const tasks = db
        .prepare(
          `
        SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.initials as assignee_initials,
               p.name as project_name, p.color as project_color
        FROM tasks t
        LEFT JOIN users u ON t.assignee_id = u.id
        LEFT JOIN projects p ON t.project_id = p.id
        WHERE (t.creator_id = ? OR t.assignee_id = ?)
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
      const projectWordConditions: string[] = [];
      const projectParams: any[] = [userId];

      for (const word of words) {
        const upperWord = word.toUpperCase();
        const capitalizedWord =
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

        projectWordConditions.push(
          `(instr(p.name, ?) > 0 OR instr(p.name, ?) > 0 OR instr(p.name, ?) > 0)`,
        );

        projectParams.push(word, upperWord, capitalizedWord);
      }

      // Search projects by name
      const projects = db
        .prepare(
          `
        SELECT p.*, (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count
        FROM projects p
        WHERE p.owner_id = ?
          AND ${projectWordConditions.join(" AND ")}
        ORDER BY p.created_at DESC
      `,
        )
        .all(...projectParams) as any[];

      // Build labels search conditions
      const labelWordConditions: string[] = [];
      const labelParams: any[] = [userId];

      for (const word of words) {
        const upperWord = word.toUpperCase();
        const capitalizedWord =
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

        labelWordConditions.push(
          `(instr(l.name, ?) > 0 OR instr(l.name, ?) > 0 OR instr(l.name, ?) > 0)`,
        );

        labelParams.push(word, upperWord, capitalizedWord);
      }

      // Search labels by name
      const labels = db
        .prepare(
          `
        SELECT l.*
        FROM labels l
        WHERE l.owner_id = ?
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
