// Диагностические эндпоинты V2 контракта «resolver причин движения/
// ожидания» (TaskFlow — NewTodoist, документ a8bfa7ea-…):
//
//   GET /api/coordination/tasks/:id/resolve     — список Resolution по подзадачам карточки.
//   GET /api/coordination/subtasks/:id/resolve  — один Resolution по подзадаче.
//   GET /api/coordination/attempts/:id/resolve  — что случилось с попыткой и куда она идёт.
//   GET /api/coordination/_metrics?window=hour|day
//   GET /api/coordination/role-load?window=24h|3d|week  — загрузка ролей по факту
//
// Доступ через `authOrApiToken` (тот же, что и `/api/tasks/:id`,
// `/api/agent/...`). Событие `kind='resolution'` пишется в
// `task_events` для метрик, payload ≤ 600 байт (V2, раздел «Метрики»).
//
// Resolver не запускает, не закрывает и не блокирует — только
// объясняет. Действия (retry, replace, cancel, lift) вызываются через
// существующие маршруты, ссылки на них возвращаются в `links`.

import { missionTime } from "../lib/missionTime.js";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import {getTaskForRead} from "../access.js";
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
import { readChatTurns } from "../lib/roleLoadChatTurns.js";
import { roleUserId } from "../roleRouting.js";
import { evaluateRecipientAvailability } from "../runtime/roleMessageWait.js";
import { pendingInboxCountsByTask } from "../runtime/topicInbox.js";
import { listDiscussions } from "../runtime/taskDiscussion.js";
import { questionEnvelope, type QuestionRow } from "../lib/chatQuestions.js";

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
  switch (cause) {
    case "stalled_manual_review":
    case "step_stalled":
      return subtaskId ? [{ href: subtaskRestart, rel: "replace", note: "запустить новую попытку вручную" }] : [];
    case "durable_queued_wake":
      return subtaskId ? [{ href: subtaskCancel, rel: "cancel", note: "снять задание из очереди" }] : [];
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


/**
 * Заголовок подзадачи — это JSON-описание слота плана: сервер хранит в
 * `subtasks.title` строку вида
 * `{"key":"work_1","title":"Восстановить прокси","result":"…","role":"infra_engineer",…}`
 * и сверяет по ней шаги в выборках плана. Хранить это в заголовке нужно,
 * показывать владельцу — нет: на телефон уходил весь JSON (02.11.2026).
 *
 * Здесь слот разбирается обратно в человеческий текст. Обычный заголовок
 * (не JSON) не трогаем.
 */
function slotText(raw: string | null | undefined): { title?: string; result?: string; role?: string } {
  if (raw === null || raw === undefined) return {};
  const trimmed = String(raw).trim();
  if (!trimmed.startsWith("{")) return trimmed ? { title: trimmed } : {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.key !== "string") return { title: trimmed };
    const pick = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    return { title: pick(parsed.title) ?? trimmed, result: pick(parsed.result), role: pick(parsed.role) };
  } catch {
    return { title: trimmed };
  }
}

/** Человеческий текст шага: сначала результат слота, потом название. */
function humanNote(raw: string | null | undefined, fallback: string | null | undefined): string | null {
  const slot = slotText(raw);
  return slot.result ?? (fallback ? String(fallback).slice(0, 600) : null);
}

/** Owner-facing labels; diagnostic reads never start or mutate a step. */
function readableResolution(r: Resolution, facts: ReturnType<typeof collectFacts>) {
  const task = db.prepare("SELECT title,status,archived_at FROM tasks WHERE id=?").get(r.task_id) as any;
  const sub = r.subtask_id ? db.prepare("SELECT title,done FROM subtasks WHERE id=?").get(r.subtask_id) as any : null;
  const done = sub ? !!sub.done : task?.status === "completed";
  const skipped = r.subtask_id ? !!(db.prepare("SELECT n.skipped_at FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.id=?").get(r.subtask_id) as any)?.skipped_at : false;
  const assignee_name = r.assignee.kind === "role"
    ? (db.prepare("SELECT title FROM roles WHERE key=?").get(r.assignee.key) as any)?.title
    : (db.prepare("SELECT name FROM users WHERE id=?").get(r.assignee.key) as any)?.name;
  const terminal = done || skipped || !!task?.archived_at || task?.status === "completed";
  const waiting_for = (facts?.waitingPredecessors ?? []).map(w => {
    const predecessor = db.prepare("SELECT title FROM subtasks WHERE task_id=? AND plan_node_key=? ORDER BY rowid DESC LIMIT 1").get(r.task_id,w.fromSlotKey) as any;
    return slotText(predecessor?.title).title ?? w.fromSlotKey;
  });
  // Название шага — человеческое (JSON-слот разобран), результат — тоже
  // человеческий и обрезанный: на телефон не уходит ни JSON, ни простыня.
  const slot = slotText(sub?.title);
  return {...r, title:slot.title ?? task?.title ?? "Задача", done, skipped, assignee_name: assignee_name ?? null,
    action:terminal ? "none" : r.action, links:terminal ? [] : r.links,
    notes:skipped ? "Шаг пропущен" : done ? "Шаг завершён" : humanNote(r.notes, slot.result), waiting_for};
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

/** Состояние слота для владельца: короткий код и человеческий текст. */
type ExecutorState =
  | "working"
  | "waiting"
  | "ready"
  | "queued"
  | "blocked"
  | "review"
  | "done"
  | "skipped"
  | "unknown";

/** Причина движения → состояние и текст. Один список на весь проект:
 *  телефон не придумывает свои формулировки, он рисует то, что сказал сервер. */
const EXECUTOR_STATE_BY_CAUSE: Record<string, { state: ExecutorState; title: string }> = {
  ready_to_start: { state: "ready", title: "Готов начать" },
  waiting_predecessor: { state: "waiting", title: "Ждёт предыдущий шаг" },
  blocked_dependency: { state: "waiting", title: "Ждёт предыдущий шаг" },
  waiting_transient: { state: "waiting", title: "Ждёт" },
  waiting_owner: { state: "blocked", title: "Ждёт вас" },
  waiting_human: { state: "blocked", title: "Ждёт вас" },
  active_run: { state: "working", title: "Идёт работа" },
  durable_queued_wake: { state: "queued", title: "В очереди" },
  recovery_pending: { state: "working", title: "Идёт работа" },
  stalled_manual_review: { state: "blocked", title: "Ждёт вас" },
  step_stalled: { state: "blocked", title: "Ждёт вас" },
  provider_limit: { state: "blocked", title: "Нужна помощь" },
  permission_or_owner: { state: "blocked", title: "Нужна помощь" },
  missing_config: { state: "blocked", title: "Нужна помощь" },
  context_overflow: { state: "blocked", title: "Нужна помощь" },
  review: { state: "review", title: "На проверке" },
  branch_rework: { state: "review", title: "На доработке" },
  awaiting_final_review: { state: "review", title: "На проверке" },
  completed_pending_review: { state: "review", title: "Ждёт приёмки" },
  unknown: { state: "unknown", title: "Состояние неизвестно" },
};

/** Обрезанный текст сообщения — на телефон уходит короткая выжимка. */
function clipText(value: unknown, limit = 400): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type ExecutorQuestionView = {
  id: string;
  chat_id: string;
  role_key: string | null;
  role_title: string | null;
  created_at: string;
  deadline_at: string | null;
  payload: Record<string, unknown> | null;
};

type ExecutorMessageView = {
  id: string;
  text: string;
  created_at: string;
  direction: "owner_to_role" | "role_to_owner";
};

type ExecutorView = {
  subtask_id: string;
  plan_node_key: string | null;
  title: string;
  role: string | null;
  role_title: string | null;
  executor_id: string | null;
  state: ExecutorState;
  state_title: string;
  status_text: string;
  cause: string;
  done: boolean;
  skipped: boolean;
  waiting_for: string[];
  notes: string | null;
  attempt: { started_at: string | null; ended_at: string | null; outcome: string | null };
  metrics: { age_seconds: number; attempts_in_window: number; heartbeat_age: number };
  addressable: boolean;
  address_block_reason: string | null;
  pending_messages: number;
  discussion_id: string | null;
  questions: ExecutorQuestionView[];
  messages: ExecutorMessageView[];
};

/** Вопросы ролей, которые ждут владельца, — по темам карточки. */
function readTaskQuestions(taskId: string): ExecutorQuestionView[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.chat_id, q.role_id, q.message_id, q.payload_json, q.answer_json,
              q.status, q.created_at, q.deadline_at, q.answered_at,
              u.role_key AS asking_role_key,
              (SELECT title FROM roles WHERE key = u.role_key) AS asking_role_title
         FROM chat_questions q
         JOIN chats c ON c.id = q.chat_id
         LEFT JOIN users u ON u.id = q.role_id
        WHERE c.task_id = ?
          AND q.status = 'open'
          AND (q.deadline_at IS NULL OR julianday(q.deadline_at) > julianday('now'))
        ORDER BY q.created_at DESC`,
    )
    .all(taskId) as Array<QuestionRow & { asking_role_key: string | null; asking_role_title: string | null }>;
  const out: ExecutorQuestionView[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = questionEnvelope(row);
    } catch {
      payload = null;
    }
    out.push({
      id: row.id,
      chat_id: row.chat_id,
      role_key: row.asking_role_key ?? null,
      role_title: row.asking_role_title ?? null,
      created_at: row.created_at,
      deadline_at: row.deadline_at ?? null,
      payload,
    });
  }
  return out;
}

/** Последние сообщения темы задачи, адресованные слоту или отправленные им. */
function readSlotMessages(taskId: string, slotId: string): ExecutorMessageView[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.text, m.created_at, m.subtask_id, m.recipient_subtask_id
         FROM chat_messages m
        WHERE m.channel = 'chat'
          AND m.chat_id IN (SELECT id FROM chats WHERE task_id = ?)
          AND (m.subtask_id = ? OR m.recipient_subtask_id = ?)
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 6`,
    )
    .all(taskId, slotId, slotId) as Array<{
    id: string;
    text: string;
    created_at: string;
    subtask_id: string | null;
    recipient_subtask_id: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    text: clipText(row.text),
    created_at: row.created_at,
    direction: row.recipient_subtask_id === slotId ? "owner_to_role" : "role_to_owner",
  }));
}

/**
 * Сводка по исполнителям карточки — «окно исполнителя» на телефоне.
 * Только чтение: ничего не запускает, не перезапускает и не пишет в чат.
 */
function buildExecutorSummary(taskId: string) {
  const task = db.prepare("SELECT id,title,status,archived_at FROM tasks WHERE id=?").get(taskId) as any;
  const collected = collectFactsForTask(taskId);
  const fallback = collected.length ? null : collectFacts(null, taskId);
  const factsList = collected.length ? collected : fallback ? [fallback] : [];
  const resolutions = factsList.map((facts) => {
    const built = buildResolution({
      facts,
      links: defaultLinksForCause(facts.subtaskId ?? "", facts.taskId, "unknown"),
    });
    return readableResolution(built, facts);
  });
  const resolutionBySubtask = new Map<string, (typeof resolutions)[number]>();
  for (const r of resolutions) {
    if (r.subtask_id) resolutionBySubtask.set(r.subtask_id, r);
  }

  const slotRows = db
    .prepare(
      `SELECT s.id, s.plan_node_key, s.agent_id, s.done, s.agent_state,
              n.role_key, n.skipped_at
         FROM subtasks s
         LEFT JOIN task_collaboration_plan_nodes n
           ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
        WHERE s.task_id = ?
        ORDER BY COALESCE(s.position, 0) ASC, s.rowid ASC`,
    )
    .all(taskId) as Array<{
    id: string;
    plan_node_key: string | null;
    agent_id: string | null;
    done: number;
    agent_state: string | null;
    role_key: string | null;
    skipped_at: string | null;
  }>;

  const pendingInbox = new Map(pendingInboxCountsByTask(taskId).map((row) => [row.subtask_id, row.pending]));
  const discussions = listDiscussions(taskId);
  const questions = readTaskQuestions(taskId);

  const executors: ExecutorView[] = slotRows.map((slot) => {
    const resolution = resolutionBySubtask.get(slot.id);
    const cause = resolution?.cause ?? "unknown";
    const done = Boolean(slot.done) || resolution?.done === true;
    const skipped = Boolean(slot.skipped_at) || resolution?.skipped === true;
    const mapped = EXECUTOR_STATE_BY_CAUSE[cause] ?? EXECUTOR_STATE_BY_CAUSE.unknown;
    const state: ExecutorState = done ? "done" : skipped ? "skipped" : mapped.state;
    const stateTitle = done ? "Готово" : skipped ? "Пропущено" : mapped.title;
    const roleKey =
      slot.role_key ??
      (resolution?.assignee?.kind === "role" ? resolution.assignee.key : null);
    const roleTitle = roleKey
      ? ((db.prepare("SELECT title FROM roles WHERE key=?").get(roleKey) as any)?.title ?? null)
      : null;
    const executorId = slot.agent_id ?? (roleKey ? roleUserId(roleKey) : null);
    const attempt = db
      .prepare(
        `SELECT started_at, ended_at, outcome FROM attempts
          WHERE subtask_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(slot.id) as { started_at: string; ended_at: string | null; outcome: string | null } | undefined;
    const availability = evaluateRecipientAvailability({ recipientSubtaskId: slot.id });
    const discussion = discussions.find((row) => row.subtask_id === slot.id && row.state === "open");
    const slotQuestions = questions.filter((q) => q.role_key && q.role_key === roleKey);
    return {
      subtask_id: slot.id,
      plan_node_key: slot.plan_node_key,
      title: resolution?.title ?? slot.plan_node_key ?? "Шаг",
      role: roleKey,
      role_title: roleTitle,
      executor_id: executorId,
      state,
      state_title: stateTitle,
      status_text: resolution?.notes ?? stateTitle,
      cause,
      done,
      skipped,
      waiting_for: resolution?.waiting_for ?? [],
      notes: resolution?.notes ?? null,
      attempt: {
        started_at: attempt?.started_at ?? null,
        ended_at: attempt?.ended_at ?? null,
        outcome: attempt?.outcome ?? null,
      },
      metrics: resolution?.metrics ?? { age_seconds: 0, attempts_in_window: 0, heartbeat_age: 0 },
      addressable: availability.ok && !done && !skipped,
      address_block_reason: availability.ok ? null : availability.error,
      pending_messages: pendingInbox.get(slot.id) ?? 0,
      discussion_id: discussion?.discussion_id ?? null,
      questions: slotQuestions,
      messages: readSlotMessages(taskId, slot.id),
    } satisfies ExecutorView;
  });

  const orchestratorSlot = executors.find((row) => row.role === "code_orchestrator") ?? null;
  const orchestratorTitle =
    (db.prepare("SELECT title FROM roles WHERE key='code_orchestrator'").get() as any)?.title ??
    "Оркестратор";
  const looseQuestions = questions.filter(
    (q) => !executors.some((row) => row.role && q.role_key === row.role),
  );

  return {
    task_id: taskId,
    task_title: task?.title ?? "Задача",
    generated_at: new Date().toISOString(),
    orchestrator: {
      role: "code_orchestrator",
      title: orchestratorTitle,
      executor_id: roleUserId("code_orchestrator"),
      slot_id: orchestratorSlot?.subtask_id ?? null,
      addressable: orchestratorSlot?.addressable ?? false,
      address_block_reason: orchestratorSlot?.address_block_reason ?? null,
    },
    executors,
    pending_questions: looseQuestions,
    time: missionTime(taskId),
  };
}

export function registerCoordinationRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  // 1. Список Resolution по подзадачам карточки.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/tasks/:id/resolve",
    { preHandler: authPre },
    async (req: any, reply) => {
      const taskId = req.params.id;
      if (!getTaskForRead(taskId, req.userId)) return reply.code(404).send({ error: "task_not_found" });
      const collected = collectFactsForTask(taskId);
      const fallback = collected.length ? null : collectFacts(null, taskId);
      const factsList = collected.length ? collected : fallback ? [fallback] : [];
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
        return readableResolution(withLinks, facts);
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
      if (!sub.exists || !getTaskForRead(sub.taskId, req.userId)) return reply.code(404).send({ error: "subtask_not_found" });
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
      return reply.send(readableResolution(withDefaults, facts));
    },
  );

  // 3. Что случилось с попыткой и куда она идёт.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/attempts/:id/resolve",
    { preHandler: authPre },
    async (req: any, reply) => {
      const attemptId = req.params.id;
      const att = readAttemptSubtask(attemptId);
      if (!att.exists || !getTaskForRead(att.taskId, req.userId)) return reply.code(404).send({ error: "attempt_not_found" });
      if (!att.subtaskId) {
        // Попытка без подзадачи — отдаём «облегчённый» Resolution по самой
        // задаче. Это редкий случай (task-level attempt), но контракт
        // обещает 200, а не 5xx.
        const facts = collectFacts(null, att.taskId);
        if (!facts) return reply.code(404).send({ error: "task_not_found" });
        const built = buildResolution({ facts });
        logResolution(att.taskId, req.userId ?? null, built);
        return reply.send(readableResolution(built, facts));
      }
      const facts = collectFacts(att.subtaskId, att.taskId);
      if (!facts) return reply.code(404).send({ error: "task_not_found" });
      const built = buildResolution({
        facts,
        evidence: [{ kind: "attempt", ref: `attempts.${attemptId}`, note: "источник вызова" }],
      });
      logResolution(att.taskId, req.userId ?? null, built);
      return reply.send(readableResolution(built, facts));
    },
  );

  // 6. Сводка по исполнителям карточки — «окно исполнителя» на телефоне:
  //   GET /api/coordination/tasks/:id/executors
  //   Кто делает шаг, в каком он состоянии, чего ждёт, что ему уже писали и
  //   что он отвечал, какие вопросы роли ждут владельца и можно ли сейчас
  //   адресовать этот шаг. Только чтение — ничего не запускает и не пишет.
  app.get<{ Params: { id: string } }>(
    "/api/coordination/tasks/:id/executors",
    { preHandler: authPre },
    async (req: any, reply) => {
      const taskId = req.params.id;
      if (!getTaskForRead(taskId, req.userId)) return reply.code(404).send({ error: "task_not_found" });
      return reply.send(buildExecutorSummary(taskId));
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

  // 5. Загрузка ролей по факту (карточка 1117d06c…):
  //   GET /api/coordination/role-load?window=24h|3d|week
  //   Только данные для отрисовки Гант-экрана веба. Read-only; не
  //   пишет в task_events и не имеет побочных эффектов. Источник правды
  //   — те же attempts/subtasks/tasks, что и в остальных эндпоинтах
  //   coordination; новых таблиц не вводим.
  app.get<{ Querystring: { window?: string } }>(
    "/api/coordination/role-load",
    { preHandler: authPre },
    async (req: any, reply) => {
      return reply.send(readRoleLoad(req.query?.window));
    },
  );
}

export function readRoleLoad(window?: string) {
const windowKey = normalizeRoleLoadWindow(window);
const { fromIso, toIso } = roleLoadRange(windowKey);
const nowIso = new Date().toISOString();

// 5.1 Роли: только включённые, в порядке position. executor_id
// (учётка роли) нужен клиенту, чтобы показать аватарку рядом с
// названием и не подтягивать /api/agents вторым запросом.
const roleRows = db
  .prepare(
    `SELECT r.key, r.title, r.position,
            (SELECT id FROM users
              WHERE role_key = r.key AND role = 'agent' AND type = 'ai'
              ORDER BY created_at LIMIT 1) AS executor_id
       FROM roles r
      WHERE r.enabled = 1
      ORDER BY r.position, r.key`,
  )
  .all() as Array<{
    key: string;
    title: string;
    position: number;
    executor_id: string | null;
  }>;
const rolesOut = roleRows.map((r) => ({
  key: r.key,
  title: r.title,
  position: r.position,
  executor_id: r.executor_id,
}));

// 5.2 Интервалы работы только открытых карточек. task_title тянем JOIN'ом, чтобы
// клиенту не ходить за /api/tasks на каждую полосу; routing_role —
// ключ роли, которой заходили (для группировки на Ганте).
// У старых in-process заходов routing_role не записывался.
// Восстанавливаем по фактическому executor_id, не по текущему
// assignee задачи или изменяемому узлу плана. Записанная роль
// захода всегда имеет приоритет. Историческую БД не меняем.
// subtask_id нужен, чтобы отличать task-level attempt от шага
// collaboration-плана; рендер один и тот же, но отображение
// контекста пригодится в следующих инкрементах.
const attemptRows = db
  .prepare(
    `WITH work_evidence AS (
       SELECT a.*,
         CASE WHEN a.subtask_id IS NOT NULL THEN (
           SELECT MIN(e.created_at) FROM task_events e
           JOIN subtasks step ON step.id=a.subtask_id
           WHERE e.task_id=a.task_id AND (
             (e.kind='subtask_done' AND e.actor_id=a.executor_id AND e.to_value=step.title
              AND (SELECT COUNT(*) FROM subtasks same WHERE same.task_id=a.task_id AND same.title=step.title)=1)
             OR (e.kind='plan_subtask_interrupted' AND e.field=step.plan_node_key
              AND (SELECT COUNT(*) FROM subtasks same WHERE same.task_id=a.task_id AND same.plan_node_key=step.plan_node_key)=1)
           ) AND datetime(e.created_at)>datetime(a.started_at)
         ) ELSE (
           SELECT MIN(e.created_at) FROM task_events e
           WHERE e.task_id=a.task_id AND e.kind='state_changed'
             AND e.actor_id=a.executor_id AND e.field='agent_state'
             AND e.from_value='in_progress'
             AND (e.to_value IS NULL OR e.to_value<>'in_progress')
             AND datetime(e.created_at)>datetime(a.started_at)
         ) END AS observed_end
       FROM attempts a
     ), work_intervals AS (
       SELECT *, CASE
         WHEN ended_at IS NULL THEN observed_end
         WHEN observed_end IS NULL THEN ended_at
         WHEN datetime(observed_end)<datetime(ended_at) THEN observed_end
         ELSE ended_at END AS work_end
       FROM work_evidence
     )
     SELECT a.id, a.task_id, a.subtask_id, a.executor_id,
            COALESCE(NULLIF(a.routing_role, ''), u.role_key) AS routing_role,
            a.started_at, a.work_end AS ended_at, a.outcome, a.reason,
            t.title AS task_title,
            t.created_at AS task_created_at,
            COALESCE(t.service_hidden, 0) AS service
       FROM work_intervals a
       LEFT JOIN users u ON u.id = a.executor_id
       JOIN tasks t ON t.id = a.task_id
       LEFT JOIN subtasks s ON s.id = a.subtask_id
      WHERE datetime(a.started_at)<datetime(?)
        AND (
          (a.work_end IS NOT NULL AND datetime(a.work_end)>datetime(?)
           AND datetime(a.work_end)>datetime(a.started_at))
          OR (a.work_end IS NULL AND t.status='active' AND t.archived_at IS NULL AND (
            (a.subtask_id IS NULL AND t.agent_state='in_progress'
             AND a.id=COALESCE(t.current_attempt_id,
               (SELECT a2.id FROM attempts a2 WHERE a2.task_id=t.id
                AND a2.subtask_id IS NULL AND a2.ended_at IS NULL
                ORDER BY a2.started_at DESC,a2.rowid DESC LIMIT 1)))
            OR (s.done=0 AND s.agent_state='in_progress'
             AND a.id=COALESCE(s.current_attempt_id,
               (SELECT a2.id FROM attempts a2 WHERE a2.subtask_id=s.id
                AND a2.ended_at IS NULL ORDER BY a2.started_at DESC,a2.rowid DESC LIMIT 1)))
          ))
        )
      ORDER BY a.started_at`,
  )
  .all(toIso, fromIso) as Array<{
    id: string;
    task_id: string;
    subtask_id: string | null;
    executor_id: string;
    routing_role: string | null;
    started_at: string;
    ended_at: string | null;
    outcome: string | null;
    reason: string | null;
    task_title: string;
    task_created_at: string;
    service: number;
  }>;

const attemptsOut = attemptRows.map((a) => ({
  id: a.id,
  task_id: a.task_id,
  task_title: a.task_title,
  task_created_at: a.task_created_at,
  // Служебная карточка починки поломки (incidents.ts) — клиент красит её
  // на Ганте отдельным цветом.
  service: a.service === 1,
  subtask_id: a.subtask_id,
  executor_id: a.executor_id,
  routing_role: a.routing_role,
  started_at: toIsoString(a.started_at),
  ended_at: a.ended_at ? toIsoString(a.ended_at) : null,
  outcome: a.outcome,
  active: a.ended_at === null,
}));

// 5.3 Текущая работа определяется статусом агента, done и статусом
// карточки. Записи запусков дают только метаданные времени/роли.
// (роллап). Берём role_key из subtasks.plan_node_key не вытащить —
// он лежит в task_collaboration_plan_nodes; для task-level —
// routing_role активной попытки (если есть), иначе assignee_id
// пользователя и его role_key. Это та же раскладка, что в
// /api/coordination/tasks/:id/resolve, см. coordinationResolver.
const activeRows = db
  .prepare(
    `SELECT s.id, s.task_id, s.title, s.agent_id, s.agent_state,
            s.agent_heartbeat_at,
            (SELECT COALESCE(NULLIF(a.routing_role, ''), u.role_key)
               FROM attempts a LEFT JOIN users u ON u.id = a.executor_id
              WHERE a.subtask_id = s.id AND a.ended_at IS NULL
              ORDER BY (a.id = s.current_attempt_id) DESC, a.started_at DESC, a.rowid DESC LIMIT 1) AS attempt_role,
            (SELECT a.started_at FROM attempts a
              WHERE a.subtask_id = s.id AND a.ended_at IS NULL
              ORDER BY (a.id = s.current_attempt_id) DESC, a.started_at DESC, a.rowid DESC LIMIT 1) AS attempt_started_at,
            t.title AS task_title,
            t.created_at AS task_created_at
       FROM subtasks s
       JOIN tasks t ON t.id = s.task_id
        AND t.archived_at IS NULL
        AND t.status = 'active'
      WHERE s.agent_state = 'in_progress'
        AND s.done = 0
      ORDER BY s.agent_heartbeat_at DESC`,
  )
  .all() as Array<{
    id: string;
    task_id: string;
    title: string;
    agent_id: string | null;
    agent_state: string;
    agent_heartbeat_at: string | null;
    attempt_role: string | null;
    attempt_started_at: string | null;
    task_title: string;
    task_created_at: string;
  }>;

// Task-level: открытая карточка, назначенный агент работает.
// Наличие записи запуска не является условием текущей занятости.
const activeTaskRows = db
  .prepare(
    `SELECT t.id, t.title AS task_title, t.created_at AS task_created_at, t.assignee_id,
            (SELECT COALESCE(NULLIF(a.routing_role, ''), u.role_key)
               FROM attempts a LEFT JOIN users u ON u.id = a.executor_id
              WHERE a.task_id = t.id AND a.ended_at IS NULL
                AND a.subtask_id IS NULL
              ORDER BY (a.id = t.current_attempt_id) DESC, a.started_at DESC, a.rowid DESC LIMIT 1) AS attempt_role,
            (SELECT a.started_at FROM attempts a
              WHERE a.task_id = t.id AND a.ended_at IS NULL
                AND a.subtask_id IS NULL
              ORDER BY (a.id = t.current_attempt_id) DESC, a.started_at DESC, a.rowid DESC LIMIT 1) AS attempt_started_at
       FROM tasks t
      WHERE t.status = 'active'
        AND t.agent_state = 'in_progress'
        AND t.archived_at IS NULL
        AND t.assignee_id IS NOT NULL AND t.assignee_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM subtasks s WHERE s.task_id = t.id
        )`,
  )
  .all() as Array<{
    id: string;
    task_title: string;
    task_created_at: string;
    assignee_id: string | null;
    attempt_role: string | null;
    attempt_started_at: string | null;
  }>;

// Сливаем оба источника в одну форму, с понятной метой «откуда».
// role_key: сначала routing_role активной попытки, иначе role_key
// пользователя-исполнителя (роль как личность, не как заход).
const userRoleCache = new Map<string, string | null>();
function userRoleKey(userId: string | null): string | null {
  if (!userId) return null;
  const cached = userRoleCache.get(userId);
  if (cached !== undefined) return cached;
  const row = db
    .prepare("SELECT role_key FROM users WHERE id = ?")
    .get(userId) as { role_key: string | null } | undefined;
  const roleKey = row?.role_key ?? null;
  userRoleCache.set(userId, roleKey);
  return roleKey;
}

const activeNowOut: Array<{
  kind: "subtask" | "task";
  id: string;
  task_id: string;
  task_title: string;
  task_created_at: string;
  role_key: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
}> = [];

for (const s of activeRows) {
  const role =
    s.attempt_role ?? userRoleKey(s.agent_id);
  activeNowOut.push({
    kind: "subtask",
    id: s.id,
    task_id: s.task_id,
    task_title: s.task_title,
    task_created_at: s.task_created_at,
    role_key: role,
    started_at: s.attempt_started_at
      ? toIsoString(s.attempt_started_at)
      : null,
    heartbeat_at: s.agent_heartbeat_at
      ? toIsoString(s.agent_heartbeat_at)
      : null,
  });
}
for (const t of activeTaskRows) {
  const role =
    t.attempt_role ?? userRoleKey(t.assignee_id);
  activeNowOut.push({
    kind: "task",
    id: t.id,
    task_id: t.id,
    task_title: t.task_title,
    task_created_at: t.task_created_at,
    role_key: role,
    started_at: t.attempt_started_at
      ? toIsoString(t.attempt_started_at)
      : null,
    heartbeat_at: null,
  });
}

// 5.4 Видимые слоты без исполнителя: задачи в работе, у которых
// assignee_id IS NULL (или же активная попытка без routing_role и
// assignee — не приписываем произвольно, лучше показать отдельной
// строкой «без роли»). Так сюда попадают карточки, в которых
// Система ещё не подобрала исполнителя или владелец снял его
// руками. Это и есть второй слой из постановки — отдельный стиль,
// чтобы их не теряли с глаз.
const openRows = db
  .prepare(
    `SELECT id, title, agent_state, created_at,
            COALESCE(ready_set_at, updated_at) AS since
       FROM tasks
      WHERE status = 'active'
        AND archived_at IS NULL
        AND agent_state = 'in_progress'
        AND (assignee_id IS NULL OR assignee_id = '')
      ORDER BY since`,
  )
  .all() as Array<{
    id: string;
    title: string;
    agent_state: string;
    created_at: string;
    since: string | null;
  }>;
const openSlotsOut = openRows.map((t) => ({
  kind: "task",
  id: t.id,
  task_title: t.title,
  task_created_at: t.created_at,
  // Без исполнителя — роль не знаем; клиент покажет «без роли»
  // общей строкой поверх, чтобы не терялись. assignee_id=NULL
  // означает, что карточка ВИСИТ в работе, но никем не занята.
  role_key: null,
  state: t.agent_state,
  since: t.since ? toIsoString(t.since) : null,
}));

// 5.4 Ходы ролей в чате без карточки. Их нет в attempts (там task_id
// обязателен), но по времени работы они — такая же нагрузка роли.
// Название работы — из отчёта роли по ходу (см. lib/roleLoadChatTurns).
const chatTurnsOut = readChatTurns(db, fromIso, toIso).map((t) => ({
  id: t.id,
  chat_id: t.chat_id,
  chat_title: t.chat_title,
  role_id: t.role_id,
  role_key: t.role_key,
  started_at: toIsoString(t.started_at),
  ended_at: toIsoString(t.ended_at),
  title: t.title,
}));

return {
  window: windowKey,
  from: fromIso,
  to: toIso,
  now: nowIso,
  roles: rolesOut,
  attempts: attemptsOut,
  chat_turns: chatTurnsOut,
  active_now: activeNowOut,
  open_slots: openSlotsOut,
};
}

// ── Утилиты role-load ────────────────────────────────────────────────

type RoleLoadWindow = "24h" | "3d" | "week";

function normalizeRoleLoadWindow(raw: unknown): RoleLoadWindow {
  if (raw === "3d" || raw === "week" || raw === "24h") return raw;
  return "24h";
}

function roleLoadRange(windowKey: RoleLoadWindow): {
  fromIso: string;
  toIso: string;
} {
  // Заходы отбираются так: «начался до `to` и либо ещё не кончился,
  // либо кончился после `from`». Поэтому окно берём чуть шире видимого
  // диапазона — клиенту нужны бары, которые начались до from и
  // продолжаются в окно. from = to - windowMs - 1h; to = now + 1h.
  const now = Date.now();
  const tailMs = 60 * 60 * 1000;
  let spanMs: number;
  switch (windowKey) {
    case "24h":
      spanMs = 24 * 60 * 60 * 1000;
      break;
    case "3d":
      spanMs = 3 * 24 * 60 * 60 * 1000;
      break;
    case "week":
      spanMs = 7 * 24 * 60 * 60 * 1000;
      break;
  }
  const to = new Date(now + tailMs);
  const from = new Date(now - spanMs - tailMs);
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

function toIsoString(value: string): string {
  // SQLite отдаёт 'YYYY-MM-DD HH:MM:SS' (UTC). Префикс 'Z' превращает
  // в ISO; то же соглашение, что в coordinationResolver.read.ts.
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return iso;
}
