import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { authOrApiToken } from "../auth.js";
import { getTaskForRead, isOrchestrator, isOwner } from "../access.js";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES, roleTitle, roleUserId } from "../roleRouting.js";
import { runRoleInProcess } from "../runtime/inProcessRun.js";

const STATES = new Set(["waiting", "ready", "active", "submitted", "accepted"]);
const NEXT: Record<string, string[]> = {
  waiting: ["ready"], ready: ["active"], active: ["submitted"], submitted: ["accepted", "ready"], accepted: [],
};

type Slot = { id: string; task_id: string; slot_key: string; role_key: string; participant_id: string; state: string; required: number; result: string | null; evidence_json: string; collaboration_plan_id: string | null; plan_node_key: string | null; created_at: string; updated_at: string };

function slot(slotId: string): Slot | undefined {
  return db.prepare("SELECT * FROM task_role_slots WHERE id = ?").get(slotId) as Slot | undefined;
}

function canReadSlot(slot: Slot, userId: string): boolean {
  return isOwner(userId) || isOrchestrator(userId) || slot.participant_id === userId;
}

function present(row: Slot) {
  let evidence: unknown[] = [];
  try { evidence = JSON.parse(row.evidence_json || "[]"); } catch { evidence = []; }
  return { ...row, required: row.required === 1, evidence };
}

function evidencePresent(slot: Slot): boolean {
  try { return Array.isArray(JSON.parse(slot.evidence_json)) && JSON.parse(slot.evidence_json).length > 0; } catch { return false; }
}

function canBecomeReady(row: Slot): boolean {
  if (!row.collaboration_plan_id || !row.plan_node_key) return true;
  const edges = db.prepare("SELECT from_slot_key, start_condition FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ?")
    .all(row.collaboration_plan_id, row.plan_node_key) as Array<{ from_slot_key: string; start_condition: string }>;
  return edges.every((edge) => {
    const predecessor = db.prepare("SELECT * FROM task_role_slots WHERE collaboration_plan_id = ? AND plan_node_key = ?").get(row.collaboration_plan_id, edge.from_slot_key) as Slot | undefined;
    if (!predecessor) return false;
    if (edge.start_condition === "accepted") return predecessor.state === "accepted";
    if (edge.start_condition === "artifact_ready") return ["submitted", "accepted"].includes(predecessor.state) && evidencePresent(predecessor);
    return ["submitted", "accepted"].includes(predecessor.state);
  });
}

export function unlockReadySlots(planId: string | null, taskId: string, actorId: string): void {
  if (!planId) return;
  const waiting = db.prepare("SELECT * FROM task_role_slots WHERE collaboration_plan_id = ? AND state = 'waiting'").all(planId) as Slot[];
  for (const next of waiting) {
    if (!canBecomeReady(next)) continue;
    db.prepare("UPDATE task_role_slots SET state = 'ready', updated_at = datetime('now') WHERE id = ?").run(next.id);
    logEvent({ taskId, actorId, kind: "role_slot_ready", field: next.slot_key, toValue: roleTitle(next.role_key) });
  }
}

export function registerTaskRoleSlotRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/api/tasks/:id/role-slots", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const slots = (db.prepare("SELECT * FROM task_role_slots WHERE task_id = ? ORDER BY created_at, id").all(task.id) as Slot[])
      .filter((row) => canReadSlot(row, req.userId)).map(present);
    return { slots };
  });

  app.post<{ Params: { id: string }; Body: { slot_key?: string; role_key?: string; required?: boolean } }>("/api/tasks/:id/role-slots", { preHandler: authOrApiToken }, async (req: any, reply) => {
    if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "слоты назначает владелец или оркестратор" });
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const slotKey = String(req.body?.slot_key ?? "").trim();
    const roleKey = String(req.body?.role_key ?? "").trim();
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(slotKey)) return reply.code(400).send({ error: "некорректный slot_key" });
    if (!ROLE_NAMES.includes(roleKey)) return reply.code(422).send({ error: "unknown role" });
    const participantId = roleUserId(roleKey);
    const id = `trs_${crypto.randomUUID()}`;
    try {
      db.prepare(`INSERT INTO task_role_slots (id, task_id, slot_key, role_key, participant_id, state, required, created_by)
                  VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`)
        .run(id, task.id, slotKey, roleKey, participantId, req.body?.required === false ? 0 : 1, req.userId);
    } catch (error) {
      return reply.code(409).send({ error: "такой slot уже существует для этой задачи" });
    }
    logEvent({ taskId: task.id, actorId: req.userId, kind: "role_slot_created", field: slotKey, toValue: roleTitle(roleKey) });
    return reply.code(201).send({ slot: present(slot(id)!) });
  });

  app.post<{ Params: { slotId: string }; Body: { state?: string } }>("/api/task-role-slots/:slotId/state", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    const next = String(req.body?.state ?? "");
    if (!STATES.has(next) || !(NEXT[current.state] ?? []).includes(next)) return reply.code(400).send({ error: "invalid slot transition" });
    const mayChange = current.participant_id === req.userId || (next === "accepted" && (isOwner(req.userId) || isOrchestrator(req.userId)));
    if (!mayChange) return reply.code(403).send({ error: "это не ваш персональный slot" });
    if (next === "ready" && !canBecomeReady(current)) return reply.code(409).send({ error: "slot ждёт обязательные результаты предыдущих ролей" });
    db.prepare("UPDATE task_role_slots SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_state_changed", field: current.slot_key, fromValue: current.state, toValue: next });
    if (next === "accepted") unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return { slot: present(slot(current.id)!) };
  });

  app.post<{ Params: { slotId: string }; Body: { result?: string; evidence?: unknown[] } }>("/api/task-role-slots/:slotId/result", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (current.participant_id !== req.userId) return reply.code(403).send({ error: "это не ваш персональный slot" });
    const result = String(req.body?.result ?? "").trim();
    const evidence = Array.isArray(req.body?.evidence) ? req.body.evidence.slice(0, 8) : [];
    if (!result || result.length > 2000) return reply.code(400).send({ error: "нужен результат до 2000 символов" });
    if (current.state !== "active") return reply.code(409).send({ error: "результат можно сдать только из active slot" });
    db.prepare("UPDATE task_role_slots SET result = ?, evidence_json = ?, state = 'submitted', updated_at = datetime('now') WHERE id = ?")
      .run(result, JSON.stringify(evidence), current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_submitted", field: current.slot_key, toValue: roleTitle(current.role_key) });
    unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return { slot: present(slot(current.id)!) };
  });

  app.post<{ Params: { slotId: string } }>("/api/task-role-slots/:slotId/run", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (current.participant_id !== req.userId && !isOwner(req.userId) && !isOrchestrator(req.userId)) {
      return reply.code(403).send({ error: "это не ваш персональный slot" });
    }
    if (current.state !== 'ready') return reply.code(409).send({ error: "slot ещё не допущен или уже завершён" });
    db.prepare("UPDATE task_role_slots SET state = 'active', updated_at = datetime('now') WHERE id = ?").run(current.id);
    try {
      const run = await runRoleInProcess({ taskId: current.task_id, role: current.role_key, slotId: current.id, mode: "work" });
      logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_started", field: current.slot_key, toValue: roleTitle(current.role_key) });
      return { ok: true, run_id: run.runId, slot: present(slot(current.id)!) };
    } catch (error) {
      db.prepare("UPDATE task_role_slots SET state = 'ready', updated_at = datetime('now') WHERE id = ?").run(current.id);
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
