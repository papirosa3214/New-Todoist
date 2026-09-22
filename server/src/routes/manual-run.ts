import { spawn } from "child_process";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { isServiceUser } from "./agent-state.js";

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
      // В ленту — кого и кто запустил (владелец 22.09.2026: «нет никакой
      // информации в ленте о том, что отправлено этому критику»).
      const assignee = task.assignee_id
        ? (db.prepare("SELECT name FROM users WHERE id = ?").get(task.assignee_id) as
            | { name?: string }
            | undefined)
        : undefined;
      logEvent({
        taskId: task.id,
        actorId: req.userId,
        kind: "run_requested",
        field: mode,
        toValue:
          mode === "reviewer"
            ? REVIEWER_NAME
            : assignee?.name || task.dispatched_role || "исполнитель",
      });
      return { ok: true, mode };
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
const SERVICE_JOURNAL_KINDS = new Set(["reviewer_sent"]);
