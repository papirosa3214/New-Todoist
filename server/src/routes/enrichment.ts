import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, getTaskForWrite } from "../access.js";
import { taskDependencies, unmetDependencyIds } from "../enricher.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent } from "../ws.js";
import { getTaskRow, hydrateTask } from "./tasks.js";
import { isOwner } from "../access.js";

const canManage = (userId: string) => isOwner(userId);

// Зависимости задач. Здесь же раньше жили «доска объявлений»
// (`GET /api/tasks/pool`), словарный подбор профиля (`POST /:id/enrich`) и
// эскалации неоднозначных задач владельцу — всё это части старой схемы
// самозахвата, убранной 14.09.2026 вместе с ней: исполнитель подбирается
// по смыслу и назначается сразу при создании.

export function registerEnrichmentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get<{ Params: { id: string } }>("/api/tasks/:id/dependencies", { preHandler: authPre }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    return { dependencies: taskDependencies(task.id), unmet_dependency_ids: unmetDependencyIds(task.id) };
  });

  const DEPENDENCY_POLICIES = new Set(["review", "completed"]);

  app.put<{ Params: { id: string }; Body: { depends_on_task_ids?: string[]; policies?: Record<string, string> } }>("/api/tasks/:id/dependencies", { preHandler: authPre }, async (req: any, reply) => {
    if (!canManage(req.userId)) return reply.code(403).send({ error: "зависимости меняет владелец" });
    const task = getTaskForWrite(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const ids: string[] = [...new Set<string>(Array.isArray(req.body?.depends_on_task_ids) ? req.body.depends_on_task_ids : [])];
    if (ids.includes(task.id)) return reply.code(400).send({ error: "задача не может зависеть от самой себя" });
    const existing = ids.length ? db.prepare(`SELECT id FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string }> : [];
    if (existing.length !== ids.length) return reply.code(400).send({ error: "unknown dependency" });
    // policy: 'review' по умолчанию (совместимо со старыми edges — см. migration
    // 073), 'completed' только когда явно указана и распознана.
    const policies = req.body?.policies && typeof req.body.policies === "object" ? req.body.policies : {};
    for (const value of Object.values(policies)) {
      if (typeof value === "string" && !DEPENDENCY_POLICIES.has(value)) {
        return reply.code(400).send({ error: `неизвестная policy: ${value}` });
      }
    }
    const policyFor = (id: string): string =>
      typeof policies[id] === "string" && DEPENDENCY_POLICIES.has(policies[id]) ? policies[id] : "review";
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      const next = db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?").all(from) as Array<{ depends_on_task_id: string }>;
      return next.some((edge) => reaches(edge.depends_on_task_id, target, seen));
    };
    if (ids.some((id) => reaches(id, task.id))) return reply.code(400).send({ error: "циклическая зависимость" });
    db.transaction(() => {
      db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(task.id);
      const insert = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, policy) VALUES (?, ?, ?)");
      for (const id of ids) insert.run(task.id, id, policyFor(id));
      logEvent({ taskId: task.id, actorId: req.userId, kind: "dependencies_changed", field: "depends_on_task_ids", toValue: JSON.stringify(ids) });
      if (ids.length) {
        logEvent({ taskId: task.id, actorId: req.userId, kind: "dependency_context_updated", field: "policy", toValue: JSON.stringify(ids.map((id) => ({ id, policy: policyFor(id) }))) });
      }
    })();
    const updated = getTaskRow(task.id);
    broadcastTaskEvent([updated.creator_id, updated.assignee_id], { type: "task:updated", task: hydrateTask(updated) });
    return { dependencies: taskDependencies(task.id), unmet_dependency_ids: unmetDependencyIds(task.id) };
  });
}
