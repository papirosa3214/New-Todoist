import {
  branchMembership,
  branchReworkRequest,
  branchCards,
} from "./branchPlan.js";
import { ensurePlanTopic } from "../lib/projectTopics.js";
import { MAX_REWORK_ROUNDS, MAX_PLAN_NODES } from "./planMutations.js";
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleUserId } from "../roleRouting.js";
import {
  createResultVersion,
  currentResultVersion,
  resultFromSubtasks,
} from "../resultVersions.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
export const FINAL_REVIEW_MARKER = "[taskflow:final-review]";
type Node = {
  slot_key: string;
  role_key: string;
  expected_result: string;
  output_artifact_json: string | null;
  instructions: string | null;
  iteration: number;
  skipped_at: string | null;
};
type Edge = {
  from_slot_key: string;
  to_slot_key: string;
  start_condition: string;
  artifact_key: string | null;
};
type ReviewStep = {
  id: string;
  task_id: string;
  collaboration_plan_id: string;
  plan_node_key: string;
  done: number;
};
function nodes(planId: string): Node[] {
  return db
    .prepare("SELECT * FROM task_collaboration_plan_nodes WHERE plan_id=?")
    .all(planId) as Node[];
}
function edges(planId: string): Edge[] {
  return db
    .prepare("SELECT * FROM task_collaboration_plan_edges WHERE plan_id=?")
    .all(planId) as Edge[];
}
function addEdge(
  planId: string,
  from: string,
  to: string,
  condition = "submitted",
  artifact: string | null = null,
) {
  db.prepare(
    "INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition,artifact_key) VALUES(?,?,?,?,?,?)",
  ).run(`tcpe_${crypto.randomUUID()}`, planId, from, to, condition, artifact);
}
function addNode(
  planId: string,
  taskId: string,
  node: Node,
  slot: string,
  origin: string,
  actor: string,
  reason: string,
  iteration: number,
  source: string | null,
) {
  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,output_artifact_json,instructions,origin,added_by,added_reason,iteration,rework_of_key)
    VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?)`,
  ).run(
    `tcpn_${crypto.randomUUID()}`,
    planId,
    slot,
    node.role_key,
    node.expected_result,
    node.output_artifact_json,
    node.instructions,
    origin,
    actor,
    reason,
    iteration,
    source,
  );
  const position = (
    db
      .prepare(
        "SELECT COALESCE(MAX(position),0)+1 AS n FROM subtasks WHERE task_id=?",
      )
      .get(taskId) as {
      n: number;
    }
  ).n;
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key) VALUES(?,?,?,?,?,?)",
  ).run(id, taskId, node.expected_result, position, planId, slot);
  return id;
}
function bump(
  planId: string,
  taskId: string,
  actor: string,
  kind: string,
  summary: string,
) {
  db.prepare(
    "UPDATE task_collaboration_plans SET version=version+1 WHERE id=?",
  ).run(planId);
  logEvent({ taskId, actorId: actor, kind, field: planId, toValue: summary });
}
/** Attach the task's actual final verifier; this node is driven by review jobs, not a second model run. */
export function ensurePlanFinalReviewer(
  planId: string,
  taskId: string,
): ReviewStep {
  const existing = db
    .prepare(
      `SELECT s.* FROM subtasks s JOIN task_collaboration_plan_nodes n
    ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.collaboration_plan_id=? AND n.instructions LIKE ? AND s.done=0 ORDER BY s.position DESC LIMIT 1`,
    )
    .get(planId, `${FINAL_REVIEW_MARKER}%`) as ReviewStep | undefined;
  if (existing) return existing;
  const before = nodes(planId).filter((n) => !n.skipped_at);
  const graph = edges(planId);
  const slot = `final_review_${crypto.randomUUID().slice(0, 8)}`;
  const actor = roleUserId("critic_verifier");
  const cycle = Math.max(0, ...before.map((n) => n.iteration ?? 0));
  const id = addNode(
    planId,
    taskId,
    {
      slot_key: slot,
      role_key: "critic_verifier",
      expected_result: "Итоговая проверка результата",
      output_artifact_json: null,
      instructions: FINAL_REVIEW_MARKER,
      iteration: 0,
      skipped_at: null,
    },
    slot,
    "role",
    actor,
    "Итоговый проверяющий присоединился к плану",
    cycle,
    null,
  );
  for (const n of before.filter(
    (n) => !graph.some((e) => e.from_slot_key === n.slot_key),
  ))
    addEdge(planId, n.slot_key, slot);
  bump(planId, taskId, actor, "plan_reviewer_joined", slot);
  ensurePlanTopic(taskId);
  return {
    id,
    task_id: taskId,
    collaboration_plan_id: planId,
    plan_node_key: slot,
    done: 0,
  };
}
/**
 * Архитектор собирает итог ветки и подключается сам, как итоговый проверяющий (владелец
 * 07.10.2026): в плане родителя его можно не ставить. Когда шаги корневого плана закрыты, а
 * конечный исполнитель в нём не Архитектор, шаг сборки добавляется здесь и ждёт дочерних по
 * общим правилам. true — шаг добавлен, план ещё не сдан.
 */
export function ensureBranchAssembler(planId: string, taskId: string): boolean {
  const member = branchMembership(taskId);
  if (
    !member ||
    member.root_task_id !== taskId ||
    member.root_plan_id !== planId ||
    branchCards(taskId).length < 2
  )
    return false;
  const work = nodes(planId).filter(
    (n) => !n.skipped_at && n.role_key !== "critic_verifier",
  );
  const graph = edges(planId);
  const terminals = work.filter(
    (n) =>
      !graph.some(
        (e) =>
          e.from_slot_key === n.slot_key &&
          work.some((x) => x.slot_key === e.to_slot_key),
      ),
  );
  if (terminals.length === 1 && terminals[0].role_key === "architect")
    return false;
  return db.transaction(() => {
    const slot = `assembly_${crypto.randomUUID().slice(0, 8)}`;
    const actor = roleUserId("architect");
    const title = (
      db.prepare("SELECT title FROM tasks WHERE id=?").get(taskId) as {
        title: string;
      }
    ).title;
    const cycle = Math.max(0, ...work.map((n) => n.iteration ?? 0));
    const id = addNode(
      planId,
      taskId,
      {
        slot_key: slot,
        role_key: "architect",
        expected_result: `Собрать и проверить совместимость дочерних результатов: ${title}`,
        output_artifact_json: null,
        instructions: null,
        iteration: 0,
        skipped_at: null,
      },
      slot,
      "role",
      actor,
      "Архитектор присоединился к плану, чтобы собрать итог ветки",
      cycle,
      null,
    );
    db.prepare("UPDATE subtasks SET agent_id=? WHERE id=?").run(actor, id);
    for (const n of terminals) addEdge(planId, n.slot_key, slot);
    bump(planId, taskId, actor, "plan_assembler_joined", slot);
    ensurePlanTopic(taskId);
    return true;
  })();
}
export function isPlanFinalReviewStep(subtaskId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
 WHERE s.id=? AND n.instructions LIKE ?`,
      )
      .get(subtaskId, `${FINAL_REVIEW_MARKER}%`),
  );
}
export function queuePlanFinalReview(subtaskId: string, actorId: string) {
  const step = db
    .prepare("SELECT * FROM subtasks WHERE id=?")
    .get(subtaskId) as ReviewStep;
  return db.transaction(() => {
    const current = currentResultVersion(step.task_id);
    const reviewed =
      current &&
      db.prepare("SELECT 1 FROM reviews WHERE version_id=?").get(current.id);
    const version =
      !current || reviewed
        ? createResultVersion({
            taskId: step.task_id,
            createdBy: actorId,
            result:
              (
                db
                  .prepare(
                    "SELECT title,result FROM subtasks WHERE collaboration_plan_id=? AND done=1 AND result IS NOT NULL ORDER BY position",
                  )
                  .all(step.collaboration_plan_id) as Array<{
                  title: string;
                  result: string;
                }>
              )
                .map((n) => `${n.title}: ${n.result}`)
                .join("\n") || resultFromSubtasks(step.task_id),
          })
        : current;
    db.prepare(
      "UPDATE subtasks SET agent_state='todo',agent_id=? WHERE id=? AND done=0",
    ).run(roleUserId("critic_verifier"), step.id);
    db.prepare(
      "UPDATE tasks SET agent_state='review',current_attempt_id=NULL,updated_at=datetime('now') WHERE id=?",
    ).run(step.task_id);
    // Ключ защищает от дубля, пока задание ждёт или идёт. Если прежнее
    // задание по этой версии уже отработало без вердикта (20.10.2026,
    // карточка 1e8c05e2), повторный запуск получает новый ключ — иначе
    // приёмку по той же версии не поставить никак.
    const baseKey = `plan-review:${step.collaboration_plan_id}:${step.plan_node_key}:${version.id}`;
    const finished = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM role_run_jobs WHERE (dedupe_key=? OR dedupe_key LIKE ?) AND status NOT IN ('queued','retry_wait','running')`,
        )
        .get(baseKey, `${baseKey}:r%`) as { n: number }
    ).n;
    const pending = db
      .prepare(
        `SELECT 1 FROM role_run_jobs WHERE (dedupe_key=? OR dedupe_key LIKE ?) AND status IN ('queued','retry_wait','running')`,
      )
      .get(baseKey, `${baseKey}:r%`);
    const dedupeKey =
      finished > 0 && !pending ? `${baseKey}:r${finished}` : baseKey;
    const job = enqueueRoleRunJob({
      taskId: step.task_id,
      reason: "review",
      actorId,
      dedupeKey,
    });
    return { ok: true as const, runId: job.id };
  })();
}
export function markPlanFinalReviewerStarted(taskId: string): void {
  db.prepare(
    `UPDATE subtasks SET agent_state='in_progress',agent_id=?,agent_heartbeat_at=datetime('now')
 WHERE task_id=? AND done=0 AND agent_state='todo' AND EXISTS(SELECT 1 FROM task_collaboration_plan_nodes n WHERE n.plan_id=subtasks.collaboration_plan_id AND n.slot_key=subtasks.plan_node_key AND n.instructions LIKE ?)`,
  ).run(roleUserId("critic_verifier"), taskId, `${FINAL_REVIEW_MARKER}%`);
}
/** Validate that requested starting points are an antichain, then replay their downstream work. */
export function planReworkGraph(
  planId: string,
  reviewSlot: string,
  targets: string[],
) {
  const all = nodes(planId).filter((n) => !n.skipped_at);
  const graph = edges(planId);
  const bySlot = new Map(all.map((n) => [n.slot_key, n]));
  const reaches = (start: string, stop?: string) => {
    const seen = new Set<string>();
    const visit = (s: string) => {
      if (seen.has(s) || s === reviewSlot) return;
      seen.add(s);
      for (const e of graph.filter((e) => e.from_slot_key === s))
        visit(e.to_slot_key);
    };
    visit(start);
    return stop ? seen.has(stop) : seen;
  };
  const currentSegment = new Set<string>();
  const backwards = (slot: string) => {
    for (const edge of graph.filter((e) => e.to_slot_key === slot)) {
      const predecessor = bySlot.get(edge.from_slot_key);
      if (
        !predecessor ||
        predecessor.role_key === "critic_verifier" ||
        currentSegment.has(predecessor.slot_key)
      )
        continue;
      currentSegment.add(predecessor.slot_key);
      backwards(predecessor.slot_key);
    }
  };
  backwards(reviewSlot);
  if (targets.some((slot) => !currentSegment.has(slot))) {
    const allowed =
      [...currentSegment]
        .map((s) => `${s} (${bySlot.get(s)?.role_key})`)
        .join(", ") || "нет";
    throw new Error(
      `Выберите этап текущего цикла, а не исторический результат. Допустимые rework_steps текущего цикла: ${allowed}. Укажи ключ первого дефектного этапа из этого списка; несколько — только для независимых параллельных веток.`,
    );
  }
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some(
      (t) =>
        !bySlot.has(t) ||
        t === reviewSlot ||
        bySlot.get(t)?.role_key === "critic_verifier",
    )
  )
    throw new Error("Укажите существующие рабочие этапы для доработки");
  for (const a of targets)
    for (const b of targets)
      if (a !== b && reaches(a, b))
        throw new Error(
          "Последовательные этапы нельзя возвращать параллельно: выберите первый этап цепочки",
        );
  const affected = new Set<string>();
  for (const t of targets)
    for (const s of reaches(t) as Set<string>) affected.add(s);
  const work = all.filter(
    (n) => affected.has(n.slot_key) && n.role_key !== "critic_verifier",
  );
  return {
    work,
    graph: graph.filter(
      (e) =>
        affected.has(e.to_slot_key) &&
        e.to_slot_key !== reviewSlot &&
        bySlot.get(e.from_slot_key)?.role_key !== "critic_verifier",
    ),
    targets,
  };
}
export function completePlanFinalReview(
  taskId: string,
  actor: string,
  verdict: string,
  findings: string,
  requestedTargets?: string[],
): { planId: string; managed: boolean } | null {
  return db.transaction(() =>
    completePlanFinalReviewAtomic(
      taskId,
      actor,
      verdict,
      findings,
      requestedTargets,
    ),
  )();
}
function completePlanFinalReviewAtomic(
  taskId: string,
  actor: string,
  verdict: string,
  findings: string,
  requestedTargets?: string[],
): { planId: string; managed: boolean } | null {
  const plan = db
    .prepare(
      "SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1",
    )
    .get(taskId) as
    | {
        id: string;
      }
    | undefined;
  if (!plan) return null;
  const branchRequest =
    verdict === "changes_requested" && requestedTargets
      ? branchReworkRequest(taskId, requestedTargets)
      : null;
  if (branchRequest) requestedTargets = branchRequest.rootTargets;
  const completedChild =
    verdict === "changes_requested" &&
    branchMembership(taskId)?.root_task_id !== taskId &&
    (
      db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as {
        status: string;
      }
    ).status === "completed";
  const lastReviewer = completedChild
    ? (db
        .prepare(
          `SELECT s.* FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.collaboration_plan_id=? AND n.instructions LIKE ? ORDER BY s.position DESC LIMIT 1`,
        )
        .get(plan.id, `${FINAL_REVIEW_MARKER}%`) as ReviewStep | undefined)
    : undefined;
  const step = lastReviewer ?? ensurePlanFinalReviewer(plan.id, taskId);
  const reviewer = nodes(plan.id).find(
    (n) => n.slot_key === step.plan_node_key,
  )!;
  const iteration = reviewer.iteration ?? 0;
  let route: ReturnType<typeof planReworkGraph> | null = null;
  if (verdict === "changes_requested") {
    const assignee = (
      db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(taskId) as {
        assignee_id: string | null;
      }
    ).assignee_id;
    const candidates = nodes(plan.id).filter(
      (n) => !n.skipped_at && n.role_key !== "critic_verifier",
    );
    const target = requestedTargets ?? [
      candidates.filter((n) => roleUserId(n.role_key) === assignee).at(-1)
        ?.slot_key ??
        candidates.at(-1)?.slot_key ??
        "",
    ];
    route = planReworkGraph(plan.id, step.plan_node_key, target);
  }
  return db.transaction(() => {
    db.prepare(
      "UPDATE subtasks SET done=1,agent_state=NULL,result=?,agent_heartbeat_at=NULL WHERE id=?",
    ).run(`${verdict}: ${findings}`, step.id);
    if (
      verdict === "changes_requested" &&
      route &&
      iteration < MAX_REWORK_ROUNDS &&
      nodes(plan.id).length + route.work.length + 1 <= MAX_PLAN_NODES
    ) {
      if (branchRequest)
        for (const card of branchRequest.cards) {
          const binding = db
            .prepare(
              "SELECT plan_id FROM branch_plan_members WHERE task_id=? AND root_plan_id=?",
            )
            .get(card.taskId, plan.id) as { plan_id: string };
          const existing = nodes(binding.plan_id);
          const childReviewer = db
            .prepare(
              `SELECT s.* FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.collaboration_plan_id=? AND n.instructions LIKE ? ORDER BY s.position DESC LIMIT 1`,
            )
            .get(binding.plan_id, `${FINAL_REVIEW_MARKER}%`) as
            ReviewStep | undefined;
          if (!childReviewer)
            throw new Error(
              "Дочерний результат ещё не прошёл итоговую проверку",
            );
          const childRoute = planReworkGraph(
            binding.plan_id,
            childReviewer.plan_node_key,
            card.slots,
          );
          if (
            Math.max(0, ...existing.map((n) => n.iteration ?? 0)) >=
              MAX_REWORK_ROUNDS ||
            nodes(binding.plan_id).length + childRoute.work.length + 1 >
              MAX_PLAN_NODES
          )
            throw new Error(
              "Дочерний этап достиг лимита доработок — требуется решение владельца",
            );
          completePlanFinalReview(
            card.taskId,
            actor,
            "changes_requested",
            findings,
            card.slots,
          );
          for (const child of nodes(binding.plan_id).filter(
            (n) =>
              card.slots.includes(
                (n as Node & { rework_of_key: string | null }).rework_of_key ??
                  "",
              ) &&
              n.iteration ===
                Math.max(0, ...existing.map((n) => n.iteration ?? 0)) + 1,
          )) {
            db.prepare(
              "INSERT INTO branch_rework_links(root_plan_id,from_slot,to_task_id,to_slot) VALUES(?,?,?,?)",
            ).run(plan.id, step.plan_node_key, card.taskId, child.slot_key);
          }
          db.prepare(
            "UPDATE tasks SET status='active',completed_at=NULL,current_revision=COALESCE(current_revision,1)+1 WHERE id=?",
          ).run(card.taskId);
        }
      const clone = new Map<string, string>();
      for (const node of route.work) {
        const slot = `${node.role_key}_fix_${crypto.randomUUID().slice(0, 8)}`;
        clone.set(node.slot_key, slot);
        addNode(
          plan.id,
          taskId,
          {
            ...node,
            expected_result: `Доработка ${iteration + 1}: ${node.expected_result}`,
            instructions: `${findings}\n\nПолучите обновлённые результаты предшествующих этапов и выполните свой этап повторно.`,
          },
          slot,
          "rework",
          actor,
          findings.slice(0, 500),
          iteration + 1,
          node.slot_key,
        );
      }
      for (const target of route.targets)
        addEdge(plan.id, step.plan_node_key, clone.get(target)!);
      for (const edge of route.graph)
        if (clone.has(edge.to_slot_key))
          addEdge(
            plan.id,
            clone.get(edge.from_slot_key) ?? edge.from_slot_key,
            clone.get(edge.to_slot_key)!,
            edge.start_condition,
            edge.artifact_key,
          );
      const recheck = `critic_recheck_${crypto.randomUUID().slice(0, 8)}`;
      addNode(
        plan.id,
        taskId,
        {
          ...reviewer,
          expected_result: `Повторная итоговая проверка ${iteration + 1}`,
          instructions: FINAL_REVIEW_MARKER,
        },
        recheck,
        "rework",
        actor,
        findings.slice(0, 500),
        iteration + 1,
        step.plan_node_key,
      );
      for (const node of route.work.filter(
        (n) =>
          !route!.graph.some(
            (e) => e.from_slot_key === n.slot_key && clone.has(e.to_slot_key),
          ),
      ))
        addEdge(plan.id, clone.get(node.slot_key)!, recheck);
      db.prepare(
        "UPDATE tasks SET agent_state='in_progress',updated_at=datetime('now') WHERE id=?",
      ).run(taskId);
      bump(
        plan.id,
        taskId,
        actor,
        "plan_rework_created",
        `${step.plan_node_key} → ${route.targets.join(", ")} → ${recheck}`,
      );
    } else if (verdict !== "approved") {
      db.prepare(
        "UPDATE tasks SET agent_state='blocked',blocked_reason=?,updated_at=datetime('now') WHERE id=?",
      ).run(
        verdict === "changes_requested"
          ? "Достигнут лимит доработок плана — требуется решение владельца"
          : findings,
        taskId,
      );
      bump(
        plan.id,
        taskId,
        actor,
        "plan_rework_requires_owner",
        findings.slice(0, 500),
      );
    }
    const member = branchMembership(taskId);
    if (verdict === "approved" && member && member.root_task_id !== taskId) {
      db.prepare(
        "UPDATE tasks SET status='completed',agent_state=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?",
      ).run(taskId);
      logEvent({
        taskId,
        actorId: actor,
        kind: "branch_card_accepted",
        field: member.root_plan_id,
        toValue: member.responsible_role,
      });
    }
    ensurePlanTopic(taskId);
    return { planId: plan.id, managed: true };
  })();
}
/**
 * Владелец вернул сданную работу (владелец 15.10.2026): «кто принял работу? критик.
 * Критик возвращает исполнителям с той формулировкой, с которой я вернул ему».
 * Раньше возврат искал исполнителя карточки, а у задач по плану его нет — запись
 * падала на `agent_inbox.to_user_id`. Теперь в план встаёт шаг критика с текстом
 * владельца и сразу идёт в очередь: критик назначает доработку этапам обычным
 * путём (completePlanFinalReview → «Доработка N» → «Повторная итоговая проверка»).
 * null — у задачи нет утверждённого плана.
 */
export function returnPlanToCritic(
  taskId: string,
  actor: string,
  comment: string,
): { stepId: string } | null {
  const plan = db
    .prepare(
      "SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1",
    )
    .get(taskId) as { id: string } | undefined;
  if (!plan) return null;
  const open = ensureOpenOwnerReturn(plan.id, taskId, actor, comment);
  queuePlanFinalReview(open, actor);
  return { stepId: open };
}
function ensureOpenOwnerReturn(
  planId: string,
  taskId: string,
  actor: string,
  comment: string,
): string {
  const pending = db
    .prepare(
      `SELECT s.id FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.collaboration_plan_id=? AND s.done=0 AND n.instructions LIKE ? LIMIT 1`,
    )
    .get(planId, `${FINAL_REVIEW_MARKER}%`) as { id: string } | undefined;
  if (pending) return pending.id;
  const all = nodes(planId);
  const cycle = Math.max(0, ...all.map((n) => n.iteration ?? 0));
  const round =
    all.filter((n) => n.slot_key.startsWith("owner_return_")).length + 1;
  const slot = `owner_return_${crypto.randomUUID().slice(0, 8)}`;
  const text = comment.trim() || "Владелец не принял результат.";
  const instructions = `${FINAL_REVIEW_MARKER}\n\nВладелец вернул результат на доработку — твой прошлый вердикт он не принял:\n«${text}»\n\nВерни работу этапам исполнителей (changes_requested) с этой формулировкой владельца и требованием довести результат до того, чтобы он работал так, как описано в задаче, и это можно было проверить живым сценарием владельца.`;
  const id = addNode(
    planId,
    taskId,
    {
      slot_key: slot,
      role_key: "critic_verifier",
      expected_result: `Возврат владельца ${round}: передать доработку исполнителям`,
      output_artifact_json: null,
      instructions,
      iteration: cycle,
      skipped_at: null,
    },
    slot,
    "rework",
    actor,
    text.slice(0, 500),
    cycle,
    null,
  );
  db.prepare("UPDATE subtasks SET agent_id=? WHERE id=?").run(
    roleUserId("critic_verifier"),
    id,
  );
  bump(planId, taskId, actor, "plan_owner_return", text.slice(0, 500));
  ensurePlanTopic(taskId);
  return id;
}
export function planReviewRouteContext(taskId: string): string {
  const plan = db
    .prepare(
      "SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1",
    )
    .get(taskId) as
    | {
        id: string;
      }
    | undefined;
  if (!plan) return "";
  const member = branchMembership(taskId);
  if (member?.root_task_id === taskId) {
    const entries = branchCards(taskId).flatMap((card) => {
      const binding = db
        .prepare(
          "SELECT plan_id FROM branch_plan_members WHERE root_plan_id=? AND task_id=?",
        )
        .get(member.root_plan_id, card.id) as { plan_id: string } | undefined;
      const work = binding
        ? nodes(binding.plan_id).filter(
            (n) => !n.skipped_at && n.role_key !== "critic_verifier",
          )
        : [];
      const cycle = Math.max(0, ...work.map((n) => n.iteration ?? 0));
      return binding
        ? work
            .filter((n) => (n.iteration ?? 0) === cycle)
            .map((n) => ({
              slot_key: `${card.id}:${n.slot_key}`,
              task: card.title,
              role: n.role_key,
              iteration: n.iteration,
              result: n.expected_result,
            }))
        : [];
    });
    return `Этапы всей ветки для адресного возврата: ${JSON.stringify(entries)}. Для последовательной цепочки возвращай первый неверный этап: зависимые карточки и сборка Архитектора будут повторены сервером. Параллельным независимым веткам можно вернуть работу одновременно.`;
  }
  return `Этапы для адресного возврата: ${JSON.stringify(
    nodes(plan.id)
      .filter((n) => !n.skipped_at)
      .map((n) => ({
        slot_key: n.slot_key,
        role: n.role_key,
        iteration: n.iteration,
        result: n.expected_result,
      })),
  )}\nЗависимости: ${JSON.stringify(edges(plan.id).map((e) => `${e.from_slot_key} → ${e.to_slot_key}`))}`;
}
export function hasPendingPlanFinalReview(taskId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key WHERE s.task_id=? AND s.done=0 AND n.instructions LIKE ?`,
      )
      .get(taskId, `${FINAL_REVIEW_MARKER}%`),
  );
}
export function markPlanFinalReviewerWaiting(taskId: string) {
  db.prepare(
    `UPDATE subtasks SET agent_state='todo',agent_heartbeat_at=NULL WHERE task_id=? AND done=0 AND EXISTS(SELECT 1 FROM task_collaboration_plan_nodes n WHERE n.plan_id=subtasks.collaboration_plan_id AND n.slot_key=subtasks.plan_node_key AND n.instructions LIKE ?)`,
  ).run(taskId, `${FINAL_REVIEW_MARKER}%`);
}

// Incidents submitted before mandatory final review was introduced can already
// be in review with no verifier node. Startup recovery must not treat review as
// proof that a review job exists. Never replay a verdict or unfinished work.
export function recoverSubmittedIncidentReviews(): number {
  return db.transaction(() => {
    const stranded = db
      .prepare(
        `
            SELECT p.id AS plan_id, t.id AS task_id, t.creator_id
            FROM tasks t JOIN task_collaboration_plans p ON p.task_id=t.id
            WHERE t.status='active' AND t.agent_state='review'
              AND t.incident_key IS NOT NULL AND t.archived_at IS NULL
              AND p.status='approved'
              AND p.revision=(SELECT MAX(p2.revision) FROM task_collaboration_plans p2
                              WHERE p2.task_id=t.id AND p2.status='approved')
              AND EXISTS(SELECT 1 FROM subtasks s WHERE s.collaboration_plan_id=p.id)
              AND NOT EXISTS(SELECT 1 FROM subtasks s WHERE s.collaboration_plan_id=p.id AND s.done=0)
              AND NOT EXISTS(SELECT 1 FROM task_collaboration_plan_nodes n
                             WHERE n.plan_id=p.id AND n.instructions LIKE ?)
              AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.task_id=t.id)
              AND NOT EXISTS(SELECT 1 FROM task_collaboration_plan_ops o WHERE o.plan_id=p.id AND o.status='proposed')
        `,
      )
      .all(FINAL_REVIEW_MARKER + "%") as Array<{
      plan_id: string;
      task_id: string;
      creator_id: string;
    }>;
    for (const row of stranded) {
      const reviewer = ensurePlanFinalReviewer(row.plan_id, row.task_id);
      queuePlanFinalReview(reviewer.id, row.creator_id);
      logEvent({
        taskId: row.task_id,
        actorId: null,
        kind: "incident_review_recovered",
        field: row.plan_id,
        toValue: reviewer.id,
      });
    }
    return stranded.length;
  })();
}
