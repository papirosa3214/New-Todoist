// «Входящие» (владелец 28.10.2026, переделка 29.10.2026): это НЕ лента событий,
// а три статуса, которые владелец обязан увидеть — «Заблокировано», «В работе»,
// «На проверке». Строка списка — карточка задачи, тап открывает стандартную
// карточку задачи. Всё остальное (сроки, ближайшие рутины, история падений)
// отсюда убрано: владелец сказал «не соответствует действительности, хуй поймёшь».
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

interface AttentionTask {
  id: string;
  title: string;
  project: string | null;
  role: string | null;
  age_seconds: number | null;
  overdue: boolean;
}

interface AttentionGroup {
  key: "blocked" | "in_progress" | "review";
  title: string;
  count: number;
  tasks: AttentionTask[];
}

const secs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
};

// Задача попадает в группу, если её собственный agent_state такой ИЛИ такой есть
// у живого шага внутри неё: в вебе «В работе» на плитке считается именно так —
// иначе задача без своего agent_state (обычный случай) пропадала из списка.
const TASKS_SQL = `
  SELECT t.id, t.title, p.name AS project, t.due_date, t.updated_at,
         (SELECT u.name FROM attempts a JOIN users u ON u.id = a.executor_id
           WHERE a.task_id = t.id ORDER BY a.started_at DESC LIMIT 1) AS role
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
   WHERE t.status = 'active'
     AND ( t.agent_state = ?
        OR EXISTS (SELECT 1 FROM subtasks s
                    WHERE s.task_id = t.id AND s.done = 0 AND s.agent_state = ?) )
   ORDER BY t.updated_at DESC
   LIMIT 60`;

const GROUPS: { key: AttentionGroup["key"]; title: string }[] = [
  { key: "blocked", title: "Заблокировано" },
  { key: "in_progress", title: "В работе" },
  { key: "review", title: "На проверке" },
];

const todayMoscow = (): string => {
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
};

export async function registerAttentionRoutes(app: FastifyInstance) {
  app.get("/api/attention", { preHandler: authOrApiToken }, async () => {
    const today = todayMoscow();
    const groups: AttentionGroup[] = GROUPS.map(({ key, title }) => {
      const rows = (db.prepare(TASKS_SQL).all(key, key) as {
        id: string;
        title: string;
        project: string | null;
        due_date: string | null;
        updated_at: string | null;
        role: string | null;
      }[]) ?? [];
      const tasks: AttentionTask[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        project: r.project,
        role: r.role,
        age_seconds: secs(r.updated_at),
        overdue: Boolean(r.due_date && r.due_date.slice(0, 10) < today),
      }));
      return { key, title, count: tasks.length, tasks };
    });

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      groups,
      counts: Object.fromEntries(groups.map((g) => [g.key, g.count])),
    };
  });
}

// Одна строка на событие — для будущих уведомлений в Telegram.
export const attentionLine = (group: AttentionGroup, task: AttentionTask): string =>
  `[attention] ${group.title}: ${task.title}${task.project ? " (" + task.project + ")" : ""}`;
