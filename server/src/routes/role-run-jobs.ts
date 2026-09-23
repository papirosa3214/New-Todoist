import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";
import { logEvent } from "../agentState.js";
import {
  cancelPendingRoleRunJob,
  getRoleRunJob,
  listRoleRunJobs,
  retryRoleRunJob,
} from "../runtime/roleRunQueue.js";

export function registerRoleRunJobRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { task_id?: string; limit?: string } }>(
    "/api/role-run-jobs",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "очередь запусков доступна только владельцу" });
      }
      const taskId = req.query?.task_id?.trim() || undefined;
      if (taskId && !getTaskForRead(taskId, req.userId)) {
        return reply.code(404).send({ error: "Not found" });
      }
      const rawLimit = Number(req.query?.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
      return { jobs: listRoleRunJobs({ taskId, limit }) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/role-run-jobs/:id/retry",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "повтор запуска доступен только владельцу" });
      }
      const existing = getRoleRunJob(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Not found" });
      const job = retryRoleRunJob(req.params.id);
      if (!job) {
        return reply.code(409).send({
          error: `job в состоянии ${existing.status} нельзя поставить на повтор`,
        });
      }
      logEvent({
        taskId: job.task_id,
        actorId: req.userId,
        kind: "role_run_retried",
        field: "role_run_job",
        toValue: job.id,
      });
      return { job };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/role-run-jobs/:id/cancel",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply.code(403).send({ error: "отмена запуска доступна только владельцу" });
      }
      const existing = getRoleRunJob(req.params.id);
      if (!existing) return reply.code(404).send({ error: "Not found" });
      const job = cancelPendingRoleRunJob(req.params.id);
      if (!job) {
        return reply.code(409).send({
          error: `job в состоянии ${existing.status} нельзя отменить безопасно`,
        });
      }
      logEvent({
        taskId: job.task_id,
        actorId: req.userId,
        kind: "role_run_cancelled",
        field: "role_run_job",
        toValue: job.id,
      });
      return { job };
    },
  );
}
