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
      const windowKey = normalizeRoleLoadWindow(req.query?.window);
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

      // 5.2 Заходы (attempts) в окне. task_title тянем JOIN'ом, чтобы
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
          `SELECT a.id, a.task_id, a.subtask_id, a.executor_id,
                  COALESCE(NULLIF(a.routing_role, ''), u.role_key) AS routing_role,
                  a.started_at, a.ended_at, a.outcome, a.reason,
                  t.title AS task_title
             FROM attempts a
             LEFT JOIN users u ON u.id = a.executor_id
             JOIN tasks t ON t.id = a.task_id
            WHERE datetime(a.started_at) < datetime(?)
              AND (a.ended_at IS NULL OR datetime(a.ended_at) > datetime(?))
              AND t.archived_at IS NULL
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
        }>;

      const attemptsOut = attemptRows.map((a) => ({
        id: a.id,
        task_id: a.task_id,
        task_title: a.task_title,
        subtask_id: a.subtask_id,
        executor_id: a.executor_id,
        routing_role: a.routing_role,
        started_at: toIsoString(a.started_at),
        ended_at: a.ended_at ? toIsoString(a.ended_at) : null,
        outcome: a.outcome,
        active: a.ended_at === null,
      }));

      // 5.3 Активные слоты «прямо сейчас»: subtasks в работе ИЛИ
      // верхнеуровневые задачи с активным попыткой и без подзадач
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
                    LIMIT 1) AS attempt_role,
                  (SELECT a.started_at FROM attempts a
                    WHERE a.subtask_id = s.id AND a.ended_at IS NULL
                    LIMIT 1) AS attempt_started_at,
                  t.title AS task_title
             FROM subtasks s
             JOIN tasks t ON t.id = s.task_id
              AND t.archived_at IS NULL
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
        }>;

      // Task-level slots: задача с agent_state='in_progress', у которой
      // ЕСТЬ активная попытка с subtask_id IS NULL (т.е. без дочернего
      // шага). Это бывший «основной» attempt задачи.
      const activeTaskRows = db
        .prepare(
          `SELECT t.id, t.title AS task_title, t.assignee_id,
                  (SELECT COALESCE(NULLIF(a.routing_role, ''), u.role_key)
                     FROM attempts a LEFT JOIN users u ON u.id = a.executor_id
                    WHERE a.task_id = t.id AND a.ended_at IS NULL
                      AND a.subtask_id IS NULL
                    LIMIT 1) AS attempt_role,
                  (SELECT a.started_at FROM attempts a
                    WHERE a.task_id = t.id AND a.ended_at IS NULL
                      AND a.subtask_id IS NULL
                    LIMIT 1) AS attempt_started_at
             FROM tasks t
            WHERE t.status = 'active'
              AND t.agent_state = 'in_progress'
              AND t.archived_at IS NULL
              AND EXISTS (
                SELECT 1 FROM attempts a
                 WHERE a.task_id = t.id AND a.ended_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM subtasks s WHERE s.task_id = t.id
              )`,
        )
        .all() as Array<{
          id: string;
          task_title: string;
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
          `SELECT id, title, agent_state,
                  COALESCE(ready_set_at, updated_at) AS since
             FROM tasks
            WHERE status = 'active'
              AND archived_at IS NULL
              AND agent_state IN ('in_progress', 'review', 'blocked')
              AND (assignee_id IS NULL OR assignee_id = '')
            ORDER BY since`,
        )
        .all() as Array<{
          id: string;
          title: string;
          agent_state: string;
          since: string | null;
        }>;
      const openSlotsOut = openRows.map((t) => ({
        kind: "task",
        id: t.id,
        task_title: t.title,
        // Без исполнителя — роль не знаем; клиент покажет «без роли»
        // общей строкой поверх, чтобы не терялись. assignee_id=NULL
        // означает, что карточка ВИСИТ в работе, но никем не занята.
        role_key: null,
        state: t.agent_state,
        since: t.since ? toIsoString(t.since) : null,
      }));

      return reply.send({
        window: windowKey,
        from: fromIso,
        to: toIso,
        now: nowIso,
        roles: rolesOut,
        attempts: attemptsOut,
        active_now: activeNowOut,
        open_slots: openSlotsOut,
      });
    },
  );
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
