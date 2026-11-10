import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { activeToolNamesFor } from "../src/runtime/roleToolCatalog.js";

// Список «/» показывает то, чем роль реально работает: операции, попавшие в
// группу по объекту, отдельными именами не дублируются (владелец 10.11.2026:
// «они одно к одному»).
describe("active tool names for the slash list", () => {
  let app: any;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("групповая операция не дублируется отдельным именем", () => {
    const active = activeToolNamesFor(["taskflow_task", "taskflow_my_tasks", "taskflow_host_bg", "taskflow_host_read"]);
    expect(active).toContain("taskflow_tasks");
    expect(active).toContain("taskflow_host");
    expect(active).not.toContain("taskflow_task");
    expect(active).not.toContain("taskflow_my_tasks");
    expect(active).not.toContain("taskflow_host_bg");
    // Чтение на машине остаётся отдельным: в режиме «План» группа запрещена целиком.
    expect(active).toContain("taskflow_host_read");
  });

  it("пакетный вызов и загрузчик остаются, снятые операции — нет", () => {
    const active = activeToolNamesFor(["taskflow_task", "taskflow_heartbeat", "taskflow_tool_request", "taskflow_tools"]);
    expect(active).toContain("taskflow_batch");
    expect(active).toContain("taskflow_tools");
    expect(active).not.toContain("taskflow_heartbeat");
    expect(active).not.toContain("taskflow_tool_request");
  });

  it("внешние сервисы остаются под загрузчиком", () => {
    const active = activeToolNamesFor(["todoist_tasks", "archify_build", "taskflow_recall"]);
    expect(active).not.toContain("todoist_tasks");
    expect(active).not.toContain("archify_build");
    expect(active).toContain("taskflow_memory");
    expect(active).not.toContain("taskflow_recall");
  });
});
