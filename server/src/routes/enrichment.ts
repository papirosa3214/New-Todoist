import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import {
  analyzeTask,
  attachLabel,
  ensureProfileLabel,
  poolTasksForUser,
  profileOfUser,
  taskDependencies,
  unmetDependencyIds,
} from "../enricher.js";
import { getTaskForRead, getTaskForWrite, isOwner, isOrchestrator } from "../access.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent } from "../ws.js";
import { getTaskRow, hydrateTask } from "./tasks.js";

const uid = () => crypto.randomUUID();

function ownerId(): string {
  const row = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
  return row?.id ?? "u1";
}

function parseJson(value: string | null): unknown {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function escalation(taskId: string): any | undefined {
  const row = db.prepare("SELECT * FROM enrichment_escalations WHERE task_id = ?").get(taskId) as any;
  if (!row) return undefined;
  return { ...row, candidates: parseJson(row.candidates_json), final_label_ids: parseJson(row.final_label_ids_json) };
}

function canManage(userId: string): boolean {
  return isOwner(userId) || isOrchestrator(userId);
}

export function registerEnrichmentRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  app.get("/api/tasks/pool", { preHandler: authPre }, async (req: any, reply) => {
    const type = (db.prepare("SELECT type FROM users WHERE id = ?").get(req.userId) as { type?: string } | undefined)?.type;
    if (type !== "ai") return reply.code(403).send({ error: "пул доступен только агенту" });
    return { profile: profileOfUser(req.userId), tasks: poolTasksForUser(req.userId) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/enrich", { preHandler: authPre }, async (req: any, reply) => {
    const task = getTaskForWrite(req.params.id, req.userId) ?? getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const result = analyzeTask(task.title, task.description);
    const apply = db.transaction(() => {
      const current = db.prepare("SELECT * FROM enrichment_escalations WHERE task_id = ?").get(task.id) as any;
      if (result.selected_profile) {
        const labelId = ensureProfileLabel(result.selected_profile, ownerId());
        attachLabel(task.id, labelId);
        db.prepare("UPDATE tasks SET ready_for_pickup = 1, updated_at = datetime('now') WHERE id = ?").run(task.id);
        if (current?.status === "pending") db.prepare("UPDATE enrichment_escalations SET status = 'resolved', updated_at = datetime('now'), resolved_at = datetime('now') WHERE task_id = ?").run(task.id);
        logEvent({ taskId: task.id, actorId: req.userId, kind: "enrichment_published", field: "profile", toValue: result.selected_profile });
      } else {
        db.prepare("UPDATE tasks SET ready_for_pickup = 0, updated_at = datetime('now') WHERE id = ?").run(task.id);
        const candidatesJson = JSON.stringify(result.candidates);
        if (current) {
          db.prepare("UPDATE enrichment_escalations SET input_text = ?, candidates_json = ?, reason = ?, run_count = run_count + 1, updated_at = datetime('now') WHERE task_id = ?").run(result.input_text, candidatesJson, result.reason, task.id);
        } else {
          db.prepare("INSERT INTO enrichment_escalations (id, task_id, input_text, candidates_json, reason) VALUES (?, ?, ?, ?, ?)").run(uid(), task.id, result.input_text, candidatesJson, result.reason);
          logEvent({ taskId: task.id, actorId: req.userId, kind: "enrichment_escalated", field: "reason", toValue: result.reason });
        }
      }
    });
    apply();
    const updated = getTaskRow(task.id);
    broadcastTaskEvent([updated.creator_id, updated.assignee_id], { type: "task:updated", task: hydrateTask(updated) });
    return { task: hydrateTask(updated), enrichment: { ...result, escalation: escalation(task.id) } };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/enrichment", { preHandler: authPre }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    return { escalation: escalation(task.id) ?? null };
  });

  app.post<{ Params: { id: string }; Body: { label_ids?: string[]; comment?: string } }>("/api/tasks/:id/enrichment/resolve", { preHandler: authPre }, async (req: any, reply) => {
    if (!canManage(req.userId)) return reply.code(403).send({ error: "эскалацию закрывает владелец" });
    const task = getTaskForWrite(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const labelIds = Array.isArray(req.body?.label_ids) ? [...new Set(req.body.label_ids)] : [];
    const existingLabels = labelIds.length
      ? db.prepare(`SELECT id FROM labels WHERE id IN (${labelIds.map(() => "?").join(",")})`).all(...labelIds) as Array<{ id: string }>
      : [];
    if (existingLabels.length !== labelIds.length) return reply.code(400).send({ error: "invalid label_ids" });
    db.transaction(() => {
      const insert = db.prepare("INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)");
      for (const labelId of labelIds) insert.run(task.id, labelId);
      db.prepare("UPDATE tasks SET ready_for_pickup = 1, updated_at = datetime('now') WHERE id = ?").run(task.id);
      db.prepare("UPDATE enrichment_escalations SET status = 'resolved', final_label_ids_json = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE task_id = ?").run(JSON.stringify(labelIds), task.id);
      logEvent({ taskId: task.id, actorId: req.userId, kind: "enrichment_resolved", field: "label_ids", toValue: JSON.stringify(labelIds) });
      if (req.body?.comment?.trim()) db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)").run(uid(), task.id, req.userId, req.body.comment.trim());
    })();
    const updated = getTaskRow(task.id);
    broadcastTaskEvent([updated.creator_id, updated.assignee_id], { type: "task:updated", task: hydrateTask(updated) });
    return { task: hydrateTask(updated), escalation: escalation(task.id) ?? null };
  });

  app.get("/api/enrichment/metrics", { preHandler: authPre }, async (req: any, reply) => {
    if (!canManage(req.userId)) return reply.code(403).send({ error: "метрики доступны владельцу" });
    const row = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'resolved') AS resolved FROM enrichment_escalations`).get() as any;
    const total = Number(row?.total ?? 0);
    const resolved = Number(row?.resolved ?? 0);
    return { total, pending: Number(row?.pending ?? 0), resolved, escalation_rate: total ? Number((total - resolved) / total) : 0 };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/dependencies", { preHandler: authPre }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    return { dependencies: taskDependencies(task.id), unmet_dependency_ids: unmetDependencyIds(task.id) };
  });

  app.put<{ Params: { id: string }; Body: { depends_on_task_ids?: string[] } }>("/api/tasks/:id/dependencies", { preHandler: authPre }, async (req: any, reply) => {
    if (!canManage(req.userId)) return reply.code(403).send({ error: "зависимости меняет владелец" });
    const task = getTaskForWrite(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const ids: string[] = [...new Set<string>(Array.isArray(req.body?.depends_on_task_ids) ? req.body.depends_on_task_ids : [])];
    if (ids.includes(task.id)) return reply.code(400).send({ error: "задача не может зависеть от самой себя" });
    const existing = ids.length ? db.prepare(`SELECT id FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string }> : [];
    if (existing.length !== ids.length) return reply.code(400).send({ error: "unknown dependency" });
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
      const insert = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
      for (const id of ids) insert.run(task.id, id);
      logEvent({ taskId: task.id, actorId: req.userId, kind: "dependencies_changed", field: "depends_on_task_ids", toValue: JSON.stringify(ids) });
    })();
    const updated = getTaskRow(task.id);
    broadcastTaskEvent([updated.creator_id, updated.assignee_id], { type: "task:updated", task: hydrateTask(updated) });
    return { dependencies: taskDependencies(task.id), unmet_dependency_ids: unmetDependencyIds(task.id) };
  });
}
