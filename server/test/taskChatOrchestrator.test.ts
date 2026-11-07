// Ограничение чата задачи не касается оркестратора (владелец 06.11.2026).
import { expect, it } from "vitest";
import { operationRestriction } from "../src/runtime/universalTaskflow.js";
import { conversationMode } from "../src/runtime/slotConversation.js";
import { isTaskChatRestrictedRole } from "../src/runtime/taskChatTools.js";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";

const ctx = (role: string): any => ({ actor: "x", role, mode: conversationMode(role), runId: "r", chatId: "c1", taskId: "t1", messageId: "m1", executionMode: "card", authorize: (n: string) => roleToolAllowed(role, n) });

it("оркестратор в чате карточки: слот-рестарт и рабочие операции доступны", () => {
  expect(isTaskChatRestrictedRole("code_orchestrator")).toBe(false);
  expect(conversationMode("code_orchestrator")).not.toBe("task_chat");
  for (const op of ["taskflow_slot_restart", "taskflow_claim", "taskflow_state", "taskflow_heartbeat", "taskflow_plan_ops", "taskflow_call_role"])
    expect(operationRestriction(op, ctx("code_orchestrator")), op).toBeUndefined();
});
it("другие роли — как раньше: чат задачи только чтение", () => {
  for (const role of ["builder", "qa", "analyst"]) {
    expect(isTaskChatRestrictedRole(role)).toBe(true);
    expect(conversationMode(role)).toBe("task_chat");
    expect(operationRestriction("taskflow_slot_restart", ctx(role))).toMatchObject({ code: "MODE_RESTRICTED" });
    expect(operationRestriction("taskflow_task", ctx(role))).toBeUndefined();
  }
});
