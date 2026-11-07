// Чистая логика resolver V2 (документ a8bfa7ea-…): для каждого из
// 20 CauseCode собираем минимальный SubtaskFacts и проверяем, что
// resolveFromFacts выдаёт именно его. Это «unit на каждое правило»
// из плана реализации V2.
//
// Тесты не трогают БД: collectFacts живёт в отдельном модуле
// (`coordinationResolver.read.ts`), и его e2e-проверка — в
// `api.test.ts` этой же папки.

import { describe, it, expect } from "vitest";
import {
  buildResolution,
  CAUSE_CODES,
  CAUSE_TO_ACTION,
  coversEveryCause,
  evidenceRefLooksValid as _refUnused,
  resolveAssignee,
  resolveFromFacts,
  type CauseCode,
  type SubtaskFacts,
} from "../../src/runtime/coordinationResolver.js";
import { evidenceRefLooksValid } from "../../src/runtime/coordinationResolver.read.js";

function baseFacts(over: Partial<SubtaskFacts> = {}): SubtaskFacts {
  return {
    subtaskId: "sub_test",
    taskId: "task_test",
    taskStatus: "active",
    taskAgentState: null,
    taskAssigneeId: "user_owner",
    taskCreatorId: "user_owner",
    subtaskAgentState: null,
    subtaskDone: false,
    subtaskBlockType: null,
    subtaskPlanNodeKey: "slot_a",
    subtaskTitle: "Test slot",
    roleKey: "builder",
    waitingPredecessors: [],
    hasActiveAttempt: false,
    attemptHeartbeatAgeSeconds: null,
    sessionLastEventAgeSeconds: null,
    restartCount: 0,
    maxRestarts: 2,
    hasDurableQueuedJob: false,
    deadJobFailureCode: null,
    runningJobLeaseExpired: false,
    stepOutcomeStalled: false,
    isFinalReviewNode: false,
    branchReworkLinkExists: false,
    nowEpochSeconds: 1_700_000_000,
    ...over,
  };
}

describe("coordinationResolver.resolveFromFacts", () => {
  it("R1: completed card → completed_pending_review", () => {
    expect(resolveFromFacts(baseFacts({ taskStatus: "completed" })).cause).toBe(
      "completed_pending_review",
    );
    expect(resolveFromFacts(baseFacts({ taskStatus: "archived" })).cause).toBe(
      "completed_pending_review",
    );
  });

  it("R2: tasks.agent_state=review → review", () => {
    expect(resolveFromFacts(baseFacts({ taskAgentState: "review" })).cause).toBe("review");
  });

  it("R3.blocked_dependency: agent_state=blocked, block_type=dependency", () => {
    expect(
      resolveFromFacts(
        baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "dependency" }),
      ).cause,
    ).toBe("blocked_dependency");
  });

  it("R3.blocked_needs_input: needs_input → waiting_owner", () => {
    expect(
      resolveFromFacts(
        baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "needs_input" }),
      ).cause,
    ).toBe("waiting_owner");
  });

  it("R3.blocked_capability: capability → waiting_human", () => {
    expect(
      resolveFromFacts(
        baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "capability" }),
      ).cause,
    ).toBe("waiting_human");
  });

  it("R3.blocked_transient: transient → waiting_transient (V2 addition)", () => {
    expect(
      resolveFromFacts(
        baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "transient" }),
      ).cause,
    ).toBe("waiting_transient");
  });

  it("R3.blocked_unknown: неизвестный block_type → waiting_owner (мягко)", () => {
    expect(
      resolveFromFacts(
        // намеренно обходим тип, чтобы смоделировать «неизвестный код»
        baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "invalid" as any }),
      ).cause,
    ).toBe("waiting_owner");
  });

  it("R4.attempt_fresh_heartbeat: активная попытка + свежий heartbeat → active_run", () => {
    expect(
      resolveFromFacts(
        baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: 60 }),
      ).cause,
    ).toBe("active_run");
  });

  it("R4.attempt_heartbeat_old: heartbeat старый, рестартов < лимита → recovery_pending", () => {
    expect(
      resolveFromFacts(
        baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: 600, restartCount: 1 }),
      ).cause,
    ).toBe("recovery_pending");
  });

  it("R4.attempt_stalled_limit: heartbeat старый и рестартов ≥ лимита → stalled_manual_review", () => {
    expect(
      resolveFromFacts(
        baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: 1200, restartCount: 2 }),
      ).cause,
    ).toBe("stalled_manual_review");
  });

  it("R4b.session_silent: поток событий молчит, рестартов < лимита → recovery_pending", () => {
    expect(
      resolveFromFacts(
        baseFacts({ sessionLastEventAgeSeconds: 600, restartCount: 0 }),
      ).cause,
    ).toBe("recovery_pending");
  });

  it("R4b.session_silent_limit: поток молчит, рестартов ≥ лимита → stalled_manual_review", () => {
    expect(
      resolveFromFacts(
        baseFacts({ sessionLastEventAgeSeconds: 1200, restartCount: 2 }),
      ).cause,
    ).toBe("stalled_manual_review");
  });

  it("R5.waiting_predecessor: узел ждёт предшественника", () => {
    expect(
      resolveFromFacts(
        baseFacts({
          waitingPredecessors: [{ fromSlotKey: "slot_b", reason: "шаг ещё не закрыт", artifactKey: null }],
        }),
      ).cause,
    ).toBe("waiting_predecessor");
  });

  it("R5.ready_to_start: узел свободен", () => {
    expect(resolveFromFacts(baseFacts()).cause).toBe("ready_to_start");
  });

  it("R6.queued: job в очереди → durable_queued_wake", () => {
    expect(resolveFromFacts(baseFacts({ hasDurableQueuedJob: true })).cause).toBe(
      "durable_queued_wake",
    );
  });

  it("R6.dead_auth: dead job + provider_auth_or_access → permission_or_owner", () => {
    expect(
      resolveFromFacts(baseFacts({ deadJobFailureCode: "provider_auth_or_access" })).cause,
    ).toBe("permission_or_owner");
  });

  it("R6.dead_config: dead job + missing_config → missing_config", () => {
    expect(resolveFromFacts(baseFacts({ deadJobFailureCode: "missing_config" })).cause).toBe(
      "missing_config",
    );
  });

  it("R6.dead_provider: dead job + provider_quota_limit → provider_limit", () => {
    expect(
      resolveFromFacts(baseFacts({ deadJobFailureCode: "provider_quota_limit" })).cause,
    ).toBe("provider_limit");
  });

  it("R6.dead_context: dead job + context_overflow → context_overflow", () => {
    expect(
      resolveFromFacts(baseFacts({ deadJobFailureCode: "context_overflow" })).cause,
    ).toBe("context_overflow");
  });

  it("R6.dead_other: dead job + неизвестный код → missing_config (мягко)", () => {
    expect(
      resolveFromFacts(baseFacts({ deadJobFailureCode: "some_unknown_code" })).cause,
    ).toBe("missing_config");
  });

  it("R6.running_lease_expired: job running и lease истёк → recovery_pending", () => {
    expect(
      resolveFromFacts(baseFacts({ runningJobLeaseExpired: true })).cause,
    ).toBe("recovery_pending");
  });

  it("R7.step_outcome_stalled: stepOutcome.outcome=stalled → step_stalled", () => {
    expect(resolveFromFacts(baseFacts({ stepOutcomeStalled: true })).cause).toBe("step_stalled");
  });

  it("R5.final_review_node: финальный проверяющий в очереди → awaiting_final_review", () => {
    expect(
      resolveFromFacts(baseFacts({ isFinalReviewNode: true })).cause,
    ).toBe("awaiting_final_review");
  });

  it("R9.branch_rework_link: branch_rework_links есть → branch_rework", () => {
    expect(
      resolveFromFacts(baseFacts({ branchReworkLinkExists: true })).cause,
    ).toBe("branch_rework");
  });

  it("R10.fallback: ни одно правило не сработало → unknown", () => {
    // `taskStatus='active'`, `taskAgentState=NULL`, `subtaskAgentState=NULL`,
    // `subtaskDone=true` — после закрытия узла все ветви «todo» не
    // сработают, и резолвер не должен врать «готово к старту».
    expect(
      resolveFromFacts(
        baseFacts({
          subtaskDone: true,
          subtaskAgentState: "closed",
        }),
      ).cause,
    ).toBe("unknown");
  });
});

describe("coordinationResolver.buildResolution", () => {
  it("содержит contract_version='2.0.0'", () => {
    const r = buildResolution({ facts: baseFacts() });
    expect(r.contract_version).toBe("2.0.0");
    expect(r.cause).toBe("ready_to_start");
    expect(r.action).toBe("start");
    expect(r.notes?.length ?? 0).toBeLessThanOrEqual(500);
    expect(r.evidence.length).toBeLessThanOrEqual(7);
  });

  it("evidence обрезается до 7 записей", () => {
    const big = Array.from({ length: 12 }).map((_, i) => ({
      kind: "task_event" as const,
      ref: `task_events.row_${i}`,
    }));
    const r = buildResolution({ facts: baseFacts(), evidence: big });
    expect(r.evidence).toHaveLength(7);
  });

  it("assignee: active_run → роль узла", () => {
    const r = buildResolution({
      facts: baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: 60 }),
    });
    expect(r.assignee).toEqual({ kind: "role", key: "builder" });
  });

  it("assignee: waiting_owner → user.owner (tasks.assignee_id)", () => {
    const r = buildResolution({
      facts: baseFacts({ subtaskAgentState: "blocked", subtaskBlockType: "needs_input" }),
    });
    expect(r.assignee).toEqual({ kind: "person", key: "user_owner" });
  });

  it("assignee: assignee_id пуст, creator_id есть — пишем creator", () => {
    const r = buildResolution({
      facts: baseFacts({ taskAssigneeId: null, taskCreatorId: "user_creator" }),
    });
    expect(r.assignee).toEqual({ kind: "person", key: "user_creator" });
  });

  it("assignee: нет ни assignee, ни creator — пишем owner:unknown", () => {
    const r = buildResolution({
      facts: baseFacts({ taskAssigneeId: null, taskCreatorId: null }),
    });
    expect(r.assignee).toEqual({ kind: "person", key: "owner:unknown" });
  });

  it("metrics: heartbeat_age и age_seconds ≥ 0", () => {
    const r = buildResolution({
      facts: baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: -10 }),
    });
    expect(r.metrics.heartbeat_age).toBe(0);
    expect(r.metrics.age_seconds).toBe(0);
  });
});

describe("coordinationResolver целостность словаря", () => {
  it("coversEveryCause: каждое cause имеет ровно одно action", () => {
    expect(coversEveryCause()).toEqual({ ok: true });
  });

  it("20 причин V2: V1=17, V2=20 (waiting_transient, context_overflow, step_stalled)", () => {
    expect(CAUSE_CODES).toHaveLength(20);
    expect(CAUSE_CODES).toEqual(expect.arrayContaining([
      "waiting_transient",
      "context_overflow",
      "step_stalled",
    ] as CauseCode[]));
  });

  it("CAUSE_TO_ACTION: активные причины → no_action", () => {
    expect(CAUSE_TO_ACTION.active_run).toBe("no_action");
    expect(CAUSE_TO_ACTION.durable_queued_wake).toBe("no_action");
    expect(CAUSE_TO_ACTION.recovery_pending).toBe("no_action");
    expect(CAUSE_TO_ACTION.waiting_transient).toBe("no_action");
  });

  it("CAUSE_TO_ACTION: ожидание владельца → ask_owner", () => {
    expect(CAUSE_TO_ACTION.waiting_owner).toBe("ask_owner");
    expect(CAUSE_TO_ACTION.permission_or_owner).toBe("ask_owner");
  });

  it("CAUSE_TO_ACTION: зависший шаг → replace_attempt", () => {
    expect(CAUSE_TO_ACTION.stalled_manual_review).toBe("replace_attempt");
    expect(CAUSE_TO_ACTION.step_stalled).toBe("replace_attempt");
  });
});

describe("evidenceRefLooksValid (V2: формат «таблица.основание»)", () => {
  it.each([
    ["tasks.row_123", true],
    ["attempts.uuid", true],
    ["role_run_jobs.dedupe_key", true],
    ["task_events.1:abc", true],
    ["branch_rework_links.root_plan_id", true],
  ])("принимает %s", (ref, expected) => {
    expect(evidenceRefLooksValid(ref)).toBe(expected);
  });

  it.each([
    ["", false],
    ["tasks", false],
    [".tasks.row", false],
    ["tasks.", false],
    ["TASKS.row", false],
    ["tasks.row with space", false],
    ["tasks.row\nwith\nnewline", false],
    ["tasks.row;DROP TABLE tasks", false],
    ["a".repeat(201), false],
  ])("отвергает %s", (ref) => {
    expect(evidenceRefLooksValid(ref)).toBe(false);
  });
});

describe("resolveAssignee: вспомогательные случаи", () => {
  it("durable_queued_wake отдаёт роль", () => {
    const out = resolveAssignee(baseFacts({ hasDurableQueuedJob: true }), "durable_queued_wake");
    expect(out.assignee).toEqual({ kind: "role", key: "builder" });
  });
  it("recovery_pending отдаёт роль, даже если есть assignee", () => {
    const out = resolveAssignee(
      baseFacts({ hasActiveAttempt: true, attemptHeartbeatAgeSeconds: 600, restartCount: 1 }),
      "recovery_pending",
    );
    expect(out.assignee).toEqual({ kind: "role", key: "builder" });
  });
});
