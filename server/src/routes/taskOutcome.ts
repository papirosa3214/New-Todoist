import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead } from "../access.js";
import { buildTaskOutcome } from "../lib/taskOutcome.js";

/** Итог карточки для секции «Итог» в приложении (владелец 01.10.2026). */
export function registerTaskOutcomeRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/tasks/:id/outcome", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    return buildTaskOutcome(task.id);
  });
}
