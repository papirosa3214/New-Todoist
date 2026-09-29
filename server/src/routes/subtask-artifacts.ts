import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner, isOrchestrator } from "../access.js";
import { logEvent } from "../agentState.js";
import { broadcastTaskEvent } from "../ws.js";
import { startPlanSubtaskRun, unlockReadyPlanSubtasks } from "../runtime/planSubtaskAdmission.js";
import { getFullTask, getSubtaskWithTaskForUser } from "./subtasks.js";

/**
 * Структурная сдача узла плана с output_artifact-контрактом
 * (required_fields, версии, accept/revision-request/reject) — перенесено
 * 1:1 из бывшего `POST /api/task-role-slots/:slotId/artifact*`
 * (docs/2026-09-29-role-slot-execution-integration/DESIGN.md), только
 * ключом стал `subtask_id`, а не `slot_id`.
 *
 * Это НЕ отдельный инструмент агента — `taskflow_subtask_done` (см.
 * `runtime/inProcessRun.ts`) вызывает этот же эндпоинт, когда ему передан
 * опциональный `artifact`; владелец 29.09.2026 явно решил не заводить роли
 * узла плана отдельный ограниченный тул, обычных тулов подзадачи
 * достаточно (решение №2).
 */

type ArtifactContract = { key: string; type: string; format: string; required_fields: string[] };
type ArtifactVersion = {
  id: string; subtask_id: string; version_no: number; artifact_key: string; artifact_type: string;
  artifact_format: string; summary: string; payload_json: string; evidence_json: string;
  status: "submitted" | "accepted" | "revision_requested" | "rejected"; created_by: string; created_at: string;
};

function contractFor(subtaskRow: { collaboration_plan_id: string | null; plan_node_key: string | null }): ArtifactContract | null {
  if (!subtaskRow.collaboration_plan_id || !subtaskRow.plan_node_key) return null;
  const row = db.prepare("SELECT output_artifact_json FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(subtaskRow.collaboration_plan_id, subtaskRow.plan_node_key) as { output_artifact_json: string | null } | undefined;
  return row?.output_artifact_json ? JSON.parse(row.output_artifact_json) as ArtifactContract : null;
}

function latestArtifact(subtaskId: string): ArtifactVersion | undefined {
  return db.prepare("SELECT * FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1").get(subtaskId) as ArtifactVersion | undefined;
}

export function registerSubtaskArtifactRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string }; Body: { summary?: unknown; payload?: unknown; evidence?: unknown } }>("/api/subtasks/:id/artifact", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = getSubtaskWithTaskForUser(req.params.id, req.userId);
    if (!current) return reply.code(404).send({ error: "Not found" });
    if (current.agent_id !== req.userId) return reply.code(403).send({ error: "это не ваш узел плана" });
    if (current.agent_state !== "in_progress") return reply.code(409).send({ error: "артефакт можно сдать только из узла в работе" });
    const contract = contractFor(current);
    if (!contract) return reply.code(409).send({ error: "у узла нет artifact contract" });
    const summary = String(req.body?.summary ?? "").trim();
    const payload = req.body?.payload;
    const evidenceInput = req.body?.evidence;
    const evidence = Array.isArray(evidenceInput) ? evidenceInput.slice(0, 8) : [];
    const validationFailure = (error: string) => {
      logEvent({ taskId: current.task_id, actorId: req.userId, kind: "plan_subtask_artifact_validation_failed", field: current.plan_node_key, toValue: error });
      return reply.code(400).send({ error });
    };
    if (!summary || !payload || typeof payload !== "object" || Array.isArray(payload)) return validationFailure("нужны summary и object payload");
    if (evidenceInput !== undefined && !Array.isArray(evidenceInput)) return validationFailure("evidence должен быть массивом");
    if (evidence.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).path !== "string" || !(item as Record<string, string>).path.trim() || (item as Record<string, string>).path.length > 1024)) return validationFailure("evidence должен содержать безопасные path-ссылки");
    if (contract.required_fields.some((key) => { const value = (payload as Record<string, unknown>)[key]; return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0); })) return validationFailure("payload не содержит required_fields");

    const versionNo = (db.prepare("SELECT COALESCE(MAX(version_no), 0) AS n FROM subtask_artifact_versions WHERE subtask_id = ?").get(current.id) as { n: number }).n + 1;
    const id = "sav_" + crypto.randomUUID();
    db.prepare("INSERT INTO subtask_artifact_versions (id, subtask_id, version_no, artifact_key, artifact_type, artifact_format, summary, payload_json, evidence_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)")
      .run(id, current.id, versionNo, contract.key, contract.type, contract.format, summary, JSON.stringify(payload), JSON.stringify(evidence), req.userId);
    // Сдача структурного артефакта — это и есть закрытие узла (владелец
    // 29.09.2026: «закрытие роли-подзадачи автоматическое, в тот же момент,
    // когда её артефакт открывает gate»). Отдельного PATCH done не будет.
    db.prepare("UPDATE subtasks SET result = ?, done = 1, agent_state = NULL, agent_heartbeat_at = NULL WHERE id = ?").run(summary, current.id);
    if (current.current_attempt_id) {
      db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'submitted', reason = ? WHERE id = ? AND ended_at IS NULL").run(summary, current.current_attempt_id);
      db.prepare("UPDATE subtasks SET current_attempt_id = NULL WHERE id = ?").run(current.id);
    }
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "plan_subtask_artifact_submitted", field: current.plan_node_key, toValue: contract.key + " v" + versionNo });
    await unlockReadyPlanSubtasks(current.collaboration_plan_id, current.task_id, req.userId);
    const fullTask = getFullTask(current.task_id);
    broadcastTaskEvent([current.task_creator_id, current.task_assignee_id], { type: "task:updated", task: fullTask });
    return reply.code(201).send({ artifact: latestArtifact(current.id), subtask: db.prepare("SELECT * FROM subtasks WHERE id = ?").get(current.id) });
  });

  app.post<{ Params: { id: string } }>("/api/subtasks/:id/artifact/accept", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = getSubtaskWithTaskForUser(req.params.id, req.userId);
    if (!current) return reply.code(404).send({ error: "Not found" });
    if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "owner_or_orchestrator_required" });
    const artifact = latestArtifact(current.id);
    if (!artifact || artifact.status !== "submitted") return reply.code(409).send({ error: "no submitted artifact" });
    db.prepare("UPDATE subtask_artifact_versions SET status = 'accepted' WHERE id = ?").run(artifact.id);
    logEvent({ taskId: current.task_id, actorId: req.userId, kind: "plan_subtask_artifact_accepted", field: current.plan_node_key, toValue: artifact.artifact_key + " v" + artifact.version_no });
    // accept — только запись факта для edges с start_condition='accepted';
    // done уже 1 с момента сдачи (submit), здесь его не трогаем.
    await unlockReadyPlanSubtasks(current.collaboration_plan_id, current.task_id, req.userId);
    const fullTask = getFullTask(current.task_id);
    broadcastTaskEvent([current.task_creator_id, current.task_assignee_id], { type: "task:updated", task: fullTask });
    return { artifact: latestArtifact(current.id), subtask: db.prepare("SELECT * FROM subtasks WHERE id = ?").get(current.id) };
  });

  const reopen = (kind: "revision_requested" | "rejected", eventKind: string) =>
    async (req: any, reply: any) => {
      const current = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!current) return reply.code(404).send({ error: "Not found" });
      if (!isOwner(req.userId) && !isOrchestrator(req.userId)) return reply.code(403).send({ error: "owner_or_orchestrator_required" });
      const artifact = latestArtifact(current.id);
      if (!artifact || artifact.status !== "submitted") return reply.code(409).send({ error: "no submitted artifact" });
      const reason = String(req.body?.reason ?? "").trim();
      db.prepare("UPDATE subtask_artifact_versions SET status = ? WHERE id = ?").run(kind, artifact.id);
      // Точечный reopen (DESIGN.md «Закрытие роли-подзадачи и итоговое
      // ревью»): сбрасываем done — узел снова работоспособен, тот же
      // agent_id (роль не меняется), agent_state НЕ ставим in_progress
      // автоматически — роль возьмётся сама через taskflow_subtask_work,
      // как при обычном возврате шага.
      db.prepare("UPDATE subtasks SET done = 0, agent_state = NULL, agent_heartbeat_at = NULL WHERE id = ?").run(current.id);
      logEvent({ taskId: current.task_id, actorId: req.userId, kind: eventKind, field: current.plan_node_key, fromValue: artifact.artifact_key + " v" + artifact.version_no, toValue: reason || kind });
      const fullTask = getFullTask(current.task_id);
      broadcastTaskEvent([current.task_creator_id, current.task_assignee_id], { type: "task:updated", task: fullTask });
      return { artifact: latestArtifact(current.id), subtask: db.prepare("SELECT * FROM subtasks WHERE id = ?").get(current.id) };
    };

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>("/api/subtasks/:id/artifact/revision-request", { preHandler: authOrApiToken }, reopen("revision_requested", "plan_subtask_artifact_revision_requested"));
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>("/api/subtasks/:id/artifact/reject", { preHandler: authOrApiToken }, reopen("rejected", "plan_subtask_artifact_rejected"));

  /**
   * Ручной повторный старт узла плана — перенос `POST
   * /api/task-role-slots/:slotId/run`. Автостарт (unlockReadyPlanSubtasks)
   * покрывает штатный путь; этот эндпоинт — fallback на случай, если
   * автостарт упал (недоступна модель и т.п.) и узел остался
   * незапущенным, хотя предшественники уже выполнены. Без него такой узел
   * был бы вечно висящим "хвостом" без способа его подтолкнуть.
   */
  app.post<{ Params: { id: string } }>("/api/subtasks/:id/run", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const current = getSubtaskWithTaskForUser(req.params.id, req.userId);
    if (!current) return reply.code(404).send({ error: "Not found" });
    if (current.agent_id !== req.userId && !isOwner(req.userId) && !isOrchestrator(req.userId)) {
      return reply.code(403).send({ error: "это не ваш узел плана" });
    }
    const started = await startPlanSubtaskRun(current.id, req.userId);
    if (!started.ok) return reply.code(409).send({ error: started.error });
    return { ok: true, run_id: started.runId, subtask: db.prepare("SELECT * FROM subtasks WHERE id = ?").get(current.id) };
  });
}
