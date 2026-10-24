import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle, roleUserId } from "../roleRouting.js";
import { technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { logStepAbandoned } from "./abandonedStep.js";
import { wakeAndDeliverStalled } from "./orchestratorWake.js";
import { postOwnerNotification, postRoleNote, taskHeads } from "./stepNotes.js";

/** Сколько неверных вызовов одной операции подряд терпим до остановки роли.
 *  Правило владельца: «если три раза неправильно вызвал инструмент — роль
 *  останавливается». До 24.10.2026 это правило было только подсказкой в
 *  ответе: роль получала текст «СТОП» и продолжала крутиться (55+ неверных
 *  вызовов taskflow_work_plan подряд, карточка 252c400e). Теперь третье
 *  неверное вызов подряд — это стоп хода, а не подсказка. */
export const MISTAKE_LIMIT = 3;

/** Исход остановки хода — для ответа роли и для журнала. */
export type ErrorLoopOutcome = {
  /** Живой in-process запуск прерван. */
  stopped: boolean;
  /** Попытка закрыта с outcome='error_loop'. */
  attemptClosed: boolean;
  /** Шаг переведён в blocked — ждёт решения владельца. */
  blocked: boolean;
  /** Что именно остановили (для ленты и ответа роли). */
  reason: string;
};

/**
 * Остановить ход роли, который зациклился на неверных вызовах.
 *
 * Что делает (по порядку):
 *   1. рвёт живой in-process запуск — иначе роль продолжит крутить вызовы
 *      и жечь модельное время после того, как шаг признан сломанным;
 *   2. закрывает текущую попытку с outcome='error_loop' (не 'cancelled':
 *      отмена — это воля владельца, здесь — собственная ошибка роли);
 *   3. переводит шаг в blocked — слот освобождён, карточка перестаёт
 *      показывать «в работе», решение остаётся за владельцем;
 *   4. пишет технический снимок шага и снимок брошенного шага;
 *   5. оставляет заметку в ленте карточки, уведомление владельцу и
 *      сообщение оркестратору.
 *
 * Идемпотентна: повторный вызов на уже закрытой попытке и уже
 * заблокированном шаге ничего не ломает и не дублирует уведомление.
 */
export async function stopRoleOnErrorLoop(args: {
  taskId?: string | null;
  subtaskId?: string | null;
  role: string;
  operation: string;
  attempts: number;
  reason: string;
}): Promise<ErrorLoopOutcome> {
  const { taskId, subtaskId, role, operation, attempts, reason } = args;
  const blockedReason =
    `ход остановлен: ${attempts} неверных вызовов ${operation} подряд. ${reason}`.slice(0, 600);

  // 1. Рвём живой запуск. Импорт динамический: inProcessRun тянет за собой
  //    roleToolCatalog → universalTaskflow, а мы тут импортируемся из
  //    universalTaskflow — статический импорт замкнул бы кольцо.
  let stopped = false;
  try {
    const { activeInProcessRun } = await import("./inProcessRun.js");
    const run = taskId
      ? activeInProcessRun(taskId, subtaskId ?? undefined)
      : undefined;
    if (run) {
      stopped = true;
      void run.abort().catch(() => {});
    }
  } catch (error) {
    console.warn("[error-loop] прервать запуск не удалось:", error);
  }

  if (!taskId || !subtaskId) {
    return { stopped, attemptClosed: false, blocked: false, reason: blockedReason };
  }

  const subtask = db
    .prepare(
      "SELECT id, title, current_attempt_id, plan_node_key FROM subtasks WHERE id = ?",
    )
    .get(subtaskId) as
    | {
        id: string;
        title: string;
        current_attempt_id: string | null;
        plan_node_key: string | null;
      }
    | undefined;
  if (!subtask) {
    return { stopped, attemptClosed: false, blocked: false, reason: blockedReason };
  }

  // 2. Попытка закрывается явно: без этого шаг остался бы «в работе».
  let attemptClosed = false;
  if (subtask.current_attempt_id) {
    const result = db
      .prepare(
        `UPDATE attempts
            SET ended_at = datetime('now'), outcome = 'error_loop', reason = ?
          WHERE id = ? AND ended_at IS NULL`,
      )
      .run(blockedReason.slice(0, 500), subtask.current_attempt_id);
    attemptClosed = result.changes > 0;
  }

  // 3. Шаг в blocked: агент больше не «в работе», слот свободен.
  db.prepare(
    "UPDATE subtasks SET agent_state = 'blocked', agent_id = ?, current_attempt_id = NULL, agent_heartbeat_at = NULL WHERE id = ?",
  ).run(roleUserId(role), subtaskId);

  // 4. Снимки: что за шаг, где именно встал.
  try {
    technicalSlotSnapshot(subtaskId, "blocked", {
      blocker: blockedReason,
      attemptId: subtask.current_attempt_id,
    });
  } catch (error) {
    console.warn("[error-loop] снимок шага не записался:", error);
  }
  try {
    logStepAbandoned({ taskId, subtaskId, role, reason: blockedReason });
  } catch (error) {
    console.warn("[error-loop] снимок брошенного шага не записался:", error);
  }

  // 5. Владелец и оркестратор узнают сразу — молчаливый автоблок считается
  //    тем же дефектом, что и молчаливый авторестарт (карточка 2beb2bf2).
  const heads = taskHeads(taskId);
  postRoleNote(
    taskId,
    role,
    `«${subtask.title}»: ${blockedReason}`,
  );
  postOwnerNotification(
    taskId,
    subtask.title,
    `⏸ Шаг «${subtask.title}» (${roleTitle(role)}) остановлен: ${attempts} неверных вызовов ${operation} подряд — роль зациклилась и повторяла одну и ту же ошибку. Ход прерван, шаг переведён в blocked, ждёт решения владельца. Задача: «${heads.title}».`,
    {
      notificationType: "error_loop_blocked",
      eventKind: "subtask_error_loop_blocked",
    },
  );
  wakeAndDeliverStalled(
    subtaskId,
    "error_loop_blocked",
    subtask.current_attempt_id ?? `error-loop:${subtask.plan_node_key ?? subtaskId}`,
    `Роль: ${roleTitle(role)}. ${blockedReason} Шаг переведён в blocked, владельцу отправлено уведомление.`,
  );

  return { stopped, attemptClosed, blocked: true, reason: blockedReason };
}

/**
 * Ошибки и успехи по журналу вызовов за окно — чем сторож отличает «ход
 * работает» от «ход крутит один и тот же неверный вызов».
 *
 * Живость по mtime журнала сессии обманывает: цикл неверных вызовов пишет
 * в журнал каждый ход, поэтому файл свежий и ход выглядит живым (24.10.2026,
 * карточка 252c400e — три часа висящего слота). Успешных вызовов при этом
 * ноль: работа не идёт.
 */
export function toolOutcomeStats(
  subtaskId: string,
  windowMinutes: number,
): {
  errors: number;
  ok: number;
  lastErrorAt: string | null;
  lastOperation: string | null;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
         MAX(CASE WHEN outcome = 'error' THEN created_at END) AS last_error_at,
         (SELECT operation FROM role_tool_audit
           WHERE subtask_id = ? AND outcome = 'error'
             AND created_at >= datetime('now', ?)
           ORDER BY created_at DESC LIMIT 1) AS last_operation
       FROM role_tool_audit
        WHERE subtask_id = ? AND created_at >= datetime('now', ?)`,
    )
    .get(
      subtaskId,
      `-${Math.max(1, Math.floor(windowMinutes))} minutes`,
      subtaskId,
      `-${Math.max(1, Math.floor(windowMinutes))} minutes`,
    ) as
    | {
        errors: number | null;
        ok: number | null;
        last_error_at: string | null;
        last_operation: string | null;
      }
    | undefined;
  return {
    errors: Number(row?.errors ?? 0),
    ok: Number(row?.ok ?? 0),
    lastErrorAt: row?.last_error_at ?? null,
    lastOperation: row?.last_operation ?? null,
  };
}
