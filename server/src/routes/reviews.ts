// Локальная заготовка для заливки на .110:/home/maksim/Проекты/New-Todoist/server/src/routes/reviews.ts
// НЕ применена — ждём явного разрешения Максима.
//
// Что: POST /api/reviews — запись вердикта приёмки по F04 (01-requirements.md)
// и ADR-04 (05-decisions.md). Минимальный кусок первого практического
// результата из README проекта v0.1 («одна задача проходит от запроса до
// принятого артефакта, переживает потерю связи и не создаёт повторного
// внешнего действия»). Полный review job / acceptance flow / evidence —
// отдельные задачи, здесь только таблица `reviews` и endpoint, пишущий
// вердикт на закреплённые artifact_hash и criteria_version (I07 из
// 03-execution-contract.md: «Одобрение связано с artifact manifest hash,
// task revision и policy version»).
//
// Поведение:
//   - Принимает {task_id, artifact_hash, criteria_version, task_revision,
//     verdict, findings?}.
//   - verdict ∈ {approved, changes_requested, blocked}.
//   - Без artifact_hash/criteria_version/task_revision — 400 (I07).
//   - 404 если task не виден вызывающему (getTaskForRead).
//   - Пишет строку в `reviews`, эмитит событие review_recorded через logEvent.
//   - Возвращает 201 + созданный review_id.
//
// Что НЕ здесь (по дизайну, чтобы не раздувать):
//   - Evidence, Acceptance, Action — отдельные таблицы/endpoint'ы.
//   - Атомарный claim с attempt_id/lease_epoch — другой lock (шаг 4
//     протокола claim из 03-execution-contract.md).
//   - Миграция для `artifact_versions` — пока пустая (поля хеша нет
//     нигде в существующем API, добавлять некуда).
//
// После одобрения — раскладывается в два файла на .110:
//   1. server/src/routes/reviews.ts (этот код)
//   2. server/src/migrations.ts — добавить одну запись `020_reviews`
//      с таблицей `reviews` (см. reviews_migration.ts)
//   3. server/src/index.ts — добавить `import { registerReviewRoutes } from "./routes/reviews.js"`
//      и `await registerReviewRoutes(app)` рядом с другими registerXxxRoutes.
//
// Сервер НЕ перезапускаю — до явной команды (см. taskflow-speech-state.md,
// запрет «сейчас вообще нельзя его перезапускать» от 18.08.2026).

import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { getTaskForRead } from "../access.js";
import { logEvent } from "../agentState.js";

const uid = () => crypto.randomUUID();

type Verdict = "approved" | "changes_requested" | "blocked";
const ALLOWED: ReadonlyArray<Verdict> = ["approved", "changes_requested", "blocked"];

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/reviews", async (req, reply) => {
    const me = await authOrApiToken(req);
    if (!me) return reply.code(401).send({ error: "unauthorized" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskId = typeof body.task_id === "string" ? body.task_id : null;
    const artifactHash = typeof body.artifact_hash === "string" ? body.artifact_hash : null;
    const criteriaVersion = typeof body.criteria_version === "string" ? body.criteria_version : null;
    const taskRevision = Number.isInteger(body.task_revision) ? Number(body.task_revision) : null;
    const verdictRaw = typeof body.verdict === "string" ? body.verdict : null;
    const findings = typeof body.findings === "string" ? body.findings : null;

    if (!taskId || !artifactHash || !criteriaVersion || !verdictRaw) {
      return reply.code(400).send({
        error: "bad_request",
        message: "task_id, artifact_hash, criteria_version, verdict — обязательны",
      });
    }
    const verdict = verdictRaw as Verdict;
    if (!ALLOWED.includes(verdict)) {
      return reply.code(400).send({
        error: "bad_request",
        message: `verdict должен быть одним из: ${ALLOWED.join(", ")}`,
      });
    }
    if (taskRevision === null) {
      return reply.code(400).send({
        error: "bad_request",
        message: "task_revision обязательна (I07: вердикт привязан к revision)",
      });
    }

    const task = getTaskForRead(taskId, sessionOf(me).userId);
    if (!task) return reply.code(404).send({ error: "not_found" });

    const reviewerId = sessionOf(me).userId;
    const reviewId = uid();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO reviews
           (id, task_id, task_revision, reviewer_id, artifact_hash,
            criteria_version, verdict, findings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        reviewId, taskId, taskRevision, reviewerId, artifactHash,
        criteriaVersion, verdict, findings,
      );
      logEvent({
        kind: "review_recorded",
        aggregateId: taskId,
        actorId: reviewerId,
        payload: {
          review_id: reviewId,
          verdict,
          artifact_hash: artifactHash,
          criteria_version: criteriaVersion,
        },
      });
    });
    tx();

    return reply.code(201).send({
      review_id: reviewId,
      task_id: taskId,
      task_revision: taskRevision,
      reviewer_id: reviewerId,
      artifact_hash: artifactHash,
      criteria_version: criteriaVersion,
      verdict,
      findings,
    });
  });
}