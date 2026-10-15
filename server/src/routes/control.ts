// Ручки управления «прервать шаг», «сбросить попытку», «отменить задание»
// (MAK-69, Linear P-MAK-6).
//
// Зачем. До этого шага у владельца и оркестратора не было способа остановить
// уже идущий запуск роли из API — ни в середине работы, ни в виде сброса
// потерянной попытки. Ход роли крутился в процессе сервера, и единственный
// способ его прервать был внешний (sweeper тишины по `lastActivityAt`,
// задача MAK-66). Сейчас — те же три ручки наверху, чтобы владелец мог
// вмешаться сам, а не ждать автоматики.
//
// Что НЕ делают эти ручки:
//   • не закрывают и не удаляют карточки (deleteForbidden в auth.ts стоит
//     особо и накрывает DELETE отдельно; здесь только правки);
//   • не меняют шаги плана в обход существующих правил (закрыть галочкой
//     сделанный шаг нельзя — та же логика, что у subtasks.ts);
//   • не стартуют роль заново: это работа других ручек (/run, /state и т.д.).
//
// Права: владелец трекера или оркестратор. Агентам и прочим людям — 403, не
// 404, потому что объект им виден, а отказано именно в действии (тот же
// довод, что у deleteForbidden).
//
// Журнал: каждое действие пишет свою строку в task_events с осмысленным
// `kind` (`subtask_cancelled`, `subtask_reset`, `task_cancelled`) и
// `to_value` с фактами (что прервалось / что снято). `actor_id` —
// вызывающий (владелец или оркестратор), не null: это их решение и должно
// так читаться в ленте.
import { restartOccupiedSlot } from "../runtime/slotRestart.js";
import { forceReleaseSlotSession, isSlotSessionHeld } from "../runtime/slotSession.js";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { getSubtaskWithTaskForUser, getFullTask } from "./subtasks.js";
import { getTaskForWrite, isOrchestrator, isOwner } from "../access.js";
import { logEvent } from "../agentState.js";
import { activeInProcessRun } from "../runtime/inProcessRun.js";
import { broadcastTaskEvent } from "../ws.js";
import { releaseSubtaskWork } from "../agentState.js";

/** Прервать активный in-process заход (если он ещё жив в этом процессе) и
 *  закрыть текущую попытку шага с `outcome = 'cancelled'`. Очистка lease —
 *  в одном месте с уже существующим releaseSubtaskWork: agent_state /
 *  agent_id / agent_heartbeat_at обнуляются одной командой, чтобы карточка
 *  на доске сразу перестала показываться «в работе». */
function cancelSubtaskAttempt(subtaskId: string, reason: string, actorId: string): {
  subtaskId: string;
  aborted: boolean;
  attemptClosed: boolean;
  leaseReleased: boolean;
} {
  const subtask = db
    .prepare("SELECT id, task_id, current_attempt_id FROM subtasks WHERE id = ?")
    .get(subtaskId) as { id: string; task_id: string; current_attempt_id?: string | null } | undefined;
  if (!subtask) return { subtaskId, aborted: false, attemptClosed: false, leaseReleased: false };

  const run = activeInProcessRun(subtask.task_id, subtaskId);
  let aborted = false;
  if (run) {
    // abort() возвращает Promise — нам важен сам факт вызова, ошибку
    // (например, сессия уже мертва) не пробрасываем: пишем в журнал и идём
    // дальше. Иначе упавший run не дал бы снять lease и карточка бы так и
    // висела «в работе».
    void run.abort().catch(() => {});
    aborted = true;
  }

  let attemptClosed = false;
  if (subtask.current_attempt_id) {
    const result = db
      .prepare(
        `UPDATE attempts
            SET ended_at = datetime('now'), outcome = 'cancelled', reason = ?
          WHERE id = ? AND ended_at IS NULL`,
      )
      .run(reason.slice(0, 200), subtask.current_attempt_id);
    attemptClosed = result.changes > 0;
    if (attemptClosed) {
      db.prepare("UPDATE subtasks SET current_attempt_id = NULL WHERE id = ?").run(subtaskId);
    }
  }

  const leaseReleased = releaseSubtaskWork(subtask.task_id) > 0;

  logEvent({
    taskId: subtask.task_id,
    actorId,
    kind: "subtask_cancelled",
    field: "subtask",
    toValue: JSON.stringify({
      subtask_id: subtaskId,
      aborted,
      attempt_closed: attemptClosed,
      lease_released: leaseReleased,
      reason: reason.slice(0, 200),
    }),
  });

  return { subtaskId, aborted, attemptClosed, leaseReleased };
}

/** Сбросить текущую попытку шага без вызова abort(): сценарий — попытка
 *  «зависла» (агент ушёл, а lease ещё не истёк, или попытка не связана с
 *  живым run). Закрываем attempt с `outcome = 'reset'`, чистим lease и
 *  отметки, ничего не трогая в самой работе (result шага не перетираем). */
function resetSubtaskAttempt(subtaskId: string, reason: string, actorId: string): {
  subtaskId: string;
  attemptClosed: boolean;
  leaseReleased: boolean;
} {
  const subtask = db
    .prepare("SELECT id, task_id, current_attempt_id FROM subtasks WHERE id = ?")
    .get(subtaskId) as { id: string; task_id: string; current_attempt_id?: string | null } | undefined;
  if (!subtask) return { subtaskId, attemptClosed: false, leaseReleased: false };

  let attemptClosed = false;
  if (subtask.current_attempt_id) {
    const result = db
      .prepare(
        `UPDATE attempts
            SET ended_at = datetime('now'), outcome = 'reset', reason = ?
          WHERE id = ? AND ended_at IS NULL`,
      )
      .run(reason.slice(0, 200), subtask.current_attempt_id);
    attemptClosed = result.changes > 0;
    if (attemptClosed) {
      db.prepare("UPDATE subtasks SET current_attempt_id = NULL WHERE id = ?").run(subtaskId);
    }
  }

  const leaseReleased = releaseSubtaskWork(subtask.task_id) > 0;

  logEvent({
    taskId: subtask.task_id,
    actorId,
    kind: "subtask_reset",
    field: "subtask",
    toValue: JSON.stringify({
      subtask_id: subtaskId,
      attempt_closed: attemptClosed,
      lease_released: leaseReleased,
      reason: reason.slice(0, 200),
    }),
  });

  return { subtaskId, attemptClosed, leaseReleased };
}

/** Прервать все активные запуски задачи и снять отметки работы на самой
 *  задаче и всех её незакрытых шагах. Текущий attempt задачи (subtask_id
 *  IS NULL) закрывается с `outcome = 'cancelled'`. Отличие от «прервать
 *  шаг» — масштаб: ручка действует на ВСЁ задание сразу, включая чат-
 *  сессии по этой карточке (slotConversation.abortTask — отдельная
 *  зависимость, здесь не дублируем; на текущей схеме исполнения чат живёт
 *  в slotConversation, и его мы НЕ останавливаем, чтобы обсуждение не
 *  уходило вместе с задачей). */
function cancelTaskWork(taskId: string, reason: string, actorId: string): {
  taskId: string;
  abortedRuns: number;
  attemptsClosed: number;
  leaseReleased: boolean;
  subtaskPointersCleared: number;
} {
  const task = db
    .prepare("SELECT id, status, current_attempt_id FROM tasks WHERE id = ?")
    .get(taskId) as { id: string; status: string; current_attempt_id?: string | null } | undefined;
  if (!task) {
    return { taskId, abortedRuns: 0, attemptsClosed: 0, leaseReleased: false, subtaskPointersCleared: 0 };
  }

  // Прервать активный заход на самой задаче (subtaskId === undefined) и
  // по одному на каждую её подзадачу — на сегодняшней схеме один in-process
  // run на (taskId, subtaskId), и activeInProcessRun ровно его и возвращает.
  // Активных параллельных run'ов на одной подзадаче инвариант
  // idx_attempts_one_active_per_subtask не допускает, так что этого цикла
  // достаточно; если завтра схема поменяется — здесь же добавится обход по
  // activeRuns.
  const subtaskIds = (db
    .prepare("SELECT id FROM subtasks WHERE task_id = ?")
    .all(taskId) as Array<{ id: string }>).map((s) => s.id);
  const liveRuns = [activeInProcessRun(taskId, undefined), ...subtaskIds.map((sid) => activeInProcessRun(taskId, sid))]
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  let abortedRuns = 0;
  for (const run of liveRuns) {
    void run.abort().catch(() => {});
    abortedRuns += 1;
  }

  // Закрыть все действующие попытки этой задачи (включая те, что на
  // подзадачах) одним UPDATE — проще и атомарно, чем по одной строке.
  const attemptsResult = db
    .prepare(
      `UPDATE attempts
          SET ended_at = datetime('now'), outcome = 'cancelled', reason = ?
        WHERE task_id = ? AND ended_at IS NULL`,
    )
    .run(reason.slice(0, 200), taskId);
  const attemptsClosed = attemptsResult.changes;

  // Снять отметки работы на подзадачах (lease — единой функцией) и обнулить
  // current_attempt_id у самой задачи И у её подзадач, чтобы повторный
  // запуск не наткнулся на «уже идёт попытка». До этой правки
  // `subtasks.current_attempt_id` оставался указывать на закрытую попытку
  // (массовый UPDATE attempts выше уже выставил ей `outcome='cancelled'` и
  // `ended_at`), а `consultation.ts:293–297` и `subtask-artifacts.ts:93–94`
  // берут «активную попытку» без проверки `ended_at` — это ломало
  // корректное чтение состояния после cancel и приводило к no-op при
  // попытке закрыть artifacts закрытого attempt'а. Один UPDATE по
  // подзадачам, рядом с тем же обнулением на tasks.
  const leaseReleased = releaseSubtaskWork(taskId) > 0;
  // tasks.agent_id нет (исполнитель держит assignee_id); lease на уровне
  // задачи — те же три поля, что у subtasks (см. releaseSubtaskWork).
  db.prepare(
    "UPDATE tasks SET agent_state = NULL, agent_heartbeat_at = NULL, current_attempt_id = NULL WHERE id = ?",
  ).run(taskId);
  const subtaskPointersResult = db.prepare(
    "UPDATE subtasks SET current_attempt_id = NULL WHERE task_id = ? AND current_attempt_id IS NOT NULL",
  ).run(taskId);
  const subtaskPointersCleared = subtaskPointersResult.changes;

  logEvent({
    taskId,
    actorId,
    kind: "task_cancelled",
    field: "task",
    toValue: JSON.stringify({
      aborted_runs: abortedRuns,
      attempts_closed: attemptsClosed,
      lease_released: leaseReleased,
      subtask_pointers_cleared: subtaskPointersCleared,
      reason: reason.slice(0, 200),
    }),
  });

  return { taskId, abortedRuns, attemptsClosed, leaseReleased, subtaskPointersCleared };
}

/** Тело запроса: одна строка причины. Необязательна, но если есть —
 *  пишется в журнал и в attempt.reason. */
function readReason(body: any): string {
  const raw = body?.reason;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : "принудительная остановка";
}

/** Ручки доступны владельцу и оркестратору. Агентам — нет: они сами
 *  источник заходов, и не должны иметь возможность остановить чужой ход
 *  под видом «своих действий». */
function isCancellationActor(userId: string): boolean {
  return isOwner(userId) || isOrchestrator(userId);
}

export function registerControlRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.post<{ Params: {id:string}; Body: {role:string;reason:string} }>("/api/subtasks/:id/restart", {preHandler:authPre}, async (req:any,reply) => {
    if (!isCancellationActor(req.userId)) return reply.code(403).send({error:"перезапуск доступен владельцу или оркестратору"});
    const row=getSubtaskWithTaskForUser(req.params.id,req.userId);
    if (!row) return reply.code(404).send({error:"Not found"});
    if (typeof req.body?.role!=="string" || typeof req.body?.reason!=="string" || !req.body.reason.trim() || req.body.reason.length>1000) return reply.code(400).send({error:"укажите роль и причину (до 1000 символов)"});
    try {
      const result=await restartOccupiedSlot(row.id,req.body.role,req.userId,req.body.reason.trim());
      broadcastTaskEvent([row.task_creator_id,row.task_assignee_id],{type:"task:updated",task:getFullTask(row.task_id)});
      if (!result.ok) return reply.code(409).send(result);
      return result;
    } catch(error) { return reply.code(409).send({error:error instanceof Error ? error.message : String(error)}); }
  });

  // ── Прервать шаг ──────────────────────────────────────────────────────
  //
  // Тело: `{ "reason"?: string }`. Что делает:
  //   1. Если в этом процессе есть живой in-process заход этого шага —
  //      вызывает его `abort()` (та же команда, что у sweeper тишины).
  //   2. Закрывает текущий attempt шага с `outcome = 'cancelled'`.
  //   3. Снимает lease (agent_state / agent_id / agent_heartbeat_at) на
  //      шаге, чтобы карточка на доске перестала показываться «в работе».
  //   4. Пишет `subtask_cancelled` в журнал с фактами.
  //
  // Ровно этот шаг — без касания самой задачи и других подзадач.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/subtasks/:id/cancel",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });
      if (!isCancellationActor(req.userId)) {
        return reply.code(403).send({ error: "прервать шаг может владелец или оркестратор" });
      }
      const reason = readReason(req.body);
      const result = cancelSubtaskAttempt(subtask.id, reason, req.userId);

      const fullTask = getFullTask(subtask.task_id);
      broadcastTaskEvent([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return { ok: true, ...result };
    },
  );

  // ── Сбросить попытку ─────────────────────────────────────────────────
  //
  // Тело: `{ "reason"?: string }`. Что делает:
  //   1. Закрывает текущий attempt шага с `outcome = 'reset'` (без abort —
  //      сценарий рассчитан на «зависшую» попытку, у которой живого run
  //      в процессе может уже не быть).
  //   2. Снимает lease, чтобы можно было взять шаг в работу снова.
  //
  // Разница с /cancel в одном: cancel ещё и пытается остановить живой run.
  // reset работает и в случае, когда процесса уже нет — ровно типичная
  // ситуация после рестарта сервера, когда activeRuns пуст, а attempt и
  // agent_state на шаге остались.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/subtasks/:id/reset",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });
      if (!isCancellationActor(req.userId)) {
        return reply.code(403).send({ error: "сбросить попытку может владелец или оркестратор" });
      }
      const reason = readReason(req.body);
      const result = resetSubtaskAttempt(subtask.id, reason, req.userId);
      // Живого запуска нет, а слот занят — держатель повис. Без этого /restart
      // ждал вечно до перезапуска процесса сервера.
      const slotReleased = !activeInProcessRun(subtask.task_id, subtask.id) && forceReleaseSlotSession(subtask.id);

      const fullTask = getFullTask(subtask.task_id);
      broadcastTaskEvent([subtask.task_creator_id, subtask.task_assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return { ok: true, ...result, slotReleased };
    },
  );

  // ── Состояние слота шага (диагностика зависаний) ─────────────────────
  // Только чтение: что в БД (агент, пульс, попытка) и что в памяти процесса
  // (живой запуск, занят ли слот). «Слот занят, запуска нет» = повисший
  // держатель — лечится /reset, затем /restart.
  app.get<{ Params: { id: string } }>(
    "/api/subtasks/:id/slot-status",
    { preHandler: authPre },
    async (req: any, reply) => {
      const subtask = getSubtaskWithTaskForUser(req.params.id, req.userId);
      if (!subtask) return reply.code(404).send({ error: "Not found" });
      if (!isCancellationActor(req.userId)) return reply.code(403).send({ error: "доступно владельцу или оркестратору" });
      const run = activeInProcessRun(subtask.task_id, subtask.id);
      const attempt = subtask.current_attempt_id
        ? db.prepare("SELECT id, started_at, ended_at, outcome FROM attempts WHERE id = ?").get(subtask.current_attempt_id)
        : null;
      const held = isSlotSessionHeld(subtask.id);
      return {
        subtask_id: subtask.id, done: !!subtask.done, agent_id: subtask.agent_id ?? null,
        agent_state: subtask.agent_state ?? null, heartbeat_at: subtask.agent_heartbeat_at ?? null,
        attempt, active_run: run ? { run_id: run.runId, last_activity_at: run.lastActivityAt ?? null } : null,
        slot_held: held, hung_holder: held && !run,
        hint: held && !run ? "слот держит повисший запуск: /reset, затем /restart"
          : !run && subtask.agent_state === "in_progress" ? "шаг числится в работе без живого запуска: /reset, затем /restart"
          : null,
      };
    },
  );

  // ── Отменить задание ─────────────────────────────────────────────────
  //
  // Тело: `{ "reason"?: string }`. Что делает:
  //   1. Прерывает все активные in-process запуски задачи (на самой
  //      задаче и на каждой её незакрытой подзадаче) — теми же abort(), что
  //      и у /cancel.
  //   2. Закрывает ВСЕ действующие попытки этой задачи (включая на
  //      подзадачах) одним UPDATE с `outcome = 'cancelled'`.
  //   3. Снимает lease на задаче и на всех её подзадачах.
  //
  // Это самая грубая из трёх ручек: после неё задача готова к новому
  // запуску заново. Если нужен точечный отзыв — пользуйтесь /cancel и
  // /reset на конкретном шаге.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/tasks/:id/cancel",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });
      if (!isCancellationActor(req.userId)) {
        return reply.code(403).send({ error: "отменить задание может владелец или оркестратор" });
      }
      const reason = readReason(req.body);
      const result = cancelTaskWork(task.id, reason, req.userId);

      const fullTask = getFullTask(task.id);
      broadcastTaskEvent([task.creator_id, task.assignee_id], {
        type: "task:updated",
        task: fullTask,
      });
      return { ok: true, ...result };
    },
  );
}