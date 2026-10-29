// «Входящие» (владелец 28.10.2026, переделка 29.10.2026): это НЕ лента событий,
// а три статуса, которые владелец обязан увидеть — «Заблокировано», «В работе»,
// «На проверке». Строка списка — карточка задачи, тап открывает стандартную
// карточку задачи. Всё остальное (сроки, ближайшие рутины, история падений)
// отсюда убрано: владелец сказал «не соответствует действительности, хуй поймёшь».
//
// Наводящая строка (владелец 29.10.2026): карточка должна сама отвечать на
// вопрос «что делать» — иначе каждую задачу приходится открывать и вникать
// в неё заново. Строку собирает сервер из живых данных задачи
// (`src/lib/attentionContext.ts`), телефон её только рисует.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { attentionHint } from "../lib/attentionContext.js";
import type { AttentionGroupKey } from "../lib/attentionContext.js";

interface AttentionTask {
  id: string;
  title: string;
  project: string | null;
  role: string | null;
  age_seconds: number | null;
  overdue: boolean;
  /** Наводящая строка: что делать с задачей, не открывая карточку. */
  hint: string | null;
  /** Идентификатор исполнителя (`role_qa`, `u-secretary`…) — телефон рисует по нему аватар роли. */
  role_id: string | null;
  /** Приоритет задачи (1 — срочный … 4 — низкий). */
  priority: number | null;
  /** Срок задачи — телефон рисует его чипом, как в остальных списках. */
  due_date: string | null;
  /** Шаги задачи: сколько всего и сколько закрыто. */
  subtask_total: number | null;
  subtask_done: number | null;
}

interface AttentionGroup {
  key: AttentionGroupKey;
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
//
// Дополнительно тянутся данные для наводящей строки: причина блокировки,
// вопрос роли, шаги задачи (заголовок, результат, вердикт, текущий шаг) — и
// то, из чего телефон рисует карточку как остальные списки: аватар роли,
// приоритет, срок, шаги.
const TASKS_SQL = `
  SELECT t.id, t.title, p.name AS project, t.due_date, t.updated_at, t.priority,
         t.blocked_reason, t.clarification_question, t.description,
         (SELECT u.name FROM attempts a JOIN users u ON u.id = a.executor_id
           WHERE a.task_id = t.id ORDER BY a.started_at DESC LIMIT 1) AS role,
         (SELECT u.id FROM attempts a JOIN users u ON u.id = a.executor_id
           WHERE a.task_id = t.id ORDER BY a.started_at DESC LIMIT 1) AS role_id,
         (SELECT count(*) FROM subtasks s WHERE s.task_id = t.id) AS subtask_total,
         (SELECT count(*) FROM subtasks s WHERE s.task_id = t.id AND s.done = 1) AS subtask_done,
         (SELECT s.title FROM subtasks s
           WHERE s.task_id = t.id AND s.done = 0
           ORDER BY s.position DESC LIMIT 1) AS open_step_title,
         (SELECT s.result FROM subtasks s
           WHERE s.task_id = t.id AND s.done = 0 AND s.result IS NOT NULL AND s.result <> ''
           ORDER BY s.position DESC LIMIT 1) AS open_step_result,
         (SELECT s.title FROM subtasks s
           WHERE s.task_id = t.id AND s.agent_state = 'in_progress'
           ORDER BY s.position DESC LIMIT 1) AS active_step_title,
         (SELECT s.result FROM subtasks s
           WHERE s.task_id = t.id AND s.done = 1 AND s.result IS NOT NULL
             AND (s.result LIKE 'approved:%' OR s.result LIKE 'changes_requested:%')
           ORDER BY s.position DESC LIMIT 1) AS verdict_result,
         (SELECT s.title FROM subtasks s
           WHERE s.task_id = t.id AND s.done = 1
           ORDER BY s.position DESC LIMIT 1) AS last_step_title,
         (SELECT s.result FROM subtasks s
           WHERE s.task_id = t.id AND s.done = 1 AND s.result IS NOT NULL AND s.result <> ''
           ORDER BY s.position DESC LIMIT 1) AS last_step_result
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
   WHERE t.status = 'active'
     AND ( t.agent_state = ?
        OR EXISTS (SELECT 1 FROM subtasks s
                    WHERE s.task_id = t.id AND s.done = 0 AND s.agent_state = ?) )
   ORDER BY t.updated_at DESC
   LIMIT 60`;

const GROUPS: { key: AttentionGroupKey; title: string }[] = [
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
        priority: number | null;
        blocked_reason: string | null;
        clarification_question: string | null;
        description: string | null;
        role: string | null;
        role_id: string | null;
        subtask_total: number | null;
        subtask_done: number | null;
        open_step_title: string | null;
        open_step_result: string | null;
        active_step_title: string | null;
        verdict_result: string | null;
        last_step_title: string | null;
        last_step_result: string | null;
      }[]) ?? [];
      const tasks: AttentionTask[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        project: r.project,
        role: r.role,
        age_seconds: secs(r.updated_at),
        overdue: Boolean(r.due_date && r.due_date.slice(0, 10) < today),
        hint: attentionHint({
          group: key,
          title: r.title,
          blockedReason: r.blocked_reason,
          clarificationQuestion: r.clarification_question,
          openStepTitle: r.open_step_title,
          openStepResult: r.open_step_result,
          activeStepTitle: r.active_step_title,
          verdictResult: r.verdict_result,
          lastStepTitle: r.last_step_title,
          lastStepResult: r.last_step_result,
          description: r.description,
        }),
        role_id: r.role_id,
        priority: r.priority,
        due_date: r.due_date,
        subtask_total: r.subtask_total,
        subtask_done: r.subtask_done,
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
