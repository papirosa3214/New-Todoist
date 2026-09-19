import { spawn } from "child_process";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";

// Ручной разовый запуск агента на карточке — по команде владельца.
//
// Служба-будильник может быть выключена: это ОТДЕЛЬНЫЙ одиночный заход,
// он поднимает одного агента на одной карточке и выходит. Автоматику не
// трогает и ничего не крутит; владелец остаётся единственным инициатором.
const MANUAL_RUN = "/home/maksim/Проекты/New-Todoist/server/scripts/manual_run.sh";

export async function registerManualRunRoutes(app: FastifyInstance): Promise<void> {
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
      const args = ["--once", task.id];
      if (mode === "reviewer") args.push("--review");
      try {
        const child = spawn("bash", [MANUAL_RUN, ...args], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (err) {
        return reply.code(500).send({ error: `не удалось запустить: ${String(err)}` });
      }
      return { ok: true, mode };
    },
  );
}
