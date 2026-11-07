import { describe, expect, it } from "vitest";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";

describe("Набор инструментов по роли", () => {
  it("один полный набор у всех ролей (владелец 07.11.2026)", () => {
    expect(roleToolAllowed("critic_verifier", "taskflow_review")).toBe(true);
    expect(roleToolAllowed("builder", "taskflow_review")).toBe(true);
    expect(roleToolAllowed("secretary", "taskflow_calendar_events")).toBe(true);
    expect(roleToolAllowed("qa", "taskflow_calendar_events")).toBe(true);
  });
  it("важное редкое остаётся всем рабочим ролям", () => {
    for (const role of ["builder", "qa", "critic_verifier", "analyst", "designer", "researcher", "infra_engineer"]) {
      expect(roleToolAllowed(role, "taskflow_state")).toBe(true);
      expect(roleToolAllowed(role, "taskflow_plan_request")).toBe(true);
      expect(roleToolAllowed(role, "taskflow_chat_reply")).toBe(true);
    }
  });
  it("Помощник владельца получает общие инструменты; удаление закрыто, архив открыт", () => {
    for (const tool of ["taskflow_state", "taskflow_slot_status", "taskflow_slot_reset", "taskflow_subtask_add", "taskflow_plan_request", "taskflow_topic_send", "taskflow_library", "taskflow_archive"]) {
      expect(roleToolAllowed("secretary", tool), tool).toBe(true);
    }
    for (const tool of ["taskflow_delete", "taskflow_task_purge", "taskflow_project_remove"]) {
      expect(roleToolAllowed("secretary", tool), tool).toBe(false);
    }
  });
  it("новый инструмент по умолчанию достаётся всем", () => {
    expect(roleToolAllowed("builder", "taskflow_new_thing")).toBe(true);
  });
});
