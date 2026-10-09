// Диагностические эндпоинты V2 контракта «resolver причин движения/
// ожидания» (TaskFlow — NewTodoist, документ a8bfa7ea-…):
//
//   GET /api/coordination/tasks/:id/resolve     — список Resolution по подзадачам карточки.
//   GET /api/coordination/subtasks/:id/resolve  — один Resolution по подзадаче.
//   GET /api/coordination/attempts/:id/resolve  — что случилось с попыткой и куда она идёт.
//   GET /api/coordination/_metrics?window=hour|day
//
// Доступ через `authOrApiToken` (тот же, что и `/api/tasks/:id`,
// `/api/agent/...`). Событие `kind='resolution'` пишется в
// `task_events` для метрик, payload ≤ 600 байт (V2, раздел «Метрики»).
//
// Resolver не запускает, не закрывает и не блокирует — только
// объясняет. Действия (retry, replace, cancel, lift) вызываются через
// существующие маршруты, ссылки на них возвращаются в `links`.

import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { logEvent } from "../agentState.js";
import {
  buildResolution,
  type Evidence,
  type LinkRef,
  type Resolution,
} from "../runtime/coordinationResolver.js";
import {
  collectFacts,
  collectFactsForTask,
  evidenceRefLooksValid,
  metricWindow,
} from "../runtime/coordinationResolver.read.js";

const MAX_EVIDENCE = 7;
const MAX_NOTES = 500;
const RESOLUTION_LOG_PAYLOAD_LIMIT = 600;

function clampLinks(input: unknown): LinkRef[] {
  if (!Array.isArray(input)) return [];
  const out: LinkRef[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const href = typeof rec.href === "string" ? rec.href.slice(0, 200) : "";
    const rel = rec.rel;
    if (!href) continue;
    if (rel !== "retry" && rel !== "replace" && rel !== "cancel" && rel !== "accept" && rel !== "lift") continue;
    out.push({
      href,
      rel,
      note: typeof rec.note === "string" ? rec.note.slice(0, 200) : null,
    });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

function clampEvidence(input: unknown): Evidence[] {
  if (!Array.isArray(input)) return [];
  const out: Evidence[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const ref = typeof rec.ref === "string" ? rec.ref : "";
    if (
      kind !== "task_event" &&
      kind !== "attempt" &&
      kind !== "role_run_job" &&
      kind !== "journal_tail" &&
      kind !== "git_snapshot" &&
      kind !== "artifact_version" &&
      kind !== "plan_edge"
    ) {
      continue;
    }
    if (!evidenceRefLooksValid(ref)) continue;
    out.push({
      kind,
      ref,
      note: typeof rec.note === "string" ? rec.note.slice(0, 200) : null,
    });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

function readSubtaskTask(subtaskId: string): { taskId: string; exists: boolean } {
  const row = db
    .prepare("SELECT task_id FROM subtasks WHERE id = ?")
    .get(subtaskId) as { task_id: string } | undefined;
  if (!row) return { taskId: "", exists: false };
  return { taskId: row.task_id, exists: true };
}

function readTaskExists(taskId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS x FROM tasks WHERE id = ?").get(taskId) as { x: number } | undefined,
  );
}

function readAttemptSubtask(attemptId: string): { subtaskId: string | null; taskId: string; exists: boolean } {
  const row = db
    .prepare("SELECT id, subtask_id, task_id FROM attempts WHERE id = ?")
    .get(attemptId) as { id: string; subtask_id: string | null; task_id: string } | undefined;
  if (!row) return { subtaskId: null, taskId: "", exists: false };
  return { subtaskId: row.subtask_id, taskId: row.task_id, exists: true };
}

function defaultLinksForCause(subtaskId: string, taskId: string, cause: string): LinkRef[] {
  // V2: каждое действие ссылается на существующий маршрут. Список
  // зафиксирован в спеке 1.2 и не зависит от того, как именно сейчас
  // реализован handler — это просто «куда нажать, чтобы выполнить
  // `action`».
  const subtaskRestart = `/api/subtasks/${encodeURIComponent(subtaskId)}/restart`;
  const subtaskCancel = `/api/subtasks/${encodeURIComponent(subtaskId)}/cancel`;
  const taskLift = `/api/tasks/${encodeURIComponent(taskId)}/lift-dependency-blocks`;
  const taskRetry = `/api/tasks/${encodeURIComponent(taskId)}/retry`;
  const reviewAccept = `/api/reviews/${encodeURIComponent(taskId)}/accept`;
  const finalReview = `/api/tasks/${encodeURIComponent(taskId)}/final-review`;
  switch (cause) {
    case "stalled_manual_review":
    case "step_stalled":
      return [{ href: subtaskRestart, rel: "replace", note: "запустить новую попытку вручную" }];
    case "blocked_dependency":
      return [{ href: taskLift, rel: "lift", note: "снять блок-зависимость" }];
    case "durable_queued_wake":
      return [{ href: subtaskCancel, rel: "cancel", note: "снять задание из очереди" }];
    case "review":
    case "completed_pending_review":
      return [{ href: reviewAccept, rel: "accept", note: "принять вердикт проверяющего" }];
    case "awaiting_final_review":
      return [{ href: finalReview, rel: "accept", note: "запустить финального проверяющего" }];
    case "branch_rework":
      return [{ href: taskRetry, rel: "retry", note: "продолжить после rework" }];
    case "active_run":
    case "recovery_pending":
    case "waiting_transient":
    case "ready_to_start":
    case "waiting_predecessor":
    case "waiting_owner":
    case "waiting_human":
    case "provider_limit":
    case "permission_or_owner":
    case "missing_config":
    case "context_overflow":
    case "unknown":
    default:
      return [];
  }
}

function logResolution(taskId: string, actorId: string | null, payload: Resolution): void {
  // V2: «payload ≤ 600 байт». Мы заранее режем evidence/links/notes
  // до безопасных лимитов, и оборачиваем try/finally — иначе сбой
  // записи события не должен валить сам резолв.
  try {
    const slim: Resolution = {
      ...payload,
      evidence: payload.evidence.slice(0, 5),
      links: payload.links.slice(0, 3),
      notes: (payload.notes ?? "").slice(0, 300),
    };
    let text = JSON.stringify(slim);
    if (text.length > RESOLUTION_LOG_PAYLOAD_LIMIT) {
      // Последний шанс: выкинем `notes` совсем, оставим структуру.
      const evenSlimer = { ...slim, notes: null, evidence: slim.evidence.slice(0, 3) };
      text = JSON.stringify(evenSlimer);
    }
    logEvent({
      taskId,
      actorId,
      kind: "resolution",
      field: slim.subtask_id ?? slim.plan_node_key ?? null,
      toValue: text,
    });
  } catch (error) {
    // Не бросаем — лучше вернуть клиенту ответ, чем потерять его из-за
    // ошибки журнала. Метрика `resolver_unknown_total` всё равно
    // поймает «причина не распознана» через cause=unknown.
    console.warn("[coordination] событие resolution не записано:", error);
  }
}

export function registerCoordinationRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  // 1. Список Resolution по подзадачам карточки.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/tasks/:id/resolve",
    { preHandler: authPre },
    async (req: any, reply) => {
      const taskId = req.params.id;
      if (!readTaskExists(taskId)) return reply.code(404).send({ error: "task_not_found" });
      const factsList = collectFactsForTask(taskId);
      const resolutions: Resolution[] = factsList.map((facts) => {
        const r = buildResolution({
          facts,
          links: defaultLinksForCause(facts.subtaskId ?? "", facts.taskId, "unknown"),
        });
        // Подмешаем ссылки по фактической причине после построения —
        // нам нужен уже вычисленный `cause` из `buildResolution`.
        const withLinks: Resolution = {
          ...r,
          links: defaultLinksForCause(facts.subtaskId ?? "", facts.taskId, r.cause),
        };
        return withLinks;
      });
      // Одна запись в `task_events` на сам вызов — это и есть метрика
      // «сколько карточек запрашивали объяснение». Без payload'а
      // Resolution (он большой, и пишется поштучно ниже).
      for (const r of resolutions) {
        logResolution(r.task_id, req.userId ?? null, r);
      }
      return reply.send({ task_id: taskId, resolutions });
    },
  );

  // 2. Один Resolution по подзадаче.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/subtasks/:id/resolve",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtaskId = req.params.id;
      const sub = readSubtaskTask(subtaskId);
      if (!sub.exists) return reply.code(404).send({ error: "subtask_not_found" });
      const facts = collectFacts(subtaskId, sub.taskId);
      if (!facts) return reply.code(404).send({ error: "task_not_found" });
      const evidence = clampEvidence(req.query?.evidence);
      const links = clampLinks(req.query?.links);
      const built = buildResolution({
        facts,
        evidence,
        links,
        notes: typeof req.query?.notes === "string" ? req.query.notes.slice(0, MAX_NOTES) : null,
      });
      const withDefaults: Resolution = {
        ...built,
        links: built.links.length > 0 ? built.links : defaultLinksForCause(subtaskId, sub.taskId, built.cause),
      };
      logResolution(sub.taskId, req.userId ?? null, withDefaults);
      return reply.send(withDefaults);
    },
  );

  // 3. Что случилось с попыткой и куда она идёт.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/attempts/:id/resolve",
    { preHandler: authPre },
    async (req: any, reply) => {
      const attemptId = req.params.id;
      const att = readAttemptSubtask(attemptId);
      if (!att.exists) return reply.code(404).send({ error: "attempt_not_found" });
      if (!att.subtaskId) {
        // Попытка без подзадачи — отдаём «облегчённый» Resolution по самой
        // задаче. Это редкий случай (task-level attempt), но контракт
        // обещает 200, а не 5xx.
        const facts = collectFacts(null, att.taskId);
        if (!facts) return reply.code(404).send({ error: "task_not_found" });
        const built = buildResolution({ facts });
        logResolution(att.taskId, req.userId ?? null, built);
        return reply.send(built);
      }
      const facts = collectFacts(att.subtaskId, att.taskId);
      if (!facts) return reply.code(404).send({ error: "task_not_found" });
      const built = buildResolution({
        facts,
        evidence: [{ kind: "attempt", ref: `attempts.${attemptId}`, note: "источник вызова" }],
      });
      logResolution(att.taskId, req.userId ?? null, built);
      return reply.send(built);
    },
  );

  // 4. Метрики: счётчики по cause/action за час/сутки.
  app.get<{ Querystring: { window?: string } }>(
    "/api/coordination/_metrics",
    { preHandler: authPre },
    async (req: any, reply) => {
      const window = req.query?.window === "day" ? "day" : "hour";
      const seconds = window === "day" ? 86_400 : 3_600;
      const now = Math.floor(Date.now() / 1000);
      const metric = metricWindow(seconds, { nowEpochSeconds: now });
      return reply.send(metric);
    },
  );
}
