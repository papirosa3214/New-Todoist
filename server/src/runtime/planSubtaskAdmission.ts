import { wakeAndDeliver } from "./orchestratorWake.js";
import { artifactHasEvidence, artifactGateSatisfied } from "./planArtifactGate.js";
export { artifactHasEvidence } from "./planArtifactGate.js";
import { branchMembership } from "./branchPlan.js";
import { nodePhase, parentPrepPending } from "./branchPhase.js";
import { unmetDependencyIds } from "../enricher.js";
import { recoverSubmittedIncidentReviews, ensureBranchAssembler, ensurePlanFinalReviewer, isPlanFinalReviewStep, queuePlanFinalReview, FINAL_REVIEW_MARKER } from "./planReviewLifecycle.js";
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle, roleUserId } from "../roleRouting.js";
import { runRoleInProcess } from "./inProcessRun.js";
import { INTEGRATION_STEP_MARKER } from "./integrationHandoff.js";
import { planDelivered } from "./planMutations.js";
import { broadcastTaskEvent, broadcastToUsers } from "../ws.js";
import { currentResultVersion, ensureResultVersionForReview } from "../resultVersions.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
import { bumpContextVersion } from "./taskContextVersion.js";
import { technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { getFullTask } from "../routes/subtasks.js";
import { logStepOutcome } from "./stepOutcome.js";
import { classifyFailureReason, failureReasonLabel, type FailureReasonCode } from "./failureReasons.js";
import { decideFailureAction, failurePolicy } from "./failurePolicy.js";
import { logStepAbandoned } from "./abandonedStep.js";
import { closeStaleInboxForSubtask } from "./topicInbox.js";
import { announceStepState } from "./stepTopicProgress.js";

/**
 * Узлы collaboration plan — обычные `subtasks` с `collaboration_plan_id` +
 * `plan_node_key`, не отдельная сущность (docs/2026-09-29-
 * role-slot-execution-integration/DESIGN.md, владелец 29.09.2026). Этот
 * модуль заменяет собой бывший `routes/task-role-slots.ts`: та же
 * gate-логика (`canBecomeReady`) и автостарт (`unlockReadySlots`/
 * `startSlotRun`), только источник состояния — `subtasks`, а не отдельный
 * FSM `state`.
 *
 * Три исходных `start_condition` (`submitted`/`accepted`/`artifact_ready`)
 * на подзадаче без артефактного контракта схлопываются в одну проверку
 * `done = 1` — у subtasks нет промежуточного «сдано, но не принято»
 * состояния отдельно от галочки, и владелец 29.09.2026 решил не изобретать
 * его искусственно. Для узлов С контрактом (`output_artifact`) статус
 * версии артефакта (`subtask_artifact_versions.status`) по-прежнему
 * различает submitted/accepted для приёмки, но передача открывается после сдачи — см. `canPlanSubtaskBecomeReady`.
 */

export type PlanSubtask = {
  id: string;
  task_id: string;
  title: string;
  done: number;
  agent_id: string | null;
  agent_state: string | null;
  result: string | null;
  current_attempt_id: string | null;
  collaboration_plan_id: string | null;
  plan_node_key: string | null;
  /** MAK-77: модель шага («провайдер/модель»); NULL — по настройкам роли. */
  model?: string | null;
  /** Карточка 8aa95906 (admission): durable fingerprint текущего gate. NULL
   *  означает «нет активной попытки — можно открыть в новом цикле»; иначе
   *  сравнивается при claim через UPDATE WHERE admission_fingerprint=?. */
  admission_fingerprint?: string | null;
  /** Номер текущего цикла доработки. Увеличивается при changes_requested,
   *  чтобы старые попытки из прежнего цикла не активировали узел заново. */
  admission_cycle?: number;
};

/** Сравнить узел с ранее сохранённым fingerprint. Возвращает true, если
 *  либо fingerprint ещё не задан (первая попытка цикла), либо совпадает с
 *  ожидаемым (та же идентичность — повторный вызов после сбоя). */
function fingerprintMatches(row: PlanSubtask, expected: string | null): boolean {
  if (row.admission_fingerprint === undefined) {
    // старая схема без поля — для обратной совместимости считаем «совпадает»
    return true;
  }
  return row.admission_fingerprint === null || row.admission_fingerprint === expected;
}

/** Построить fingerprint текущего gate: task_id|plan_id|slot|cycle|cycle_of_predecessors. */
function computeAdmissionFingerprint(input: {
  taskId: string;
  planId: string | null;
  slotKey: string | null;
  cycle: number;
  predecessorFingerprint?: string | null;
}): string {
  const hash = crypto.createHash("sha256");
  hash.update(`${input.taskId}|${input.planId ?? ""}|${input.slotKey ?? ""}|${input.cycle}|${input.predecessorFingerprint ?? ""}`);
  return hash.digest("hex").slice(0, 32);
}

type ArtifactVersion = {
  id: string;
  subtask_id: string;
  version_no: number;
  artifact_key: string;
  status: "submitted" | "accepted" | "revision_requested" | "rejected";
  evidence_json: string;
  note_id?: string | null;
};

function subtask(subtaskId: string): PlanSubtask | undefined {
  return db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId) as PlanSubtask | undefined;
}

function latestArtifact(subtaskId: string): ArtifactVersion | undefined {
  return db.prepare("SELECT * FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1").get(subtaskId) as ArtifactVersion | undefined;
}

export type WaitingFor = { from_slot_key: string; artifact_key: string | null; reason: string };

/**
 * Чего именно ждёт узел плана: по каждому входящему ребру, которое ещё не выполнено, — от кого и почему
 * («результат не сдан», «нет ссылок-доказательств», «предшественник не закрыт»). Нужен, чтобы в
 * карточке ожидающий шаг не стоял молча (07.10.2026: Разработчик ждал результат Дизайнера, а увидеть
 * это было нечем). Условия те же, что в `canPlanSubtaskBecomeReady`.
 */
export function waitingForPredecessors(row: PlanSubtask): WaitingFor[] {
  if (!row.collaboration_plan_id || !row.plan_node_key) return [];
  const edges = db.prepare("SELECT from_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ?")
    .all(row.collaboration_plan_id, row.plan_node_key) as Array<{ from_slot_key: string; start_condition: string; artifact_key: string | null }>;
  const out: WaitingFor[] = [];
  for (const edge of edges) {
    const predecessor = db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .get(row.collaboration_plan_id, edge.from_slot_key) as PlanSubtask | undefined;
    if (!predecessor) { out.push({ from_slot_key: edge.from_slot_key, artifact_key: edge.artifact_key, reason: "шаг предшественника не создан" }); continue; }
    if (edge.artifact_key) {
      const artifact = latestArtifact(predecessor.id);
      if (!artifact || artifact.artifact_key !== edge.artifact_key) {
        out.push({ from_slot_key: edge.from_slot_key, artifact_key: edge.artifact_key, reason: predecessor.done ? "шаг закрыт, но результат не сдан" : "результат ещё не сдан" });
      } else if (edge.start_condition === "artifact_ready" && !artifactHasEvidence(artifact)) {
        out.push({ from_slot_key: edge.from_slot_key, artifact_key: edge.artifact_key, reason: "в результате нет ссылок-доказательств" });
      } else if (!artifactGateSatisfied(edge.start_condition, artifact)) {
        out.push({ from_slot_key: edge.from_slot_key, artifact_key: edge.artifact_key, reason: "результат отклонён или отправлен на доработку" });
      }
    } else if (!predecessor.done) {
      out.push({ from_slot_key: edge.from_slot_key, artifact_key: null, reason: "шаг ещё не закрыт" });
    }
  }
  return out;
}

/**
 * Может ли узел плана открыться (перестать ждать предшественников).
 * `row` — сама подзадача-узел (ещё не начатая: agent_state IS NULL, done=0).
 */
export function canPlanSubtaskBecomeReady(row: PlanSubtask): boolean {
  if (!row.collaboration_plan_id || !row.plan_node_key) return true;
  if (unmetDependencyIds(row.task_id).length) return false;
  // Итоговый шаг родителя ждёт закрытия всех дочерних; подготовительный
  // («до дочерних», branchPhase.ts) — нет, он и есть начало ветки.
  if(nodePhase(row.collaboration_plan_id,row.plan_node_key)!=='before' && db.prepare("SELECT 1 FROM tasks WHERE parent_id=? AND status<>'completed'").get(row.task_id)) return false;
  // Дочерняя ждёт, пока родитель закончит подготовку и раздаст вводные.
  if(parentPrepPending(row.task_id)) return false;
  const edges = db.prepare("SELECT from_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ?")
    .all(row.collaboration_plan_id, row.plan_node_key) as Array<{ from_slot_key: string; start_condition: string; artifact_key: string | null }>;
  return edges.every((edge) => {
    const predecessor = db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .get(row.collaboration_plan_id, edge.from_slot_key) as PlanSubtask | undefined;
    if (!predecessor) return false;
    if (edge.artifact_key) {
      const artifact = latestArtifact(predecessor.id);
      if (!artifact || artifact.artifact_key !== edge.artifact_key) return false;
      return artifactGateSatisfied(edge.start_condition, artifact);
    }
    // Без артефактного контракта — done=1 закрывает узел вне зависимости
    // от заявленного start_condition (submitted/accepted/artifact_ready
    // неразличимы на уровне subtasks, см. комментарий модуля).
    return predecessor.done === 1;
  });
}

/**
 * Шаг плана — чей он (владелец 30.09.2026, docs/2026-09-30-live-
 * collaboration-plan-spec.md): архитектор «закрыл» шаги QA и критика,
 * взяв их в работу обычным /work и поставив галочку. Принадлежности к
 * задаче мало — ИИ берёт и закрывает только узел своей роли, а начать
 * его может, только когда открылись предшественники. Владелец и люди
 * вмешиваются явно, их это не касается (проверка — только для type='ai').
 * Возвращает текст отказа или null.
 */
export function planNodeAgentRefusal(subtaskId: string, userId: string, starting: boolean): string | null {
  const row = subtask(subtaskId);
  if (!row?.collaboration_plan_id || !row.plan_node_key) return null;
  const caller = db.prepare("SELECT type FROM users WHERE id = ?").get(userId) as { type?: string } | undefined;
  if (caller?.type !== "ai") return null;
  const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(row.collaboration_plan_id, row.plan_node_key) as { role_key: string } | undefined;
  if (!node) return "узел плана не найден";
  if (roleUserId(node.role_key) !== userId) {
    return `это шаг плана роли «${roleTitle(node.role_key)}»: брать и закрывать его может только она. ` +
      "Передать работу — значит сдать свой шаг, следующий откроется сам";
  }
  if (starting) {
    const plan = db.prepare("SELECT status FROM task_collaboration_plans WHERE id=?").get(row.collaboration_plan_id) as {status:string} | undefined;
    if (plan?.status !== "approved") return "план ещё не утверждён";
    if (!canPlanSubtaskBecomeReady(row)) return "шаг плана ещё ждёт предшественников — он откроется сам, когда они сдадут работу";
  }
  return null;
}

/**
 * Реальный старт роли на узле плана: помечает подзадачу in_progress,
 * заводит ей attempt (тот же инвариант «одна активная попытка на
 * subtask_id», что и у обычного `POST /api/subtasks/:id/work`) и запускает
 * `runRoleInProcess`. Общее тело для автостарта корневых узлов из
 * `/approve` и для узлов, открывшихся по графу через
 * `unlockReadyPlanSubtasks`.
 */
export async function startPlanSubtaskRun(subtaskId: string, actorId: string, options: { freshSession?: boolean } = {}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const current = subtask(subtaskId);
  if (!current || !current.collaboration_plan_id || !current.plan_node_key) return { ok: false, error: "подзадача не узел плана" };
  if (current.done || current.agent_state) return { ok: false, error: "узел плана уже начат или закрыт" };
  if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND archived_at IS NULL").get(current.task_id)) return {ok:false,error:"Задача в архиве — запуск запрещён"};
  const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(current.collaboration_plan_id, current.plan_node_key) as { role_key: string } | undefined;
  if (!node) return { ok: false, error: "узел плана не найден в DAG" };

  const approved=db.prepare("SELECT status FROM task_collaboration_plans WHERE id=?").get(current.collaboration_plan_id) as {status:string}|undefined;
  if(approved?.status!=="approved")return {ok:false,error:"План ещё не утверждён"};
  if (!canPlanSubtaskBecomeReady(current)) return { ok: false, error: "Узел ждёт зависимостей задачи или результатов предшествующих этапов" };

  const terminalCritic = node.role_key === "critic_verifier" && !db.prepare("SELECT 1 FROM task_collaboration_plan_edges WHERE plan_id=? AND from_slot_key=?").get(current.collaboration_plan_id,current.plan_node_key);
  if ((terminalCritic || isPlanFinalReviewStep(current.id)) && !options.freshSession) {
    db.prepare("UPDATE task_collaboration_plan_nodes SET instructions=? || char(10) || COALESCE(instructions,'') WHERE plan_id=? AND slot_key=?").run(FINAL_REVIEW_MARKER,current.collaboration_plan_id,current.plan_node_key);
    return queuePlanFinalReview(current.id,actorId);
  }

  const attemptId = crypto.randomUUID();
  const acquired=db.transaction(()=>{
    const latest=subtask(current.id);
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=? AND archived_at IS NULL").get(current.task_id)) return false;
    if(!latest||latest.done||latest.agent_state||!canPlanSubtaskBecomeReady(latest))return false;
    if(db.prepare("SELECT 1 FROM attempts WHERE subtask_id=? AND ended_at IS NULL").get(current.id))return false;
    db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,routing_role,started_at,heartbeat_at) VALUES(?,?,?,?,?,datetime('now'),datetime('now'))").run(attemptId,current.task_id,current.id,roleUserId(node.role_key),node.role_key);
    // Карточка 8aa95906 (admission): durable fingerprint.
    // Сравниваем по (agent_state IS NULL AND done=0 AND
    // (admission_fingerprint IS NULL OR admission_fingerprint = ?)).
    // Fingerprint остаётся ненулевым до конца попытки, чтобы повторный
    // claim для той же subtask_id упирался в UNIQUE-индекс attempts
    // (см. db.ts, idx_attempts_one_active_per_subtask) и в фильтр
    // fingerprint. На новый цикл fingerprint сбрасывается в
    // closeOpenCriticPlanNode(changes_requested) рядом с инкрементом
    // admission_cycle.
    const expectedFingerprint = latest.admission_fingerprint ?? null;
    const newFingerprint = computeAdmissionFingerprint({
      taskId: current.task_id,
      planId: current.collaboration_plan_id,
      slotKey: current.plan_node_key,
      cycle: (latest.admission_cycle ?? 0) + 1,
      predecessorFingerprint: expectedFingerprint,
    });
    const changed=db.prepare(`UPDATE subtasks SET agent_state='in_progress',agent_id=?,current_attempt_id=?,agent_heartbeat_at=datetime('now'),admission_cycle=COALESCE(admission_cycle,0)+1,admission_fingerprint=? WHERE id=? AND done=0 AND agent_state IS NULL AND (admission_fingerprint IS NULL OR admission_fingerprint = ?)`).run(roleUserId(node.role_key),attemptId,newFingerprint,current.id,expectedFingerprint);
    if(changed.changes!==1)throw new Error("Слот уже запущен или его входные данные изменились");
    // Карточка 7efcc173: одна строка прогресса в теме задачи на допуск
    // шага. Транзакция ещё открыта, но announceStepState пишет в ту же БД,
    // поэтому откат уносит и строку, и её дедупликатор.
    announceStepState(current.id,"started");
    return true;
  })();
  if(!acquired)return {ok:false,error:"Слот уже запущен или его входные данные изменились"};

  try {
    const run = await runRoleInProcess({ taskId: current.task_id, role: node.role_key, subtaskId: current.id, mode: node.role_key === "critic_verifier" ? "review" : "work", prompt: node.role_key === "critic_verifier" ? (await import("./inProcessRun.js")).reviewPromptFor(current.task_id) + "\n\n" + (await import("./planReviewLifecycle.js")).planReviewRouteContext(current.task_id) : undefined, freshSession: options.freshSession, model: current.model || undefined });
    logEvent({ taskId: current.task_id, actorId, kind: "plan_subtask_started", field: current.plan_node_key, toValue: roleTitle(node.role_key) });
    // Режим «Оркестратор»: повторная попытка того же шага — повод взглянуть.
    if ((subtask(current.id)?.admission_cycle ?? 0) > 1) wakeAndDeliver(current.id, actorId, "retry", null);
    return { ok: true, runId: run.runId };
  } catch (error) {
    db.prepare("UPDATE subtasks SET agent_state = NULL, agent_id = NULL, current_attempt_id = NULL WHERE id = ?").run(current.id);
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'failed', reason = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), attemptId);
    // Снимок неудачного старта: роль не отработала вовсе, но следующий вызов
    // должен знать причину, а не гадать по пустому лоту.
    technicalSlotSnapshot(current.id, "failed", {
      blocker: error instanceof Error ? error.message : String(error),
      attemptId,
    });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Открывает по графу все узлы плана, чьи предшественники выполнены, и сразу
 * стартует роль в каждом — «роль сама впрягается в работу», без ручного
 * триггера. Неудача одного узла не должна ронять соседние независимые
 * ветки — try/catch на каждый отдельно.
 *
 * Разделение «вход vs цепочка»: `task_intake_mode` управляет только
 * входом (`startSingleExecutorPlan`), а утверждение плана — единственная
 * точка согласия владельца. До него узлов не существует; после — цепочка
 * идёт сама, в любом режиме. Гейта по режиму здесь больше нет.
 */
/**
 * MAK-98: самоснятие блока-зависимости. Шаг, ушедший в blocked как
 * dependency, становится свободным ровно тогда, когда готовы его
 * предшественники — проверка та же (`canPlanSubtaskBecomeReady`), что у
 * обычного допуска. Возвращает число снятых блоков. Без этого проход
 * `unlockReadyPlanSubtasks` смотрит только на `agent_state IS NULL` и
 * dependency-шаг ждал бы вечно.
 */
export function liftDependencyBlocks(planId: string, taskId: string, actorId: string): number {
  const dependencyBlocked = db
    .prepare(
      `SELECT * FROM subtasks
        WHERE collaboration_plan_id = ? AND done = 0
          AND agent_state = 'blocked' AND block_type = 'dependency'`,
    )
    .all(planId) as PlanSubtask[];
  let lifted = 0;
  for (const node of dependencyBlocked) {
    if (!canPlanSubtaskBecomeReady(node)) continue;
    const changed = db
      .prepare(
        `UPDATE subtasks
            SET agent_state = NULL, agent_id = NULL, block_type = NULL, blocked_at = NULL
          WHERE id = ? AND agent_state = 'blocked'`,
      )
      .run(node.id).changes;
    if (changed) {
      logEvent({
        taskId,
        actorId,
        kind: "dependency_block_lifted",
        field: node.plan_node_key,
        toValue: node.title,
      });
      lifted += 1;
    }
  }
  return lifted;
}

export async function unlockReadyPlanSubtasks(planId: string | null, taskId: string, actorId: string): Promise<void> {
  if (!planId) return;
  if (finishPlanIfComplete(planId, taskId, actorId)) return;
  liftDependencyBlocks(planId, taskId, actorId);
  const waiting = db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id = ? AND done = 0 AND agent_state IS NULL").all(planId) as PlanSubtask[];
  if (waiting.length === 0) return;
  for (const next of waiting) {
    if (!canPlanSubtaskBecomeReady(next)) continue;
    try {
      const started = await startPlanSubtaskRun(next.id, actorId);
      if (!started.ok) {
        logStepOutcome({ taskId, actorId, subtaskId: next.id, outcome: "failed", error: started.error });
      }
    } catch (error) {
      logStepOutcome({ taskId, actorId, subtaskId: next.id, outcome: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Сообщение роли в ленту карточки. Напрямую, а не маршрутом комментариев:
 *  писать туда роль может только в своей карточке, а узел плана бывает и
 *  в чужой. */
function roleNote(taskId: string, role: string, text: string): void {
  db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), taskId, roleUserId(role), text);
  const task = db.prepare("SELECT creator_id, assignee_id FROM tasks WHERE id = ?").get(taskId) as
    | { creator_id: string | null; assignee_id: string | null }
    | undefined;
  if (task) {
    broadcastTaskEvent([task.creator_id, task.assignee_id], { type: "task:updated", task: getFullTask(taskId) });
  }
}

/** Сколько обрывов подряд терпим, прежде чем перестать продолжать самим. */
const INTERRUPTS_BEFORE_BLOCK = 2;
const INTERRUPT_WINDOW = "-30 minutes";

/** Сбросить задания этой задачи в `role_run_jobs` (Г1-к, 06.10.2026):
 *  прежний `dedupe_key` мог уже сидеть как `succeeded`/`skipped` и новый
 *  запуск вернёт ту же запись вместо свежей попытки. Возвращает
 *  количество сброшенных job'ов, чтобы тест мог это проверить. */
function resetRoleRunJobsForTask(taskId: string): number {
  return db.prepare(
    `UPDATE role_run_jobs
        SET status = 'queued',
            attempts = 0,
            available_at = datetime('now'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = 'сброс дедупликации при восстановлении после рестарта',
            started_at = NULL,
            finished_at = NULL,
            updated_at = datetime('now')
      WHERE task_id = ?
        AND status IN ('succeeded', 'skipped', 'dead', 'cancelled', 'retry_wait')`,
  ).run(taskId).changes;
}

/**
 * Брошенные после перезапуска сервера узлы плана (владелец 01.10.2026, T05;
 * доработка 05.10.2026, MAK-66 critic rework — todo/blocked).
 *
 * Ход роли живёт только внутри процесса сервера, поэтому при старте любой
 * узел плана «в работе» — заведомо брошенный: его ход умер вместе с прошлым
 * процессом. Раньше такой узел оставался «в работе» навсегда, а следующие
 * роли его ждали — в ленте тишина. Теперь: попытка закрывается как
 * `interrupted`, роль пишет в ленту, что её ход оборвался, и продолжает
 * тот же разговор (сессия узла сохранена на диске). Второй обрыв за
 * полчаса — узел `blocked` и сообщение владельцу, без повторов по кругу.
 *
 * Помимо `in_progress`, пересматриваем и узлы `todo`/`blocked`: после
 * рестарта у них тоже нет живой аренды, поэтому сбрасываем `agent_state`
 * в NULL и сообщаем в ленту, что узел снова свободен. Авто-старта не
 * делаем — `todo` сам подхватит worker, когда дойдёт очередь; `blocked`
 * владелец должен разморозить сам.
 *
 * Разделение «вход vs цепочка»: `task_intake_mode` больше не глушит
 * восстановление утверждённого плана. После рестарта узел продолжается
 * сам, в любом режиме — согласием владельца было утверждение плана.
 */
export type RecoverOptions = {
  /** Узлы, которые не трогаем (например, у них идёт живой запуск). */
  skip?: (row: PlanSubtask) => boolean;
  /** Причина обрыва в попытке, снимке и ленте: при старте — рестарт сервера, при кнопке владельца — другое. */
  reason?: string;
};

export async function recoverInterruptedPlanSubtasks(opts: RecoverOptions = {}): Promise<{ resumed: number; blocked: number; freed: number }> {
  const byServerRestart = !opts.reason;
  const reason = opts.reason ?? "перезапуск сервера";
  const rows = (db.prepare(
    "SELECT * FROM subtasks WHERE collaboration_plan_id IS NOT NULL AND done = 0 AND agent_state IN ('in_progress','todo','blocked') AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=subtasks.task_id AND t.archived_at IS NULL)",
  ).all() as PlanSubtask[]).filter((row) => !opts.skip?.(row));
  let resumed = 0;
  let blocked = 0;
  let freed = 0;
  for (const row of rows) {
    const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
      .get(row.collaboration_plan_id, row.plan_node_key) as { role_key: string } | undefined;
    if (!node) {
      // Узел без живой роли в плане — на рестарте снимаем признак аренды,
      // чтобы он снова попал в общую очередь.
      if (row.current_attempt_id) {
        db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = ? WHERE id = ? AND ended_at IS NULL")
          .run(reason, row.current_attempt_id);
      }
      db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
      resetRoleRunJobsForTask(row.task_id);
      closeStaleInboxForSubtask(row.id);
      freed += 1;
      continue;
    }
    if (row.agent_state === "in_progress") {
      if (row.current_attempt_id) {
        db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = ? WHERE id = ? AND ended_at IS NULL")
          .run(reason, row.current_attempt_id);
      }
      // Техснимок обрыва (владелец 04.10.2026). Модель сюда не успевает ответить
      // — её ход умер вместе с процессом, — поэтому пишем то, что сервер знает
      // точно: последнее действие по слоту, состояние и ссылки на артефакты.
      // Пометка «неполный» обязательна: следующий вызов роли должен понимать,
      // что это техфакты, а не её собственный отчёт.
      technicalSlotSnapshot(row.id, "stopped", {
        blocker: byServerRestart ? "ход оборвался перезапуском сервера" : `ход оборван: ${reason}`,
        attemptId: row.current_attempt_id,
      });
      db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
      // ХВОСТ ИНБОКСА ТЕМЫ НА ОБРЫВЕ (карточка 6f180f38, шаг 3).
      //
      // До правки сообщения владельца, попавшие в `slot_topic_inbox` через
      // `deliverTopicToWork` сразу после старта, оставались `delivered_at
      // IS NULL` и после прерывания: попытка закрылась, новый запуск начнёт
      // с нуля и не прочитает «доставленное», а прежняя строка останется
      // висеть. Гасим её здесь, идемпотентно.
      closeStaleInboxForSubtask(row.id);
      logStepOutcome({ taskId: row.task_id, actorId: null, subtaskId: row.id, outcome: "interrupted", code: "runtime_died", message: reason });
      // Шаг брошен (MAK-97): ход умер вместе с процессом — к событию
      // прикладываем хвост журнала и снимок git рабочей копии.
      logStepAbandoned({ taskId: row.task_id, subtaskId: row.id, role: node.role_key, reason });
      const { n: interrupts } = db.prepare(
        `SELECT COUNT(*) AS n FROM attempts
          WHERE subtask_id = ? AND outcome = 'interrupted' AND ended_at >= datetime('now', '${INTERRUPT_WINDOW}')`,
      ).get(row.id) as { n: number };
      if (interrupts >= INTERRUPTS_BEFORE_BLOCK) {
        db.prepare("UPDATE subtasks SET agent_state = 'blocked', agent_id = ? WHERE id = ?").run(roleUserId(node.role_key), row.id);
        blocked += 1;
        roleNote(
          row.task_id,
          node.role_key,
          byServerRestart
            ? `«${row.title}»: ход снова оборвался перезапуском сервера — второй раз за полчаса. Сам больше не продолжаю, нужен ваш взгляд.`
            : `«${row.title}»: ход снова оборвался (${reason}) — второй раз за полчаса. Сам больше не продолжаю, нужен ваш взгляд.`,
        );
        continue;
      }
      roleNote(
        row.task_id,
        node.role_key,
        byServerRestart
          ? `«${row.title}»: мой ход оборвался — сервер перезапустился. Продолжаю с того же места.`
          : `«${row.title}»: мой ход оборвался (${reason}). Продолжаю с того же места.`,
      );
      // После `interrupted` старый dedupe_key мог уже сидеть `succeeded`
      // (Г1-к, 06.10.2026): сбрасываем `role_run_jobs` этой задачи,
      // чтобы новый запуск не подобрал чужое задание.
      resetRoleRunJobsForTask(row.task_id);
      const started = await startPlanSubtaskRun(row.id, roleUserId(node.role_key));
      if (started.ok) {
        resumed += 1;
      } else {
        logStepOutcome({ taskId: row.task_id, actorId: null, subtaskId: row.id, outcome: "failed", error: started.error });
      }
      continue;
    }
    // todo / blocked: аренды нет, узел снова свободен — сбрасываем без
    // авто-старта. worker подхватит `todo` когда дойдёт очередь; `blocked`
    // размораживает владелец или оркестратор через state=in_progress.
    if (row.current_attempt_id) {
      db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = ? WHERE id = ? AND ended_at IS NULL")
        .run(reason, row.current_attempt_id);
    }
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
    // Снимаем `succeeded`/`dead` задания этой задачи в `role_run_jobs`,
    // чтобы worker не подобрал прошлый dedupe_key, когда дойдёт очередь.
    resetRoleRunJobsForTask(row.task_id);
    // Тот же хвост инбокса темы, что выше для `in_progress`: если слот
    // висел в `todo`/`blocked` и его аренду снимают на рестарте, незакрытые
    // строки `slot_topic_inbox` ему больше не нужны — никто их не прочитает.
    closeStaleInboxForSubtask(row.id);
    freed += 1;
    roleNote(
      row.task_id,
      node.role_key,
      byServerRestart
      ? `«${row.title}»: после рестарта сервера снят признак «${row.agent_state}» — узел снова свободен.`
      : `«${row.title}»: снят признак «${row.agent_state}» (${reason}) — узел снова свободен.`,
    );
  }
  return { resumed, blocked, freed };
}

/** Продолжений одного шага за окно, после которых он блокируется. */
const MAX_NODE_CONTINUATIONS = 3;
const NODE_CONTINUATION_WINDOW = "-120 minutes";
/** Повторов временного сбоя за окно (по коду причины, MAK-97). */
const TRANSIENT_RETRY_WINDOW = "-30 minutes";
/** Потолок «сжали и продолжили» на случай, если сжатие не помогает. */
const MAX_COMPRESS_CONTINUES = 2;

/** Сколько раз этот шаг уже повторялся по данному коду причины в окне. */
function transientRetryCount(subtaskId: string, code: FailureReasonCode): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM attempts
      WHERE subtask_id = ? AND outcome = 'transient_retry' AND reason LIKE ?
        AND started_at >= datetime('now', '${TRANSIENT_RETRY_WINDOW}')`,
  ).get(subtaskId, `${code}:%`) as { n: number };
  return row.n;
}

/**
 * Ход роли по шагу плана закончился, а шаг не сдан (находка А30). Раньше узел
 * оставался «в работе» без живого запуска и висел, пока оркестратор не
 * перезапускал его руками. Теперь: был прогресс и продолжений меньше трёх —
 * тот же разговор продолжается; иначе (нет прогресса, лимит продолжений или
 * ошибка запуска) шаг ВИДИМО блокируется с причиной в ленте.
 * `starter` — подмена запуска в тестах.
 */
export async function settleStalledPlanNode(
  params: { subtaskId: string; madeProgress: boolean; failure?: string | null; failureCode?: FailureReasonCode | null },
  starter: typeof startPlanSubtaskRun = startPlanSubtaskRun,
): Promise<"skipped" | "continued" | "blocked"> {
  // Выключатель для тестов жизненного цикла, где подменённая роль заканчивает ход мгновенно.
  if (process.env.TASKFLOW_SETTLE_STALLED_NODES === "off") return "skipped";
  const row = subtask(params.subtaskId);
  if (!row || row.done || row.agent_state !== "in_progress" || !row.collaboration_plan_id || !row.plan_node_key) return "skipped";
  const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(row.collaboration_plan_id, row.plan_node_key) as { role_key: string } | undefined;
  if (!node) return "skipped";

  const closeAttempt = (outcome: string, reason: string): void => {
    if (row.current_attempt_id) {
      db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = ?, reason = ? WHERE id = ? AND ended_at IS NULL")
        .run(outcome, reason, row.current_attempt_id);
    }
  };
  const block = (why: string): "blocked" => {
    closeAttempt(params.failure ? "failed" : "stalled", why.slice(0, 200));
    db.prepare("UPDATE subtasks SET agent_state = 'blocked', agent_id = ?, current_attempt_id = NULL WHERE id = ?")
      .run(roleUserId(node.role_key), row.id);
    logStepOutcome({ taskId: row.task_id, actorId: null, subtaskId: row.id, outcome: "blocked", error: why });
    // Шаг брошен (MAK-97): к событию приложены хвост журнала и снимок git,
    // чтобы получатель видел, где работа остановилась.
    logStepAbandoned({ taskId: row.task_id, subtaskId: row.id, role: node.role_key, reason: why });
    roleNote(row.task_id, node.role_key, `«${row.title}»: ход закончился без сдачи шага. ${why} Шаг заблокирован: нужен перезапуск владельцем или оркестратором.`);
    return "blocked";
  };

  // Повтор по коду причины (MAK-97): временный сбой повторяем сами, пока не
  // кончится потолок; переполнение контекста — сжать и продолжить; доступ,
  // конфиг и отсутствие модели не повторяем вовсе. Смену модели делает
  // failover в `inProcessRun`; если сюда дошли с `switch_model` — цепочка
  // исчерпана, и это уже блок.
  const retryAfterFailure = async (code: FailureReasonCode, reason: string, permanent: boolean): Promise<"continued"> => {
    const total = transientRetryCount(row.id, code) + 1;
    closeAttempt("transient_retry", `${code}: ${reason.slice(0, 180)}`);
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
    logEvent({
      taskId: row.task_id,
      actorId: null,
      kind: permanent ? "plan_subtask_compress_continue" : "plan_subtask_transient_retry",
      field: row.plan_node_key,
      toValue: `${code}: ${permanent ? "сжатие и продолжение" : `повтор ${total} из ${failurePolicy(code).maxRetries}`}`,
    });
    const started = await starter(row.id, roleUserId(node.role_key));
    if (!started.ok) {
      logStepOutcome({ taskId: row.task_id, actorId: null, subtaskId: row.id, outcome: "failed", error: started.error });
    }
    return "continued";
  };

  if (params.failure) {
    const code = params.failureCode ?? classifyFailureReason(params.failure);
    let decision = decideFailureAction(code, transientRetryCount(row.id, code));
    if (decision === "compress_continue" && transientRetryCount(row.id, code) >= MAX_COMPRESS_CONTINUES) {
      decision = "block";
    }
    if (decision === "retry") return retryAfterFailure(code, params.failure, false);
    if (decision === "compress_continue") return retryAfterFailure(code, params.failure, true);
    if (decision === "switch_model") {
      return block(`Лимит провайдера, запасных моделей не осталось (${failureReasonLabel(code)}).`);
    }
    return block(`Запуск оборвался ошибкой (${failureReasonLabel(code)}): ${params.failure.slice(0, 120)}.`);
  }
  const { n: continued } = db.prepare(
    `SELECT COUNT(*) AS n FROM attempts WHERE subtask_id = ? AND outcome = 'continued' AND started_at >= datetime('now', '${NODE_CONTINUATION_WINDOW}')`,
  ).get(row.id) as { n: number };
  if (!params.madeProgress) return block("За ход не было работы (вызовов инструментов почти нет).");
  if (continued >= MAX_NODE_CONTINUATIONS) return block(`Продолжений за два часа уже ${continued}, лимит ${MAX_NODE_CONTINUATIONS}.`);

  closeAttempt("continued", "ход закончился без сдачи при наличии прогресса; продолжение сервером");
  db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
  logEvent({ taskId: row.task_id, actorId: null, kind: "plan_subtask_continued", field: row.plan_node_key, toValue: `продолжение ${continued + 1} из ${MAX_NODE_CONTINUATIONS}` });
  const started = await starter(row.id, roleUserId(node.role_key));
  if (!started.ok) {
    logStepOutcome({ taskId: row.task_id, actorId: null, subtaskId: row.id, outcome: "failed", error: started.error });
    return "continued";
  }
  return "continued";
}

/**
 * План совместной работы сдан целиком → карточка на проверку (владелец
 * 01.10.2026, T05: все семь ролей сдали, а карточка висела «активной»).
 *
 * Обычный роллап «все шаги закрыты → review» (routes/subtasks.ts) сюда не
 * дотягивается: он ждёт карточку «в работе», а у карточки с планом
 * работают узлы, сама она без состояния. И считаем мы только узлы плана —
 * личные шаги, которые роль завела себе по ходу, сдачу не держат.
 *
 * Путь тот же, что у штатной сдачи: версия результата (по ней проверяющий
 * выносит вердикт), закрытая попытка, проверяющий в очереди, уведомление
 * автору, проверка родителя. К владельцу карточка приходит только после
 * вердикта проверяющего — «в любом случае», даже если в плане был Критик.
 * Возвращает true, если карточка ушла на проверку этим вызовом.
 */
export function finishPlanIfComplete(planId: string, taskId: string, actorId: string | null): boolean {
  const plan = db.prepare("SELECT id, status FROM task_collaboration_plans WHERE id = ? AND task_id = ?")
    .get(planId, taskId) as { id: string; status: string } | undefined;
  if (!plan || plan.status !== "approved") return false;
  const nodes = db.prepare(
    "SELECT title, done, result, plan_node_key FROM subtasks WHERE collaboration_plan_id = ? ORDER BY position",
  ).all(planId) as Array<{ title: string; done: number; result: string | null; plan_node_key: string | null }>;
  if (nodes.length === 0 || nodes.some((n) => !n.done)) return false;
  // Последним закрыт шаг интеграции — план уже был сдан и принят, второй сдачи нет.
  const lastKey = nodes[nodes.length - 1].plan_node_key;
  if (lastKey && db.prepare("SELECT 1 FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ? AND instructions LIKE ?").get(planId, lastKey, INTEGRATION_STEP_MARKER + "%")) return false;
  const task = db.prepare("SELECT id, title, status, agent_state, creator_id, assignee_id, current_attempt_id FROM tasks WHERE id = ?")
    .get(taskId) as
    | { id: string; title: string; status: string; agent_state: string | null; creator_id: string | null; assignee_id: string | null; current_attempt_id: string | null }
    | undefined;
  if (!task || task.status !== "active" || task.agent_state === "review") return false;
  if (planDelivered(taskId, planId)) return false;
  // Корень ветки без Архитектора на выходе — он подключается сам и собирает итог.
  if (ensureBranchAssembler(planId, taskId)) return false;
  // tcpo_791b4519: согласование владельца ещё открыто — не закрывать план,
  // не переводить карточку в review, не оставлять ложного успеха. Возвращаем
  // false и оставляем задачу активной; очередь согласования уже создала
  // видимое уведомление plan_approval_request через notifyPlanApprovalRequest.
  const pendingProposal = db.prepare("SELECT id FROM task_collaboration_plan_ops WHERE plan_id = ? AND status = 'proposed' LIMIT 1")
    .get(planId) as { id: string } | undefined;
  if (pendingProposal) {
    logEvent({ taskId, actorId, kind: "plan_completion_deferred", field: planId, toValue: pendingProposal.id });
    return false;
  }

  const summary = [
    "План совместной работы сдан.",
    ...nodes.map((n) => {
      const result = (n.result ?? "").replace(/\s+/g, " ").trim();
      const clipped = result.length > 400 ? `${result.slice(0, 399)}…` : result;
      return `— ${n.title}${clipped ? `: ${clipped}` : ""}`;
    }),
  ].join("\n");

  db.transaction(() => {
    const before = currentResultVersion(taskId);
    const version = ensureResultVersionForReview(taskId, actorId ?? task.assignee_id ?? task.creator_id ?? "", summary);
    if (task.current_attempt_id) {
      db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'review', reason = 'план сдан' WHERE id = ? AND ended_at IS NULL")
        .run(task.current_attempt_id);
    }
    db.prepare("UPDATE tasks SET agent_state = 'review', current_attempt_id = NULL, updated_at = datetime('now') WHERE id = ?").run(taskId);
    bumpContextVersion(taskId);
    if (!before) {
      logEvent({ taskId, actorId, kind: "result_version_created", field: "result_version", toValue: String(version.version_no) });
    }
    logEvent({ taskId, actorId: null, kind: "collaboration_plan_completed", field: planId, toValue: String(nodes.length) });
    logEvent({ taskId, actorId: null, kind: "state_changed", field: "agent_state", fromValue: task.agent_state, toValue: "review" });
    const reviewEnabled = (db.prepare("SELECT requires_reviewer_review FROM tasks WHERE id=?").get(taskId) as {requires_reviewer_review:number}).requires_reviewer_review;
    const ownerReviewDefault = (db.prepare("SELECT reviewer_first_default FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {reviewer_first_default:number}|undefined)?.reviewer_first_default ?? 1;
    const member=branchMembership(taskId);
    if(member && member.root_task_id!==taskId && (!reviewEnabled || ownerReviewDefault!==1)){
      db.prepare("UPDATE tasks SET status='completed',agent_state=NULL,completed_at=datetime('now') WHERE id=?").run(taskId);
    }
    // Поломки «Состояния системы» проверяет Критик всегда (владелец 14.10.2026):
    // владелец такие карточки принимать не хочет, после одобрения они
    // закрываются сами (routes/reviews.ts).
    const incident = Boolean((db.prepare("SELECT incident_key FROM tasks WHERE id=?").get(taskId) as {incident_key:string|null}|undefined)?.incident_key);
    if ((reviewEnabled && ownerReviewDefault === 1) || incident) {
      const reviewer = ensurePlanFinalReviewer(planId,taskId);
      queuePlanFinalReview(reviewer.id,actorId ?? task.assignee_id ?? task.creator_id ?? "");
    }
  })();

  if (task.creator_id && task.creator_id !== actorId) {
    const notifId = crypto.randomUUID();
    db.prepare("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'agent_state', ?, ?, ?)")
      .run(notifId, task.creator_id, taskId, `Задача «${task.title}» на проверке`, actorId);
    broadcastToUsers([task.creator_id], { type: "notification:new", notificationId: notifId, taskId });
  }
  broadcastTaskEvent([task.creator_id, task.assignee_id], { type: "task:updated", task: getFullTask(taskId) });
  void import("../routes/dispatch.js")
    .then((m) => m.admitParentAfterChildren(taskId))
    .catch((err) => console.warn("родитель после плана:", err));
  return true;
}

/** При старте: планы, сданные целиком, но карточка так и не ушла на
 *  проверку (сданы до 01.10.2026 или сервер упал в момент сдачи). */
export function finishCompletedPlans(): number {
  const plans = db.prepare(
    `SELECT p.id, p.task_id FROM task_collaboration_plans p
       JOIN tasks t ON t.id = p.task_id
      WHERE p.status = 'approved' AND t.status = 'active' AND COALESCE(t.agent_state, '') <> 'review'`,
  ).all() as Array<{ id: string; task_id: string }>;
  let finished = recoverSubmittedIncidentReviews();
  for (const plan of plans) {
    if (finishPlanIfComplete(plan.id, plan.task_id, null)) finished += 1;
  }
  return finished;
}

/** Recheck approved waiting graphs after a predecessor card changes or server restarts. */
export async function unlockDependencyPlans():Promise<void> {
  const plans=db.prepare(`SELECT DISTINCT p.id,p.task_id,p.approved_by FROM task_collaboration_plans p
    JOIN tasks t ON t.id=p.task_id
    WHERE p.status='approved' AND t.status='active'
      -- ВРЕМЕННО ВЫКЛЮЧЕНО 07.10.2026 (авария: в 19:43 живая база оказалась стёрта, когда этим правилом были
      -- разбужены роли, работающие над кодом сервера; причина не установлена). Правило «цепочка уже идёт
      -- (есть закрытый шаг) — открываем пропущенный шаг сами» вернуть после разбора:
      --   OR EXISTS(SELECT 1 FROM subtasks d WHERE d.collaboration_plan_id=p.id AND d.done=1)
      AND (EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id) OR EXISTS(SELECT 1 FROM branch_plan_members b WHERE b.plan_id=p.id))
      AND EXISTS(SELECT 1 FROM subtasks s WHERE s.collaboration_plan_id=p.id AND s.done=0 AND s.agent_state IS NULL)`).all() as Array<{id:string;task_id:string;approved_by:string}>;
  for(const plan of plans){
    if(unmetDependencyIds(plan.task_id).length) continue;
    await unlockReadyPlanSubtasks(plan.id,plan.task_id,plan.approved_by);
  }
}

/**
 * Узел роли «critic_verifier» (revision ≥ 2, без `FINAL_REVIEW_MARKER`)
 * вынес вердикт — его собственный шаг плана надо закрыть, иначе
 * последующие шаги (`builder_fix_*`, `critic_recheck_*`) не откроются
 * (Г1-л, 06.10.2026: «critic_verifier_recheck_2 не появился, пока
 * предшественник не закрыт»).
 *
 * `completePlanFinalReview` уже закрывает финального проверяющего с
 * маркером — здесь обрабатываем остальные случаи: узел `critic_verifier`
 * ещё открыт, вердикт вынесен, граф знает, какие шаги перезапускать.
 *
 * `requestedTargets` — `rework_steps` из taskflow_review (могут быть
 * пустыми; тогда `completePlanFinalReviewAtomic` подберёт дефолт).
 * Возвращает `true`, если узел был закрыт этим вызовом.
 */
/**
 * Промежуточная проверка: открытый узел проверяющего, после которого в плане
 * ещё есть шаги. Итоговая проверка сюда не относится — у неё свой маркер.
 * Возвращает id плана и шага либо null.
 */
export function openMidPlanCritic(taskId: string): { planId: string; subtaskId: string } | null {
  const row = db.prepare(
    `SELECT s.id AS subtaskId, s.collaboration_plan_id AS planId
       FROM subtasks s
       JOIN task_collaboration_plans p ON p.id = s.collaboration_plan_id AND p.status = 'approved'
       JOIN task_collaboration_plan_nodes n ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
      WHERE s.task_id = ? AND s.done = 0 AND n.role_key = 'critic_verifier'
        AND (n.instructions IS NULL OR n.instructions NOT LIKE ?)
        AND EXISTS (SELECT 1 FROM task_collaboration_plan_edges e WHERE e.plan_id = n.plan_id AND e.from_slot_key = n.slot_key)
      ORDER BY s.position DESC LIMIT 1`,
  ).get(taskId, "%taskflow:final-review%") as { planId: string; subtaskId: string } | undefined;
  return row ?? null;
}

export function closeOpenCriticPlanNode(
  taskId: string,
  verdict: "approved" | "changes_requested" | "blocked",
  findings: string,
  requestedTargets: string[] | null,
): boolean {
  const plan = db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  if (!plan) return false;
  const row = db.prepare(
    `SELECT s.id, s.title, s.done, s.agent_state, s.position, s.plan_node_key
       FROM subtasks s
       JOIN task_collaboration_plan_nodes n
         ON n.plan_id = s.collaboration_plan_id AND n.slot_key = s.plan_node_key
      WHERE s.task_id = ?
        AND s.collaboration_plan_id = ?
        AND n.role_key = 'critic_verifier'
        AND (n.instructions IS NULL OR n.instructions NOT LIKE ?)
        AND s.done = 0
      ORDER BY s.position DESC
      LIMIT 1`,
  ).get(taskId, plan.id, "%taskflow:final-review%") as
    | { id: string; title: string; done: number; agent_state: string | null; position: number; plan_node_key?: string | null }
    | undefined;
  if (!row) return false;
  // Если узел уже не в работе (todo/blocked) — всё равно закрываем:
  // вердикт вынесен, шаг плана должен быть закрыт, иначе доработка не
  // откроется.
  const sub = db.prepare("SELECT current_attempt_id FROM subtasks WHERE id = ?").get(row.id) as
    | { current_attempt_id: string | null }
    | undefined;
  if (sub?.current_attempt_id) {
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'review', reason = ? WHERE id = ? AND ended_at IS NULL")
      .run(`вердикт: ${verdict}`, sub.current_attempt_id);
  }
  db.prepare(
    "UPDATE subtasks SET done = 1, agent_state = NULL, current_attempt_id = NULL, agent_heartbeat_at = NULL, result = ? WHERE id = ?",
  ).run(`${verdict}: ${findings}`, row.id);
  // Вердикт закрыл узел плана — это та же сдача шага, что и сдача ролью:
  // одна строка прогресса в теме задачи (карточка 7efcc173).
  announceStepState(row.id,"submitted");
  logEvent({
    taskId,
    actorId: null,
    kind: "plan_subtask_closed_by_verdict",
    field: row.title,
    toValue: verdict,
  });
  // Для changes_requested открываем шаги доработки от самого critic-узла
  // (а не через `completePlanFinalReview`, который строит rework от
  // финального reviewer'а: если critic уже в плане, финальный reviewer
  // привязывается только к нему, и предшествующие рабочие узлы не
  // попадают в `currentSegment` → `planReworkGraph` кидает ошибку).
  if (verdict === "changes_requested") {
    // Карточка 8aa95906 (admission): новый цикл доработки. Прежний
    // admission_fingerprint, если он остался на узлах этого плана, уже не
    // отражает актуальный gate — вердикт изменил ожидания. Сбрасываем
    // fingerprint и инкрементируем admission_cycle у узлов, которые ещё
    // не закрыты и ждут повторной попытки. Уже сданные (`done=1`) узлы
    // не трогаем — им не нужно нольле работы, и их предыдущие attempt'ы
    // остаются привязанными к своим циклам. Rework-узлы (только что
    // созданные) получат fingerprint естественным путём при первом
    // startPlanSubtaskRun.
    db.prepare(`UPDATE subtasks SET admission_cycle = COALESCE(admission_cycle, 0) + 1, admission_fingerprint = NULL WHERE collaboration_plan_id = ? AND done = 0`).run(plan.id);
    try {
      openReworkFromCritic(taskId, plan.id, row, findings, requestedTargets ?? []);
    } catch (error) {
      // Узел закрыт, дальше — задача оркестратора/владельца. Ошибку
      // логируем, но не возвращаем как неуспех: главное сделано.
      logEvent({
        taskId,
        actorId: null,
        kind: "plan_rework_after_verdict_failed",
        field: row.title,
        toValue: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return true;
}

/** Открыть rework-узлы от critic-узла, по аналогии с `completePlanFinalReview`,
 *  но без финального reviewer'а (его у нас ещё нет, и в этой ветке он
 *  не нужен — владелец/другая роль примут rework по факту). */
function openReworkFromCritic(
  taskId: string,
  planId: string,
  critic: { id: string; title: string; plan_node_key?: string | null },
  findings: string,
  requestedTargets: string[],
): void {
  const allNodes = db.prepare("SELECT * FROM task_collaboration_plan_nodes WHERE plan_id = ?")
    .all(planId) as Array<{
      slot_key: string;
      role_key: string;
      expected_result: string;
      output_artifact_json: string | null;
      instructions: string | null;
      iteration: number;
      skipped_at: string | null;
      rework_of_key: string | null;
    }>;
  const allEdges = db.prepare("SELECT * FROM task_collaboration_plan_edges WHERE plan_id = ?")
    .all(planId) as Array<{ from_slot_key: string; to_slot_key: string; start_condition: string; artifact_key: string | null }>;
  const bySlot = new Map(allNodes.map((n) => [n.slot_key, n]));
  // Сегмент предшественников critic-узла: всё, что через рёбра ведёт в critic.
  const segment = new Set<string>();
  const backwards = (slot: string): void => {
    for (const edge of allEdges.filter((e) => e.to_slot_key === slot)) {
      const pred = bySlot.get(edge.from_slot_key);
      if (!pred || pred.role_key === "critic_verifier" || segment.has(pred.slot_key)) continue;
      segment.add(pred.slot_key);
      backwards(pred.slot_key);
    }
  };
  backwards(critic.plan_node_key ?? "");
  const candidates = allNodes.filter((n) => !n.skipped_at && n.role_key !== "critic_verifier");
  const ownerFallback = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  const actor = ownerFallback?.id ?? "system";
  const target = requestedTargets.length > 0
    ? requestedTargets
    : [candidates.filter((n) => segment.has(n.slot_key)).at(-1)?.slot_key ?? candidates.at(-1)?.slot_key ?? ""];
  if (target.some((slot) => !segment.has(slot) && bySlot.has(slot))) {
    throw new Error("Выберите этап текущего цикла, а не исторический результат");
  }
  if (target.some((t) => !bySlot.has(t))) {
    throw new Error("Укажите существующие рабочие этапы для доработки");
  }
  // Находим iteration от critic — равен max(iteration) в плане.
  const iteration = Math.max(0, ...allNodes.map((n) => n.iteration ?? 0));
  const clone = new Map<string, string>();
  // Соберём всех потомков target в сегменте.
  const affected = new Set<string>();
  const visit = (slot: string): void => {
    if (affected.has(slot)) return;
    affected.add(slot);
    for (const e of allEdges.filter((edge) => edge.from_slot_key === slot)) {
      if (bySlot.get(e.to_slot_key)?.role_key !== "critic_verifier") visit(e.to_slot_key);
    }
  };
  for (const t of target) visit(t);
  for (const t of target) {
    const newSlot = `${bySlot.get(t)?.role_key ?? "fix"}_fix_${crypto.randomUUID().slice(0, 8)}`;
    clone.set(t, newSlot);
    const node = bySlot.get(t)!;
    addPlanReworkNode(planId, taskId, { ...node, expected_result: `Доработка ${iteration + 1}: ${node.expected_result}`, instructions: `${node.instructions ?? ""}\n\nЗамечания к доработке: ${findings}\n\nПолучите обновлённые результаты предшествующих этапов и выполните свой этап повторно.` }, newSlot, actor, findings.slice(0, 500), iteration + 1, t);
  }
  for (const t of target) {
    addPlanReworkEdge(planId, critic.plan_node_key ?? "", clone.get(t)!);
  }
  // Связи между пересозданными узлами.
  for (const edge of allEdges) {
    if (clone.has(edge.to_slot_key) && clone.has(edge.from_slot_key)) {
      addPlanReworkEdge(planId, clone.get(edge.from_slot_key)!, clone.get(edge.to_slot_key)!, edge.start_condition, edge.artifact_key);
    }
  }
  // Recheck-узел — сам critic (новая итерация).
  const recheck = `critic_recheck_${crypto.randomUUID().slice(0, 8)}`;
  const reviewerTemplate = bySlot.get(critic.plan_node_key ?? "");
  if (reviewerTemplate) {
    addPlanReworkNode(planId, taskId, { ...reviewerTemplate, expected_result: `Повторная проверка ${iteration + 1}`, instructions: reviewerTemplate.instructions, rework_of_key: reviewerTemplate.slot_key }, recheck, actor, findings.slice(0, 500), iteration + 1, reviewerTemplate.slot_key);
    for (const t of target) {
      addPlanReworkEdge(planId, clone.get(t)!, recheck);
    }
  }
  db.prepare("UPDATE tasks SET agent_state='in_progress', updated_at=datetime('now') WHERE id=?").run(taskId);
  logEvent({ taskId, actorId: actor, kind: "plan_rework_created", field: planId, toValue: `${critic.plan_node_key} → ${target.join(", ")} → ${recheck}` });
}

function addPlanReworkNode(
  planId: string,
  taskId: string,
  node: { slot_key: string; role_key: string; expected_result: string; output_artifact_json: string | null; instructions: string | null; rework_of_key?: string | null },
  slot: string,
  actor: string,
  reason: string,
  iteration: number,
  source: string | null,
): void {
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes(id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json, instructions, origin, added_by, added_reason, iteration, rework_of_key)
     VALUES(?, ?, ?, ?, 1, ?, ?, ?, 'rework', ?, ?, ?, ?)`,
  ).run(`tcpn_${crypto.randomUUID()}`, planId, slot, node.role_key, node.expected_result, node.output_artifact_json, node.instructions, actor, reason, iteration, node.rework_of_key ?? source);
  const position = (db.prepare("SELECT COALESCE(MAX(position),0)+1 AS n FROM subtasks WHERE task_id=?").get(taskId) as { n: number }).n;
  db.prepare("INSERT INTO subtasks(id, task_id, title, position, collaboration_plan_id, plan_node_key) VALUES(?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), taskId, node.expected_result, position, planId, slot);
}

function addPlanReworkEdge(
  planId: string,
  from: string,
  to: string,
  condition: string = "submitted",
  artifact: string | null = null,
): void {
  db.prepare(
    "INSERT INTO task_collaboration_plan_edges(id, plan_id, from_slot_key, to_slot_key, start_condition, artifact_key) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(`tcpe_${crypto.randomUUID()}`, planId, from, to, condition, artifact);
}
