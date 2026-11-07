/**
 * Принятый результат идёт в main без роли-интегратора (владелец 05.11.2026).
 * Критик или оркестратор решили, что результат годен, дальше работает система:
 * очередь сливает, проверяет точечными тестами и двигает main. Не вышло — работа
 * возвращается тому, кто писал код, а после его правки снова проходит проверку.
 */
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { missionBlocksCompletion } from "../lib/missionContract.js";
import { liveRepo, refExists, roleBranch } from "../lib/worktree/paths.js";
import { currentResultVersion } from "../resultVersions.js";
import { ORCHESTRATE_ASSEMBLE_SLOT } from "./orchestratedPlan.js";
import { applyPlanOps } from "./planMutations.js";
import { enqueueMerge, requeueMerge } from "./worktreeMergeQueue.js";

/** Кто код не пишет: сбой слияния им не вернуть. */
const NOT_AUTHORS = ["critic_verifier", "qa", "code_orchestrator", "orchestrator", "secretary"];

export function enqueueAcceptedMerge(taskId: string): boolean {
  const task = db.prepare("SELECT id,archived_at,integration_mode FROM tasks WHERE id=?").get(taskId) as
    | { id: string; archived_at: string | null; integration_mode: string | null }
    | undefined;
  if (!task || task.archived_at || task.integration_mode === "not_required") return false;
  const plan = db.prepare("SELECT profile FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1").get(taskId) as
    | { profile: string }
    | undefined;
  if (plan?.profile === "result_review") return false;
  const mission = missionBlocksCompletion(taskId);
  if (mission.blocked) {
    logEvent({ taskId, actorId: null, kind: "merge_held_by_contract", field: "mission_contract", toValue: mission.outstanding.join(", ") });
    return false;
  }
  // Работы без своей ветки вливать нечего: анализ, отчёт, документ в карточке.
  if (!refExists(liveRepo(), `refs/heads/${roleBranch(taskId)}`)) return false;
  const queued = enqueueMerge(taskId, "integration_step") || requeueMerge(taskId);
  if (queued) logEvent({ taskId, actorId: null, kind: "accepted_merge_queued", field: roleBranch(taskId) });
  return queued;
}

/** Итоговое одобрение: только для версии, которая всё ещё актуальна. */
export function enqueueAcceptedReview(reviewId: string): boolean {
  const review = db.prepare("SELECT task_id,version_id,verdict FROM reviews WHERE id=?").get(reviewId) as
    | { task_id: string; version_id: string; verdict: string }
    | undefined;
  if (review?.verdict !== "approved") return false;
  if (currentResultVersion(review.task_id)?.id !== review.version_id) return false;
  return enqueueAcceptedMerge(review.task_id);
}

/** Сданный шаг, который сам означает «принято»: сборка оркестратора. */
export function enqueueAfterStepSubmitted(subtaskId: string): boolean {
  const step = db.prepare(`SELECT s.task_id,s.plan_node_key,p.profile FROM subtasks s
    LEFT JOIN task_collaboration_plans p ON p.id=s.collaboration_plan_id WHERE s.id=?`).get(subtaskId) as
    | { task_id: string; plan_node_key: string | null; profile: string | null }
    | undefined;
  if (!step) return false;
  const assembled = step.profile === "orchestrated" && step.plan_node_key === ORCHESTRATE_ASSEMBLE_SLOT;
  if (!assembled) return false;
  return enqueueAcceptedMerge(step.task_id);
}

/**
 * Слияние упало: автор получает шаг с причиной. Шаг открывает сданный план заново,
 * поэтому после правки результат снова проходит проверку и сам вернётся в очередь.
 */
export function returnFailedMerge(taskId: string, error: string): boolean {
  const fail = (reason: string): boolean => {
    logEvent({ taskId, actorId: null, kind: "merge_return_failed", field: roleBranch(taskId), toValue: reason.slice(0, 400) });
    return false;
  };
  const plan = db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1").get(taskId) as
    | { id: string }
    | undefined;
  if (!plan) return fail("у карточки нет утверждённого плана");
  const marks = NOT_AUTHORS.map(() => "?").join(",");
  const author = db.prepare(`SELECT s.plan_node_key AS slot,n.role_key AS role FROM subtasks s
    JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.collaboration_plan_id=? AND s.done=1 AND n.skipped_at IS NULL AND n.role_key NOT IN (${marks})
    ORDER BY CASE n.role_key WHEN 'builder' THEN 0 ELSE 1 END, s.position DESC LIMIT 1`).get(plan.id, ...NOT_AUTHORS) as
    | { slot: string; role: string }
    | undefined;
  if (!author) return fail("в плане нет роли, которая писала код");
  const owner = db.prepare("SELECT creator_id FROM tasks WHERE id=?").get(taskId) as { creator_id: string };
  try {
    applyPlanOps(plan.id, [{
      op: "add_step",
      role_key: author.role,
      expected_result: "Ветка карточки вливается в main: конфликт или упавшие тесты устранены",
      instructions: `Система не смогла влить ветку ${roleBranch(taskId)} в main.\n${error}\nОбнови ветку от main, устрани причину в этой же ветке, закоммить и сдай шаг. В main сам не вливай: после проверки это сделает система.`,
      after: [author.slot],
    }], { kind: "owner", id: owner.creator_id }, { reason: "Слияние в main не прошло", bypassBudget: true });
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
  logEvent({ taskId, actorId: null, kind: "merge_returned_to_author", field: author.role, toValue: error.slice(0, 400) });
  void import("./planSubtaskAdmission.js")
    .then(({ unlockReadyPlanSubtasks }) => unlockReadyPlanSubtasks(plan.id, taskId, owner.creator_id))
    .catch((cause) => console.warn("[accepted-merge] запуск шага отложен", cause));
  return true;
}
