// MAK-76: кнопки владельца — «Возобновить зависшие шаги» и «Перезапустить сервер».
// Только владелец. Возобновление не перезапускает сервер: берёт узлы плана
// «в работе» без живого запуска и без свежего пульса и ведёт тем же путём,
// что и восстановление при старте (recoverInterruptedPlanSubtasks).
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { activeInProcessRun, listActiveInProcessRuns } from "../runtime/inProcessRun.js";
import { recoverInterruptedPlanSubtasks, type PlanSubtask } from "../runtime/planSubtaskAdmission.js";

/** Пульс свежее этого (секунд) — шаг считается живым, даже если запуска в памяти не видно (он только стартует). */
const HEARTBEAT_GRACE_SEC = 120;

type StuckRow = { id: string; task_id: string; title: string; plan_node_key: string | null; agent_heartbeat_at: string | null };

/** Узлы плана «в работе» без живого запуска и без свежего пульса. */
export function findStuckSubtasks(): StuckRow[] {
  const rows = db.prepare(
    `SELECT id, task_id, title, plan_node_key, agent_heartbeat_at
       FROM subtasks
      WHERE collaboration_plan_id IS NOT NULL AND done = 0 AND agent_state = 'in_progress'
        AND (agent_heartbeat_at IS NULL OR agent_heartbeat_at < datetime('now', ?))`,
  ).all(`-${HEARTBEAT_GRACE_SEC} seconds`) as StuckRow[];
  return rows.filter((r) => !activeInProcessRun(r.task_id, r.id));
}

type Restarter = () => void;

function defaultRestarter(): void {
  const unit = process.env.TASKFLOW_SERVICE_UNIT || "taskflow-server.service";
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const child = spawn("systemctl", ["--user", "restart", unit], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}` },
  });
  child.unref();
}

let restarter: Restarter = defaultRestarter;
/** Для тестов: подменить способ перезапуска. */
export function _setRestarterForTests(fn: Restarter | null): void {
  restarter = fn ?? defaultRestarter;
}

export function registerOwnerControlRoutes(app: FastifyInstance): void {
  app.get("/api/owner/runtime-status", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "доступно только владельцу" });
    const active = listActiveInProcessRuns();
    const stuck = findStuckSubtasks();
    return {
      active_runs: active.length,
      stuck: stuck.map((r) => ({ subtask_id: r.id, task_id: r.task_id, title: r.title, heartbeat_at: r.agent_heartbeat_at })),
    };
  });

  app.post("/api/owner/resume-stuck", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "доступно только владельцу" });
    const stuck = findStuckSubtasks();
    const stuckIds = new Set(stuck.map((r) => r.id));
    const result = await recoverInterruptedPlanSubtasks({
      skip: (row: PlanSubtask) => !stuckIds.has(row.id),
      reason: "возобновлено владельцем",
    });
    for (const r of stuck) {
      logEvent({ taskId: r.task_id, actorId: req.userId, kind: "owner_resume_stuck", field: r.plan_node_key, toValue: `${result.resumed} возобновлено` });
    }
    return { found: stuck.length, ...result };
  });

  app.post<{ Body: { confirm?: boolean } }>("/api/owner/restart-server", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "доступно только владельцу" });
    const active = listActiveInProcessRuns();
    if (req.body?.confirm !== true) {
      return reply.code(400).send({
        error: "нужно подтверждение: confirm=true",
        active_runs: active.length,
        warning: "перезапуск оборвёт идущие запуски; после старта сервер возобновит их сам",
      });
    }
    for (const r of active) {
      logEvent({ taskId: r.taskId, actorId: req.userId, kind: "owner_server_restart", field: r.subtaskId ?? null, toValue: `идущих запусков: ${active.length}` });
    }
    console.warn(`[owner] перезапуск сервера по кнопке владельца, идущих запусков: ${active.length}`);
    // Отвечаем до перезапуска, чтобы клиент получил ответ.
    setTimeout(() => {
      try {
        restarter();
      } catch (error) {
        console.error("[owner] перезапуск не удался:", error);
      }
    }, 500);
    return reply.code(202).send({ accepted: true, active_runs: active.length });
  });
}
