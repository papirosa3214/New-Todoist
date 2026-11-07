import { expect, it } from "vitest";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";

// Разграничение ролей (владелец 05.11.2026): задачи ставит Оркестратор, архитектор выдаёт решение.
it("предлагать задачи могут все роли — набор один (владелец 07.11.2026)", () => {
  expect(roleToolAllowed("code_orchestrator", "taskflow_task_proposal")).toBe(true);
  expect(roleToolAllowed("architect", "taskflow_task_proposal")).toBe(true);
});
