import { prepareOwnerManualRun } from "../runtime/ownerManualRun.js";
import { startPlanSubtaskRun } from "../runtime/planSubtaskAdmission.js";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { reviewPromptFor, runRoleInProcess } from "../runtime/inProcessRun.js";
import { taskExecutionState } from "../runtime/taskExecutionState.js";
import { tryStartSingleExecutorPlan } from "./dispatch.js";
import { isServiceUser } from "./agent-state.js";

// Ручной разовый запуск агента на карточке — по команде владельца.
//
// Системная автоматика может быть выключена: это ОТДЕЛЬНЫЙ одиночный заход,
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
        const step=db.prepare("SELECT s.id FROM subtasks s JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id WHERE s.task_id=? ORDER BY (s.done=0) DESC,p.revision DESC,s.position LIMIT 1").get(task.id) as {id:string}|undefined;
        if(step) {
          const started=await startPlanSubtaskRun(step.id,req.userId,{manualStart:true});
          if(!started.ok)return reply.code(409).send({error:started.error});
          return {ok:true,mode,run_id:started.runId,execution:taskExecutionState(task.id)};
        }
        await prepareOwnerManualRun(task.id,req.userId);
        const assigned=task.assignee_id?.replace(/^role_/, "");
        if(assigned && ROLE_NAMES.includes(assigned)) {
          const run=await runRoleInProcess({taskId:task.id,role:assigned,mode:"work",ownerStartActorId:req.userId});
          return {ok:true,mode,run_id:run.runId,execution:taskExecutionState(task.id)};
        }
        // MAK-68: 9 входов сведены к одной функции. Кнопка «Запустить
        // исполнителя» идёт через `tryStartSingleExecutorPlan` — она
        // сама подберёт роль (если владелец не выбрал её явно через
        // `owner_selected_role`) и заведёт план single_executor с
        // одним узлом. Прежняя ручная постановка `assignee_id=role_X`
        // и отдельный `enqueueRoleRunJob(reason="assigned")` больше не
        // нужны: план сам поднимет узел и направит туда же durable
        // задание через `startPlanSubtaskRun`.
        const outcome = await tryStartSingleExecutorPlan(task.id, req.userId, { manualStart: true });
        if (!outcome.ok) {
          return reply.code(outcome.code).send({ error: outcome.error, execution: state });
        }
        if (outcome.reason !== "started") {
          return reply.code(409).send({ error: `Запуск пропущен: ${outcome.reason}`, execution: state, reason: outcome.reason });
        }
        logEvent({ taskId: task.id, actorId: req.userId, kind: "run_requested", field: "executor", toValue: outcome.role });
        return { ok: true, mode, role: outcome.role, planId: outcome.planId, execution: taskExecutionState(task.id) };
      }
      // Проверка Критиком — тоже внутри сервера (этап C2).
      if (mode === "reviewer" && ROLE_NAMES.includes("critic_verifier")) {
        try {
          const step=db.prepare("SELECT s.id FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id WHERE s.task_id=? AND n.role_key='critic_verifier' ORDER BY p.revision DESC,(s.done=0) DESC,s.position DESC LIMIT 1").get(task.id) as {id:string}|undefined;
          if(step) {
            const started=await startPlanSubtaskRun(step.id,req.userId,{manualStart:true});
            if(!started.ok)return reply.code(409).send({error:started.error});
            return {ok:true,mode,run_id:started.runId};
          }
          await prepareOwnerManualRun(task.id,req.userId);
          await runRoleInProcess({ taskId: task.id, role: "critic_verifier", ownerStartActorId:req.userId, prompt: reviewPromptFor(task.id) });
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

  // Служебная запись Системы в ленту: она будит агентов в обход сервера,
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
const SERVICE_JOURNAL_KINDS = new Set(["reviewer_sent"]);
