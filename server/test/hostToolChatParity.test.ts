import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";

// Хостовые операции (отправить ветку, приложить файл к карточке) должны быть
// в общем каталоге роли в любом режиме, а не только в рабочем ходе по карточке.
// Владелец 22.10.2026: работа в чате не должна требовать карточки, но при этом
// результат всё равно надо уметь отправить и приложить.

const names = (catalog: { operations: Array<{ name: string }> }) =>
  catalog.operations.map((tool) => tool.name);

describe("host tools in the shared role catalog", () => {
  let app: any;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("chat catalog exposes host push and attach", () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "chat-host", chatId: "chat-1" });
    expect(names(catalog)).toContain("taskflow_host_push");
    expect(names(catalog)).toContain("taskflow_host_attach");
  });

  it("builder iOS на .110 — без Mac-хоста", () => {
    const catalog = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "chat-no-host", chatId: "chat-ios" });
    expect(names(catalog)).not.toContain("taskflow_host_bash");
    expect(names(catalog)).not.toContain("taskflow_hosts");
  });

  it("chat call takes an explicit card id and slot", () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "chat-host-2", chatId: "chat-2" });
    const push = catalog.operations.find((tool) => tool.name === "taskflow_host_push") as any;
    const attach = catalog.operations.find((tool) => tool.name === "taskflow_host_attach") as any;
    expect(Object.keys(push.parameters.properties ?? {})).toEqual(expect.arrayContaining(["task_id", "subtask_id"]));
    expect(Object.keys(attach.parameters.properties ?? {})).toEqual(expect.arrayContaining(["task_id", "subtask_id", "path"]));
  });

  it("work run keeps the same tools once, not twice", () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "work-host", taskId: "task-1" });
    expect(names(catalog).filter((name) => name === "taskflow_host_push")).toHaveLength(1);
    expect(names(catalog).filter((name) => name === "taskflow_host_attach")).toHaveLength(1);
  });

  it("изменяющие команды на машине живут одной группой действий", () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "host-group", chatId: "chat-3" });
    const active = catalog.activeNames;
    expect(active).toContain("taskflow_host");
    for (const name of ["taskflow_host_bg", "taskflow_host_bash", "taskflow_host_write", "taskflow_host_edit", "taskflow_host_push", "taskflow_host_attach"]) {
      expect(active).not.toContain(name);
    }
    // Только чтение остаётся отдельным: в режиме «План» меняющая группа запрещена целиком.
    expect(active).toContain("taskflow_host_read");
    expect(active).toContain("taskflow_host_grep");
  });
});
