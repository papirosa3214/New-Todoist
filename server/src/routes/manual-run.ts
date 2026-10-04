import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { reviewPromptFor, runRoleInProcess } from "../runtime/inProcessRun.js";
import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";
import { taskExecutionState } from "../runtime/taskExecutionState.js";
import { isServiceUser } from "./agent-state.js";

// Ручной разовый запуск агента на карточке — по команде владельца.
//
// Служба-будильник может быть выключена: это ОТДЕЛЬНЫЙ одиночный заход,
// он поднимает одного агента на одной карточке и выходит. Автоматику не
// трогает и ничего не крутит; владелец остаётся единственным инициатором.

export async function registerManualRunRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/tasks/:id/execution", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!getTaskForRead(req.params.id, req.userId)) return reply.code(404).send({error:"Not found"});
    return taskExecutionState(req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { mode?: string } }>(
    "/api/tasks/:id/run",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "ручной запуск — только владелец" });
      }
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      const mode = req.body?.mode === "reviewer" ? "reviewer" : "executor";
      if (mode === "executor") {
        const state = taskExecutionState(task.id);
        if (!state.can_launch) return reply.code(409).send({error:"Запуск уже принят или выбрана другая схема работы", execution:state});
        const role = (task.dispatched_role as string | null) ?? (task.owner_selected_role as string | null)
          ?? (task.machine_selected_role as string | null) ?? (task.assignee_id?.startsWith("role_") ? task.assignee_id.slice(5) : null);
        if (!role || !ROLE_NAMES.includes(role)) return reply.code(422).send({error:"Выберите доступную роль исполнителя перед запуском"});
        db.transaction(() => {
          db.prepare("UPDATE tasks SET assignee_id=?, ready_for_pickup=1, ready_set_at=datetime('now'), ready_set_by=?, updated_at=datetime('now') WHERE id=?").run(`role_${role}`,req.userId,task.id);
          enqueueRoleRunJob({taskId:task.id,reason:"assigned",actorId:req.userId,dedupeKey:`manual:${task.id}:${crypto.randomUUID()}`,manualStart:true,maxAttempts:1});
          logEvent({taskId:task.id,actorId:req.userId,kind:"run_requested",field:"executor",toValue:roleTitleOf(role)});
        })();
        return {ok:true,mode,execution:taskExecutionState(task.id)};
      }
      // Проверка Критиком — тоже внутри сервера (этап C2).
      if (mode === "reviewer" && ROLE_NAMES.includes("critic_verifier")) {
        try {
          await runRoleInProcess({ taskId: task.id, role: "critic_verifier", prompt: reviewPromptFor(task.id) });
        } catch (err) {
          return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
        }
        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "run_requested",
          field: "reviewer",
          toValue: REVIEWER_NAME,
        });
        return { ok: true, mode, inProcess: true };
      }
      return reply.code(422).send({error:"Верификатор недоступен"});
    },
  );

  // Служебная запись будильника в ленту: он будит агентов в обход сервера,
  // и без этого отправка на проверку не оставляла следа (22.09.2026).
  // Только служебная учётка и только перечисленные события; автор записи
  // — система.
  app.post<{ Params: { id: string }; Body: { kind?: string; to_value?: string } }>(
    "/api/tasks/:id/journal",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isServiceUser(req.userId)) {
        return reply.code(403).send({ error: "запись в ленту — только служба" });
      }
      const kind = req.body?.kind;
      if (!kind || !SERVICE_JOURNAL_KINDS.has(kind)) {
        return reply.code(400).send({ error: "неизвестное событие ленты" });
      }
      const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(req.params.id);
      if (!exists) return reply.code(404).send({ error: "Not found" });
      logEvent({
        taskId: req.params.id,
        actorId: null,
        kind,
        toValue:
          typeof req.body?.to_value === "string" ? req.body.to_value.slice(0, 200) : null,
      });
      return { ok: true };
    },
  );
}

const REVIEWER_NAME = "Критик-проверяющий";

function roleTitleOf(role: string): string {
  const row = db.prepare("SELECT title FROM roles WHERE key = ?").get(role) as { title?: string } | undefined;
  return row?.title ?? role;
}
const SERVICE_JOURNAL_KINDS = new Set(["reviewer_sent"]);
