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


type ArtifactContract = { key: string; type: string; format: string; required_fields: string[] };
type ArtifactVersion = {
  id: string; slot_id: string; version_no: number; artifact_key: string; artifact_type: string;
  artifact_format: string; summary: string; payload_json: string; evidence_json: string;
  status: "submitted" | "accepted" | "revision_requested" | "rejected"; created_by: string; created_at: string;
};
function contractFor(current: Slot): ArtifactContract | null {
  if (!current.collaboration_plan_id || !current.plan_node_key) return null;
  const row = db.prepare("SELECT output_artifact_json FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?").get(current.collaboration_plan_id, current.plan_node_key) as { output_artifact_json: string | null } | undefined;
  return row?.output_artifact_json ? JSON.parse(row.output_artifact_json) as ArtifactContract : null;
}
function latestArtifact(slotId: string): ArtifactVersion | undefined {
  return db.prepare("SELECT * FROM role_slot_artifact_versions WHERE slot_id = ? ORDER BY version_no DESC LIMIT 1").get(slotId) as ArtifactVersion | undefined;
}
function artifactHasEvidence(artifact: ArtifactVersion): boolean {
  try { return Array.isArray(JSON.parse(artifact.evidence_json)) && JSON.parse(artifact.evidence_json).length > 0; } catch { return false; }
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
  const edges = db.prepare("SELECT from_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ?")
    .all(row.collaboration_plan_id, row.plan_node_key) as Array<{ from_slot_key: string; start_condition: string; artifact_key: string | null }>;
  return edges.every((edge) => {
    const predecessor = db.prepare("SELECT * FROM task_role_slots WHERE collaboration_plan_id = ? AND plan_node_key = ?").get(row.collaboration_plan_id, edge.from_slot_key) as Slot | undefined;
    if (!predecessor) return false;
    if (edge.artifact_key) {
      const artifact = latestArtifact(predecessor.id);
      if (!artifact || artifact.artifact_key !== edge.artifact_key) return false;
      if (edge.start_condition === "accepted") return artifact.status === "accepted";
      if (edge.start_condition === "artifact_ready") return ["submitted", "accepted"].includes(artifact.status) && artifactHasEvidence(artifact);
      return ["submitted", "accepted"].includes(artifact.status);
    }
    if (edge.start_condition === "accepted") return predecessor.state === "accepted";
    if (edge.start_condition === "artifact_ready") return ["submitted", "accepted"].includes(predecessor.state) && evidencePresent(predecessor);
    return ["submitted", "accepted"].includes(predecessor.state);
  });
}

/**
 * Реальный старт slot'а: `ready` -> `active` -> `runRoleInProcess`. Общее
 * тело для ручного `/run` и автостарта из `unlockReadySlots` — раньше это
 * было только внутри HTTP-хендлера, поэтому открытый графом slot сам не
 * впрягался в работу, пока кто-то не дёрнет `/run` руками.
 */
export async function startSlotRun(slotId: string, actorId: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const current = slot(slotId);
  if (!current || current.state !== "ready") return { ok: false, error: "slot ещё не допущен или уже завершён" };
  db.prepare("UPDATE task_role_slots SET state = 'active', updated_at = datetime('now') WHERE id = ?").run(current.id);
  try {
    const run = await runRoleInProcess({ taskId: current.task_id, role: current.role_key, slotId: current.id, mode: "work" });
    logEvent({ taskId: current.task_id, actorId, kind: "role_slot_started", field: current.slot_key, toValue: roleTitle(current.role_key) });
    return { ok: true, runId: run.runId };
  } catch (error) {
    db.prepare("UPDATE task_role_slots SET state = 'ready', updated_at = datetime('now') WHERE id = ?").run(current.id);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Открывает по графу все slots, чьи предшественники выполнены, и сразу
 * стартует роль в каждом — «роль сама подключается к плану и впрягается в
 * работу», а не ждёт, пока кто-то руками дёрнет `/run`. Неудача автостарта
 * одного slot'а (например, недоступна модель) не должна ронять открытие
 * соседних независимых веток — поэтому try/catch на каждый отдельно; slot
 * при неудаче остаётся в `ready`, ручной `/run` — рабочий fallback.
 */
export async function unlockReadySlots(planId: string | null, taskId: string, actorId: string): Promise<void> {
  if (!planId) return;
  const waiting = db.prepare("SELECT * FROM task_role_slots WHERE collaboration_plan_id = ? AND state = 'waiting'").all(planId) as Slot[];
  for (const next of waiting) {
    if (!canBecomeReady(next)) continue;
    db.prepare("UPDATE task_role_slots SET state = 'ready', updated_at = datetime('now') WHERE id = ?").run(next.id);
    logEvent({ taskId, actorId, kind: "role_slot_ready", field: next.slot_key, toValue: roleTitle(next.role_key) });
    try {
      const started = await startSlotRun(next.id, actorId);
      if (!started.ok) {
        logEvent({ taskId, actorId, kind: "role_slot_autostart_failed", field: next.slot_key, toValue: started.error });
      }
    } catch (error) {
      logEvent({ taskId, actorId, kind: "role_slot_autostart_failed", field: next.slot_key, toValue: error instanceof Error ? error.message : String(error) });
    }
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
    if (next === "accepted") await unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return { slot: present(slot(current.id)!) };
  });


  app.post<{ Params: { slotId: string }; Body: { summary?: unknown; payload?: unknown; evidence?: unknown } }>("/api/task-role-slots/:slotId/artifact", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (current.participant_id !== req.userId) return reply.code(403).send({ error: "это не ваш персональный slot" });
    if (current.state !== "active") return reply.code(409).send({ error: "артефакт можно сдать только из active slot" });
    const contract = contractFor(current);
    if (!contract) return reply.code(409).send({ error: "у slot нет artifact contract" });
    const summary = String(req.body?.summary ?? "").trim();
    const payload = req.body?.payload;
    const evidenceInput = req.body?.evidence;
    const evidence = Array.isArray(evidenceInput) ? evidenceInput.slice(0, 8) : [];
    const validationFailure = (error: string) => {
      logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_artifact_validation_failed", field: current.slot_key, toValue: error });
      return reply.code(400).send({ error });
    };
    if (!summary || !payload || typeof payload !== "object" || Array.isArray(payload)) return validationFailure("нужны summary и object payload");
    if (evidenceInput !== undefined && !Array.isArray(evidenceInput)) return validationFailure("evidence должен быть массивом");
    if (evidence.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).path !== "string" || !(item as Record<string, string>).path.trim() || (item as Record<string, string>).path.length > 1024)) return validationFailure("evidence должен содержать безопасные path-ссылки");
    if (contract.required_fields.some((key) => { const value = (payload as Record<string, unknown>)[key]; return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0); })) return validationFailure("payload не содержит required_fields");
    const versionNo = (db.prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM role_slot_artifact_versions WHERE slot_id = ?").get(current.id) as { n: number }).n + 1;
    const id = "rsav_" + crypto.randomUUID();
    db.prepare("INSERT INTO role_slot_artifact_versions (id, slot_id, version_no, artifact_key, artifact_type, artifact_format, summary, payload_json, evidence_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)")
      .run(id, current.id, versionNo, contract.key, contract.type, contract.format, summary, JSON.stringify(payload), JSON.stringify(evidence), req.userId);
    db.prepare("UPDATE task_role_slots SET result = ?, evidence_json = ?, state = 'submitted', updated_at = datetime('now') WHERE id = ?").run(summary, JSON.stringify(evidence), current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_artifact_submitted", field: current.slot_key, toValue: contract.key + " v" + versionNo });
    await unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return reply.code(201).send({ artifact: latestArtifact(current.id), slot: present(slot(current.id)!) });
  });
  app.post<{ Params: { slotId: string } }>("/api/task-role-slots/:slotId/artifact/accept", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "owner_or_orchestrator_required" });
    const artifact = latestArtifact(current.id);
    if (!artifact || artifact.status !== "submitted") return reply.code(409).send({ error: "no submitted artifact" });
    db.prepare("UPDATE role_slot_artifact_versions SET status = 'accepted' WHERE id = ?").run(artifact.id);
    db.prepare("UPDATE task_role_slots SET state = 'accepted', updated_at = datetime('now') WHERE id = ?").run(current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_artifact_accepted", field: current.slot_key, toValue: artifact.artifact_key + " v" + artifact.version_no });
    await unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return { artifact: latestArtifact(current.id), slot: present(slot(current.id)!) };
  });
  app.post<{ Params: { slotId: string }; Body: { reason?: unknown } }>("/api/task-role-slots/:slotId/artifact/revision-request", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "owner_or_orchestrator_required" });
    const artifact = latestArtifact(current.id);
    if (!artifact || artifact.status !== "submitted") return reply.code(409).send({ error: "no submitted artifact" });
    const reason = String(req.body?.reason ?? "").trim();
    db.prepare("UPDATE role_slot_artifact_versions SET status = 'revision_requested' WHERE id = ?").run(artifact.id);
    db.prepare("UPDATE task_role_slots SET state = 'active', updated_at = datetime('now') WHERE id = ?").run(current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_artifact_revision_requested", field: current.slot_key, fromValue: artifact.artifact_key + " v" + artifact.version_no, toValue: reason || "revision requested" });
    return { artifact: latestArtifact(current.id), slot: present(slot(current.id)!) };
  });
  app.post<{ Params: { slotId: string }; Body: { reason?: unknown } }>("/api/task-role-slots/:slotId/artifact/reject", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "owner_or_orchestrator_required" });
    const artifact = latestArtifact(current.id);
    if (!artifact || artifact.status !== "submitted") return reply.code(409).send({ error: "no submitted artifact" });
    const reason = String(req.body?.reason ?? "").trim();
    db.prepare("UPDATE role_slot_artifact_versions SET status = 'rejected' WHERE id = ?").run(artifact.id);
    db.prepare("UPDATE task_role_slots SET state = 'active', updated_at = datetime('now') WHERE id = ?").run(current.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "role_slot_artifact_rejected", field: current.slot_key, fromValue: artifact.artifact_key + " v" + artifact.version_no, toValue: reason || "rejected" });
    return { artifact: latestArtifact(current.id), slot: present(slot(current.id)!) };
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
    await unlockReadySlots(current.collaboration_plan_id, current.task_id, req.userId);
    return { slot: present(slot(current.id)!) };
  });

  app.post<{ Params: { slotId: string } }>("/api/task-role-slots/:slotId/run", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = slot(req.params.slotId);
    if (!current) return reply.code(404).send({ error: "slot not found" });
    if (current.participant_id !== req.userId && !isOwner(req.userId) && !isOrchestrator(req.userId)) {
      return reply.code(403).send({ error: "это не ваш персональный slot" });
    }
    const started = await startSlotRun(current.id, req.userId);
    if (!started.ok) return reply.code(409).send({ error: started.error });
    return { ok: true, run_id: started.runId, slot: present(slot(current.id)!) };
  });
}
