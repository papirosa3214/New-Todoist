import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle, roleUserId } from "../roleRouting.js";
import { runRoleInProcess } from "./inProcessRun.js";
import { broadcastTaskEvent } from "../ws.js";
import { getFullTask } from "../routes/subtasks.js";

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
 * различает submitted/accepted — см. `canPlanSubtaskBecomeReady`.
 */

type PlanSubtask = {
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
};

type ArtifactVersion = {
  id: string;
  subtask_id: string;
  version_no: number;
  artifact_key: string;
  status: "submitted" | "accepted" | "revision_requested" | "rejected";
  evidence_json: string;
};

function subtask(subtaskId: string): PlanSubtask | undefined {
  return db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId) as PlanSubtask | undefined;
}

function latestArtifact(subtaskId: string): ArtifactVersion | undefined {
  return db.prepare("SELECT * FROM subtask_artifact_versions WHERE subtask_id = ? ORDER BY version_no DESC LIMIT 1").get(subtaskId) as ArtifactVersion | undefined;
}

function artifactHasEvidence(artifact: ArtifactVersion): boolean {
  try { return Array.isArray(JSON.parse(artifact.evidence_json)) && JSON.parse(artifact.evidence_json).length > 0; } catch { return false; }
}

const ARTIFACT_GATE_STATUSES: Record<string, Array<ArtifactVersion["status"]>> = {
  accepted: ["accepted"],
  artifact_ready: ["submitted", "accepted"],
  submitted: ["submitted", "accepted"],
};

/**
 * Может ли узел плана открыться (перестать ждать предшественников).
 * `row` — сама подзадача-узел (ещё не начатая: agent_state IS NULL, done=0).
 */
export function canPlanSubtaskBecomeReady(row: PlanSubtask): boolean {
  if (!row.collaboration_plan_id || !row.plan_node_key) return true;
  const edges = db.prepare("SELECT from_slot_key, start_condition, artifact_key FROM task_collaboration_plan_edges WHERE plan_id = ? AND to_slot_key = ?")
    .all(row.collaboration_plan_id, row.plan_node_key) as Array<{ from_slot_key: string; start_condition: string; artifact_key: string | null }>;
  return edges.every((edge) => {
    const predecessor = db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id = ? AND plan_node_key = ?")
      .get(row.collaboration_plan_id, edge.from_slot_key) as PlanSubtask | undefined;
    if (!predecessor) return false;
    if (edge.artifact_key) {
      const artifact = latestArtifact(predecessor.id);
      if (!artifact || artifact.artifact_key !== edge.artifact_key) return false;
      if (edge.start_condition === "artifact_ready") return artifactHasEvidence(artifact) && (ARTIFACT_GATE_STATUSES.artifact_ready).includes(artifact.status);
      return (ARTIFACT_GATE_STATUSES[edge.start_condition] ?? ["accepted"]).includes(artifact.status);
    }
    // Без артефактного контракта — done=1 закрывает узел вне зависимости
    // от заявленного start_condition (submitted/accepted/artifact_ready
    // неразличимы на уровне subtasks, см. комментарий модуля).
    return predecessor.done === 1;
  });
}

/**
 * Реальный старт роли на узле плана: помечает подзадачу in_progress,
 * заводит ей attempt (тот же инвариант «одна активная попытка на
 * subtask_id», что и у обычного `POST /api/subtasks/:id/work`) и запускает
 * `runRoleInProcess`. Общее тело для автостарта корневых узлов из
 * `/approve` и для узлов, открывшихся по графу через
 * `unlockReadyPlanSubtasks`.
 */
export async function startPlanSubtaskRun(subtaskId: string, actorId: string): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const current = subtask(subtaskId);
  if (!current || !current.collaboration_plan_id || !current.plan_node_key) return { ok: false, error: "подзадача не узел плана" };
  if (current.done || current.agent_state) return { ok: false, error: "узел плана уже начат или закрыт" };
  const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(current.collaboration_plan_id, current.plan_node_key) as { role_key: string } | undefined;
  if (!node) return { ok: false, error: "узел плана не найден в DAG" };

  const attemptId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at, heartbeat_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(attemptId, current.task_id, current.id, roleUserId(node.role_key));
  db.prepare(
    `UPDATE subtasks SET agent_state = 'in_progress', agent_id = ?, current_attempt_id = ?, agent_heartbeat_at = datetime('now')
     WHERE id = ?`,
  ).run(roleUserId(node.role_key), attemptId, current.id);

  try {
    const run = await runRoleInProcess({ taskId: current.task_id, role: node.role_key, subtaskId: current.id, mode: "work" });
    logEvent({ taskId: current.task_id, actorId, kind: "plan_subtask_started", field: current.plan_node_key, toValue: roleTitle(node.role_key) });
    return { ok: true, runId: run.runId };
  } catch (error) {
    db.prepare("UPDATE subtasks SET agent_state = NULL, agent_id = NULL, current_attempt_id = NULL WHERE id = ?").run(current.id);
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'failed', reason = ? WHERE id = ?")
      .run(error instanceof Error ? error.message : String(error), attemptId);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Открывает по графу все узлы плана, чьи предшественники выполнены, и сразу
 * стартует роль в каждом — «роль сама впрягается в работу», без ручного
 * триггера. Неудача одного узла не должна ронять соседние независимые
 * ветки — try/catch на каждый отдельно.
 */
export async function unlockReadyPlanSubtasks(planId: string | null, taskId: string, actorId: string): Promise<void> {
  if (!planId) return;
  const waiting = db.prepare("SELECT * FROM subtasks WHERE collaboration_plan_id = ? AND done = 0 AND agent_state IS NULL").all(planId) as PlanSubtask[];
  for (const next of waiting) {
    if (!canPlanSubtaskBecomeReady(next)) continue;
    try {
      const started = await startPlanSubtaskRun(next.id, actorId);
      if (!started.ok) {
        logEvent({ taskId, actorId, kind: "plan_subtask_autostart_failed", field: next.plan_node_key ?? next.id, toValue: started.error });
      }
    } catch (error) {
      logEvent({ taskId, actorId, kind: "plan_subtask_autostart_failed", field: next.plan_node_key ?? next.id, toValue: error instanceof Error ? error.message : String(error) });
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

/**
 * Брошенные после перезапуска сервера узлы плана (владелец 01.10.2026, T05).
 *
 * Ход роли живёт только внутри процесса сервера, поэтому при старте любой
 * узел плана «в работе» — заведомо брошенный: его ход умер вместе с прошлым
 * процессом. Раньше такой узел оставался «в работе» навсегда, а следующие
 * роли его ждали — в ленте тишина. Теперь: попытка закрывается как
 * `interrupted`, роль пишет в ленту, что её ход оборвался, и продолжает
 * тот же разговор (сессия узла сохранена на диске). Второй обрыв за
 * полчаса — узел `blocked` и сообщение владельцу, без повторов по кругу.
 */
export async function recoverInterruptedPlanSubtasks(): Promise<{ resumed: number; blocked: number }> {
  const rows = db.prepare(
    "SELECT * FROM subtasks WHERE collaboration_plan_id IS NOT NULL AND done = 0 AND agent_state = 'in_progress'",
  ).all() as PlanSubtask[];
  let resumed = 0;
  let blocked = 0;
  for (const row of rows) {
    const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
      .get(row.collaboration_plan_id, row.plan_node_key) as { role_key: string } | undefined;
    if (row.current_attempt_id) {
      db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'interrupted', reason = 'перезапуск сервера' WHERE id = ? AND ended_at IS NULL")
        .run(row.current_attempt_id);
    }
    db.prepare("UPDATE subtasks SET agent_state = NULL, current_attempt_id = NULL WHERE id = ?").run(row.id);
    logEvent({ taskId: row.task_id, actorId: null, kind: "plan_subtask_interrupted", field: row.plan_node_key, toValue: node ? roleTitle(node.role_key) : null });
    if (!node) continue;

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
        `«${row.title}»: ход снова оборвался перезапуском сервера — второй раз за полчаса. Сам больше не продолжаю, нужен ваш взгляд.`,
      );
      continue;
    }
    roleNote(
      row.task_id,
      node.role_key,
      `«${row.title}»: мой ход оборвался — сервер перезапустился. Продолжаю с того же места.`,
    );
    const started = await startPlanSubtaskRun(row.id, roleUserId(node.role_key));
    if (started.ok) {
      resumed += 1;
    } else {
      logEvent({ taskId: row.task_id, actorId: null, kind: "plan_subtask_autostart_failed", field: row.plan_node_key, toValue: started.error });
    }
  }
  return { resumed, blocked };
}
