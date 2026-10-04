import { completePlanFinalReview } from "../runtime/planReviewLifecycle.js";
import { unlockReadyPlanSubtasks } from "../runtime/planSubtaskAdmission.js";
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
import { writeOutcomeNote } from "../lib/taskOutcome.js";
import { broadcastToUsers } from "../ws.js";
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
      rework_steps?: string[];
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

    const hasPlan = reviewer && Boolean(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(taskId));
    const recorded = hasPlan ? db.prepare("SELECT * FROM reviews WHERE version_id=? AND reviewer_id=? ORDER BY created_at DESC LIMIT 1").get(version.id,req.userId) as any : null;
    if (recorded) {
      if (recorded.verdict !== verdict) return reply.code(409).send({error:"По этой версии уже есть вердикт; повторная проверка требует новую версию результата"});
      return reply.code(201).send({...recorded,review_id:recorded.id,handled_by_plan:true,deduplicated:true});
    }
    const previous = db.prepare("SELECT * FROM reviews WHERE version_id=? AND reviewer_id=? AND verdict=? AND COALESCE(findings,'')=? ORDER BY created_at DESC LIMIT 1").get(version.id,req.userId,verdict,findings ?? "") as any;
    if (previous) return reply.code(201).send({...previous,review_id:previous.id,handled_by_plan:Boolean(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND status='approved'").get(taskId)),deduplicated:true});
    if (body.rework_steps !== undefined && (!Array.isArray(body.rework_steps) || body.rework_steps.some((slot:any)=>typeof slot!=="string"))) return reply.code(400).send({error:"rework_steps — список ключей этапов"});
    let planReturn:ReturnType<typeof completePlanFinalReview> = null;
    const reviewId = crypto.randomUUID();
    try {
      db.transaction(()=>{
    db.prepare(
      `INSERT INTO reviews
         (id, task_id, version_id, task_revision, reviewer_id, artifact_hash,
          criteria_version, verdict, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(reviewId, taskId, version.id, version.task_revision, req.userId,
      version.artifact_hash, criteriaVersion, verdict, findings);
    logEvent({ taskId, actorId: req.userId, kind: "review_recorded", field: "result_version", toValue: `${version.version_no}:${verdict}` });
        if (reviewer) planReturn = completePlanFinalReview(taskId,req.userId,verdict,findings ?? "",body.rework_steps);
      })();
    } catch (error) {
      return reply.code(422).send({error:error instanceof Error ? error.message : String(error)});
    }
    const managedPlan = planReturn as ReturnType<typeof completePlanFinalReview>;
    if (managedPlan) await unlockReadyPlanSubtasks(managedPlan.planId,taskId,req.userId);
    // Итог карточки — заметкой в документацию проекта (владелец 01.10.2026).
    try {
      writeOutcomeNote(taskId, req.userId);
    } catch (err) {
      console.warn(`итог ${taskId} не записан:`, err);
    }

    // Вердикт виден в карточке: комментарий от ревьюера в ленту + уведомление
    // владельцу. Раньше записывалась только строка reviews и событие
    // review_recorded — ни вердикта, ни комментария, ни сигнала владелец не
    // видел (владелец 19.09.2026).
    {
      const verdictWord =
        verdict === "approved"
          ? "одобрил"
          : verdict === "changes_requested"
            ? "вернул на доработку"
            : "остановил";
      const reviewerName =
        (db.prepare("SELECT name FROM users WHERE id = ?").get(req.userId) as
          | { name?: string }
          | undefined)?.name || "Reviewer";

      const note = (findings || "").trim();
      if (note) {
        // Прецедент 22.09.2026: critic_verifier вызывал taskflow_review 3-4
        // раза подряд (видно по логам — req-3gv / 3h4 / 3he / 3hm за 13 сек),
        // и сервер на каждый запрос честно вставлял новую строку в comments.
        // В ленте оказывалось 2-4 одинаковых записи «Ревьюер проверил и
        // одобрил: …». Защита ставится именно тут, а не в MCP-инструменте:
        // LLM нельзя заставить «правильно» звать инструмент, а серверный
        // гард отрезает дубль независимо от поведения агента. TTL — 60 сек,
        // окно шире, чем самая длинная retry-петля LLM, но уже, чем реальный
        // повторный вердикт по той же задаче (такого сценария у нас нет —
        // verdict один на версию).
        const dup = managedPlan ? undefined : db
          .prepare(
            `SELECT id FROM comments
              WHERE task_id = ? AND user_id = ?
                AND created_at >= datetime('now', '-60 seconds')
              LIMIT 1`,
          )
          .get(taskId, req.userId) as { id: string } | undefined;
        if (dup) {
          // reviews-запись уже выше INSERT-нута — это нормально, версии
          // обязаны учитывать каждый вердикт. А вот comments-строка одна.
        } else {
        db.prepare(
          "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
        ).run(
          crypto.randomUUID(),
          taskId,
          req.userId,
          `Ревьюер ${verdictWord === "одобрил" ? "проверил и одобрил" : verdictWord === "вернул на доработку" ? "вернул на доработку" : "остановил работу"}: ${note}`,
        );
        }
      }
      // Владельцу — только если он не сам вынес вердикт (свой вердикт не шлём).
      if (task.creator_id && task.creator_id !== req.userId) {
        const notifId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'reviewed', ?, ?, ?)",
        ).run(
          notifId,
          task.creator_id,
          taskId,
          `${reviewerName}: «${task.title}» — ${verdictWord}`,
          req.userId,
        );
        broadcastToUsers([task.creator_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId,
        });
      }
    }

    return reply.code(201).send({
      review_id: reviewId, task_id: taskId, version_id: version.id,
      task_revision: version.task_revision, reviewer_id: req.userId,
      artifact_hash: version.artifact_hash, criteria_version: criteriaVersion,
      verdict, findings, handled_by_plan: Boolean(managedPlan),
    });
  });
}
