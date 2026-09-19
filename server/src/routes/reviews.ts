import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import {
  getTaskForRead,
  getTaskForWrite,
  isOwner,
  isReviewer,
} from "../access.js";
import { logEvent } from "../agentState.js";
import {
  createResultVersion,
  currentResultVersion,
  getResultVersion,
  listResultVersions,
  type EvidenceItem,
} from "../resultVersions.js";

const VERDICTS = ["approved", "changes_requested", "blocked"] as const;
type Verdict = (typeof VERDICTS)[number];

function evidenceOf(value: unknown): EvidenceItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  return value as EvidenceItem[];
}

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { result?: string; evidence?: EvidenceItem[]; artifact_hash?: string };
  }>("/api/tasks/:id/versions", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const task = getTaskForWrite(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    if (typeof req.body?.result !== "string" || !req.body.result.trim()) {
      return reply.code(400).send({ error: "result обязателен" });
    }
    const evidence = evidenceOf(req.body?.evidence);
    if (!evidence) return reply.code(400).send({ error: "evidence должен быть массивом максимум из 20 ссылок" });
    if (req.body?.artifact_hash !== undefined && typeof req.body.artifact_hash !== "string") {
      return reply.code(400).send({ error: "artifact_hash должен быть строкой" });
    }
    const version = createResultVersion({
      taskId: task.id,
      createdBy: req.userId,
      result: req.body.result,
      evidence,
      artifactHash: req.body.artifact_hash ?? null,
    });
    logEvent({ taskId: task.id, actorId: req.userId, kind: "result_version_created", field: "result_version", toValue: String(version.version_no) });
    return reply.code(201).send({ version });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/versions", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const task = getTaskForRead(req.params.id, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const current = currentResultVersion(task.id);
    const reviews = db.prepare(
      `SELECT id, task_id, version_id, task_revision, reviewer_id,
              artifact_hash, criteria_version, verdict, findings, created_at
         FROM reviews WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
    ).all(task.id) as Array<Record<string, unknown>>;
    const byVersion = new Map<string, Array<Record<string, unknown>>>();
    for (const review of reviews) {
      const list = byVersion.get(String(review.version_id)) ?? [];
      list.push(review);
      byVersion.set(String(review.version_id), list);
    }
    return {
      current_version_id: current?.id ?? null,
      versions: listResultVersions(task.id).map((version) => ({
        ...version,
        is_current: version.id === current?.id,
        reviews: byVersion.get(version.id) ?? [],
      })),
    };
  });

  app.post<{
    Body: {
      task_id?: string;
      version_id?: string;
      artifact_hash?: string;
      criteria_version?: string;
      task_revision?: number;
      verdict?: string;
      findings?: string;
    };
  }>("/api/reviews", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const body = req.body ?? {};
    const taskId = typeof body.task_id === "string" ? body.task_id : null;
    const versionId = typeof body.version_id === "string" ? body.version_id : null;
    const artifactHash = typeof body.artifact_hash === "string" ? body.artifact_hash : null;
    const criteriaVersion = typeof body.criteria_version === "string" ? body.criteria_version : null;
    const taskRevision = Number.isInteger(body.task_revision) ? Number(body.task_revision) : null;
    const verdict = typeof body.verdict === "string" ? body.verdict : null;
    const findings = body.findings === undefined ? null : String(body.findings);

    if (!taskId || !versionId || !artifactHash || !criteriaVersion || taskRevision === null || !verdict) {
      return reply.code(400).send({ error: "task_id, version_id, artifact_hash, criteria_version, task_revision, verdict — обязательны" });
    }
    if (!VERDICTS.includes(verdict as Verdict)) {
      return reply.code(400).send({ error: `verdict должен быть одним из: ${VERDICTS.join(", ")}` });
    }
    const reviewer = isReviewer(req.userId);
    if (!isOwner(req.userId) && !reviewer) {
      return reply.code(403).send({ error: "вердикт может вынести только владелец или Reviewer" });
    }
    if (reviewer && verdict === "approved" && !findings?.trim()) {
      return reply.code(400).send({ error: "Reviewer обязан оставить комментарий при одобрении" });
    }
    const task = getTaskForRead(taskId, req.userId);
    if (!task) return reply.code(404).send({ error: "Not found" });
    const version = getResultVersion(versionId);
    const current = currentResultVersion(taskId);
    if (!version || version.task_id !== taskId || !current || current.id !== version.id) {
      return reply.code(409).send({ error: "вердикт можно вынести только по актуальной версии результата" });
    }
    if (version.task_revision !== taskRevision || version.artifact_hash !== artifactHash) {
      return reply.code(409).send({ error: "версия или artifact_hash устарели" });
    }

    const reviewId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO reviews
         (id, task_id, version_id, task_revision, reviewer_id, artifact_hash,
          criteria_version, verdict, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(reviewId, taskId, version.id, version.task_revision, req.userId,
      version.artifact_hash, criteriaVersion, verdict, findings);
    logEvent({ taskId, actorId: req.userId, kind: "review_recorded", field: "result_version", toValue: `${version.version_no}:${verdict}` });
    return reply.code(201).send({
      review_id: reviewId, task_id: taskId, version_id: version.id,
      task_revision: version.task_revision, reviewer_id: req.userId,
      artifact_hash: version.artifact_hash, criteria_version: criteriaVersion,
      verdict, findings,
    });
  });
}
