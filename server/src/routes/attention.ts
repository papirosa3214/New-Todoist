// «Входящие» (владелец 28.10.2026): один экран, где видно всё, что требует
// внимания владельца — решения по шагам и карточкам, вопросы ролей с кнопками,
// сбои и зависшие ходы, сроки на сегодня, кто работает прямо сейчас и что
// ближайшее по расписанию.
//
// Почему отдельный маршрут, а не четыре запроса с клиента: iOS должен рисовать
// экран одним ответом, иначе он мигает секциями и тратит батарею. Тот же
// агрегат позже станет источником уведомлений в Telegram (заметка
// 98da3c94-a9b7-4431-8cb5-d52f74a29199).
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";

type Action = "answer" | "approve" | "restart" | "cancel" | "open";

interface AttentionItem {
  kind: "task" | "step" | "chat" | "attempt" | "silent" | "routine";
  id: string;
  /** Карточка, к которой относится событие — по ней экран открывает задачу. */
  task_id?: string;
  title: string;
  context: string | null;
  role: string | null;
  age_seconds: number | null;
  actions: Action[];
}

const secs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
};

const QUEUE_SQL = (role: string | null) => role ?? "—";

export async function registerAttentionRoutes(app: FastifyInstance) {
  app.get("/api/attention", { preHandler: authOrApiToken }, async () => {
    // 1. Решения: карточки в blocked/review и шаги, ждущие владельца.
    const tasks = (db
      .prepare(
        `SELECT t.id, t.title, t.agent_state, p.name AS project_name
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.status = 'active' AND t.agent_state IN ('blocked','review')
          ORDER BY CASE t.agent_state WHEN 'blocked' THEN 0 ELSE 1 END, t.updated_at DESC
          LIMIT 50`,
      )
      .all() as { id: string; title: string; agent_state: string; project_name: string | null }[]) ?? [];

    const steps = (db
      .prepare(
        `SELECT s.id, s.title, s.agent_state, s.agent_heartbeat_at, s.task_id,
                t.title AS task_title
           FROM subtasks s JOIN tasks t ON t.id = s.task_id
          WHERE s.done = 0 AND s.agent_state = 'blocked' AND t.status = 'active'
          ORDER BY s.position
          LIMIT 50`,
      )
      .all() as {
      id: string;
      title: string;
      agent_state: string;
      agent_heartbeat_at: string | null;
      task_id: string;
      task_title: string;
    }[]) ?? [];

    // 2. Вопросы ролей: последнее сообщение в чате несёт кнопки-развилки и оно
    //    не от владельца (значит ответа ещё нет).
    const questions = (db
      .prepare(
        `SELECT * FROM (
           SELECT m.chat_id, m.id, m.text, m.created_at, m.quick_replies,
                  u.name AS role_name, u.role AS role
             FROM chat_messages m JOIN users u ON u.id = m.from_user_id
            WHERE m.chat_id IS NOT NULL
         ) WHERE role IS NOT NULL AND role <> 'owner' AND quick_replies IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 30`,
      )
      .all() as {
      chat_id: string;
      id: string;
      text: string;
      created_at: string;
      quick_replies: string | null;
      role_name: string;
      role: string;
    }[]) ?? [];

    const decisions: AttentionItem[] = [
      ...tasks.map((t) => ({
        kind: "task" as const,
        id: t.id,
        task_id: t.id,
        title: t.title,
        context: t.project_name,
        role: null,
        age_seconds: null,
        actions: (t.agent_state === "review" ? ["approve", "open"] : ["answer", "open"]) as Action[],
      })),
      ...steps.map((s) => ({
        kind: "step" as const,
        id: s.id,
        task_id: s.task_id,
        title: s.title,
        context: s.task_title,
        role: null,
        age_seconds: secs(s.agent_heartbeat_at),
        actions: ["answer", "open"] as Action[],
      })),
      ...questions.map((q) => ({
        kind: "chat" as const,
        id: q.chat_id,
        title: String(q.text || "").split("\n")[0].slice(0, 140),
        context: "вопрос с вариантами",
        role: q.role_name,
        age_seconds: secs(q.created_at),
        actions: ["answer", "open"] as Action[],
      })),
    ];

    // 3. Сбои: упавшие попытки за сутки и шаги, молчащие дольше 10 минут.
    const failures = (db
      .prepare(
        `SELECT a.id, a.task_id, a.outcome, a.reason, a.ended_at, u.name AS executor
           FROM attempts a LEFT JOIN users u ON u.id = a.executor_id
          WHERE a.ended_at IS NOT NULL
            AND a.outcome IN ('error','error_loop','failed','timeout')
            AND a.ended_at >= datetime('now','-6 hours')
          ORDER BY a.ended_at DESC
          LIMIT 30`,
      )
      .all() as { id: string; task_id: string; outcome: string; reason: string | null; ended_at: string; executor: string | null }[]) ?? [];

    const silent = (db
      .prepare(
        `SELECT s.id, s.task_id, s.title, s.agent_heartbeat_at, t.title AS task_title
           FROM subtasks s JOIN tasks t ON t.id = s.task_id
          WHERE s.done = 0 AND s.agent_state = 'in_progress'
            AND s.agent_heartbeat_at IS NOT NULL
            AND s.agent_heartbeat_at <= datetime('now','-10 minutes')
          LIMIT 30`,
      )
      .all() as { id: string; task_id: string; title: string; agent_heartbeat_at: string; task_title: string }[]) ?? [];

    const failuresOut = [
      ...failures.map((f) => ({
        kind: "attempt" as const,
        id: f.id,
        task_id: f.task_id,
        title: `${f.outcome}${f.reason ? ": " + f.reason.slice(0, 120) : ""}`,
        context: f.task_id,
        role: f.executor,
        age_seconds: secs(f.ended_at),
        actions: ["restart", "open"] as Action[],
      })),
      ...silent.map((s) => ({
        kind: "silent" as const,
        id: s.id,
        task_id: s.task_id,
        title: `шаг молчит: ${s.title}`,
        context: s.task_title,
        role: null,
        age_seconds: secs(s.agent_heartbeat_at),
        actions: ["restart", "cancel"] as Action[],
      })),
    ];

    // 4. Сроки на сегодня (по Москве) — активные задачи с датой «сегодня».
    const today = (db
      .prepare(
        `SELECT t.id, t.title, t.due_date, p.name AS project_name
           FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.status = 'active' AND date(t.due_date) = date('now','+3 hours')
          ORDER BY t.due_date
          LIMIT 50`,
      )
      .all() as { id: string; title: string; due_date: string; project_name: string | null }[]) ?? [];

    // 5. Кто работает прямо сейчас.
    const running = (db
      .prepare(
        `SELECT a.id, a.started_at, a.task_id, u.name AS executor, t.title AS task_title
           FROM attempts a LEFT JOIN users u ON u.id = a.executor_id
           LEFT JOIN tasks t ON t.id = a.task_id
          WHERE a.ended_at IS NULL
          ORDER BY a.started_at DESC
          LIMIT 20`,
      )
      .all() as { id: string; started_at: string; task_id: string; executor: string | null; task_title: string | null }[]) ?? [];

    // 6. Ближайшее по рутинам.
    const upcoming = (db
      .prepare(
        `SELECT id, title, next_run_at FROM task_schedules
          WHERE status = 'active' AND next_run_at IS NOT NULL
          ORDER BY next_run_at LIMIT 5`,
      )
      .all() as { id: string; title: string; next_run_at: string }[]) ?? [];

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      decisions,
      failures: failuresOut,
      today: today.map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, project: t.project_name })),
      running: running.map((r) => ({
        id: r.id,
        task_id: r.task_id,
        title: r.task_title ?? "—",
        role: r.executor,
        since_seconds: secs(r.started_at),
      })),
      upcoming: upcoming.map((u) => ({ id: u.id, kind: "routine" as const, title: u.title, at: u.next_run_at })),
      counts: {
        decisions: decisions.length,
        failures: failuresOut.length,
        today: today.length,
        running: running.length,
      },
    };
  });
}

// Небольшая утилита для логов и будущих уведомлений: одна строка на событие.
export const attentionLine = (item: AttentionItem): string => `[attention] ${QUEUE_SQL(item.role)} ${item.kind}:${item.id} — ${item.title}`;
