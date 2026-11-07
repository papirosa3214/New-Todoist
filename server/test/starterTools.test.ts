// Стартовый набор инструментов TaskFlow — один для всех ролей; остальное через taskflow_tools.
import { expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog, installNativeToolCore } from "../src/runtime/roleToolCatalog.js";

migrate(); runMigrations();
const wire = (names: string[], tools: any[]) => JSON.stringify(tools.filter((t) => names.includes(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;

it("активны группы по объектам, отдельные операции и пакетный вызов (владелец 07.11.2026)", () => {
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c1", messageId: "m1", executionMode: "chat" } as any);
  const active = cat.activeNames;
  for (const n of ["taskflow_work_item_submit", "taskflow_inspect", "taskflow_host_bash", "taskflow_work_plan", "taskflow_memory", "taskflow_step", "taskflow_batch"]) expect(active, n).toContain(n);
  // члены групп и выведенные операции — не отдельными схемами
  for (const n of ["taskflow_claim", "taskflow_heartbeat", "taskflow_recall", "taskflow_subtask_done"]) expect(active, n).not.toContain(n);
  // загрузчик подключения по требованию активен: без него операцию нечем подключить
  expect(active).toContain("taskflow_tools");
  // реестр сессии полный: прежние имена подключаются автоматически
  expect(cat.registeredNames.length).toBeGreaterThan(active.length + 20);
});
it("операция вне стартового набора подключается через taskflow_tools", async () => {
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", taskId: "t1", subtaskId: "s1" } as any);
  expect(cat.activeNames).not.toContain("taskflow_state");
  let active = [...cat.activeNames];
  cat.attachSession({ getActiveToolNames: () => active, setActiveToolsByName: (n: string[]) => { active = n; } });
  const res: any = await cat.loader.tool.execute("1", { names: ["taskflow_state"] });
  expect(JSON.parse(res.content[0].text).activated).toEqual(["taskflow_state"]);
  expect(active).toContain("taskflow_state");
});
it("размер схем стартового набора (для отчёта)", () => {
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", taskId: "t1", subtaskId: "s1" } as any);
  const size = wire(cat.activeNames, cat.customTools as any[]);
  expect(size).toBeGreaterThan(0);
  console.log("STARTER_SCHEMA_BYTES", size, cat.activeNames.length);
});

/** Внешние сервисы (07.11.2026): схемы Todoist, Composio и Things не уходят в
 *  каждом запросе, но операции остаются в реестре и подключаются загрузчиком. */
const externalAdapter = (name: string, description: string, calls: string[] = []) => ({
  name,
  description,
  parameters: { type: "object", properties: {}, additionalProperties: true },
  execute: async () => {
    calls.push(name);
    return { content: [{ type: "text", text: `${name} выполнено` }] };
  },
});
const adapters = () => {
  const calls: string[] = [];
  const tools = [
    externalAdapter("todoist_create_task", "Создать задачу в Todoist", calls),
    externalAdapter("mcp__composio__COMPOSIO_SEARCH_TOOLS", "Найти инструмент Composio", calls),
    externalAdapter("things_add", "Добавить дело в Things 3", calls),
  ];
  return { tools, calls };
};
function fakeSession() {
  let active: string[] = [];
  return {
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names: string[]) => { active = [...new Set(names)]; },
    names: () => [...active],
  };
}

it("Todoist, Composio и Things не в стартовом наборе, но в реестре сессии", () => {
  const { tools } = adapters();
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c1", messageId: "m1", executionMode: "chat" } as any, tools as any[]);
  for (const name of ["todoist_create_task", "mcp__composio__COMPOSIO_SEARCH_TOOLS", "things_add"]) {
    expect(cat.activeNames, name).not.toContain(name);
    expect(cat.registeredNames, name).toContain(name);
  }
});

it("taskflow_tools подключает внешнюю операцию по имени и она исполняется", async () => {
  const { tools, calls } = adapters();
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c2", messageId: "m1", executionMode: "chat" } as any, tools as any[]);
  const session = fakeSession();
  cat.attachSession(session);
  const out = JSON.parse(((await cat.loader.tool.execute("1", { names: ["todoist_create_task"] })) as any).content[0].text);
  expect(out.activated).toEqual(["todoist_create_task"]);
  expect(session.names()).toContain("todoist_create_task");
  const op = (cat.customTools as any[]).find((tool) => tool.name === "todoist_create_task");
  await op.execute("todoist-call", {});
  expect(calls).toEqual(["todoist_create_task"]);
});

it("taskflow_tools подбирает операцию по смыслу запроса", async () => {
  const { tools, calls } = adapters();
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c3", messageId: "m1", executionMode: "chat" } as any, tools as any[]);
  const session = fakeSession();
  cat.attachSession(session);
  const out = JSON.parse(((await cat.loader.tool.execute("1", { query: "добавить дело в things" })) as any).content[0].text);
  expect(out.activated).toContain("things_add");
  const op = (cat.customTools as any[]).find((tool) => tool.name === "things_add");
  await op.execute("things-call", {});
  expect(calls).toEqual(["things_add"]);
});

it("подключённая внешняя операция активна в следующем ходе той же сессии", () => {
  const { tools } = adapters();
  const first = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "t1", chatId: "c4", messageId: "m1", executionMode: "chat" } as any, tools as any[]);
  first.attachSession(fakeSession());
  expect(first.activeNames).not.toContain("todoist_create_task");
  return (async () => {
    await first.loader.tool.execute("1", { names: ["todoist_create_task"] });
    const next = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "t2", chatId: "c4", messageId: "m2", executionMode: "chat" } as any, adapters().tools as any[]);
    const session = fakeSession();
    installNativeToolCore(session, next, []);
    expect(session.names()).toContain("todoist_create_task");
  })();
});

it("закрытая ролью операция не подключается даже по имени", async () => {
  // Адаптеров нет — значит и в реестре роли этих операций нет.
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c5", messageId: "m1", executionMode: "chat" } as any);
  const session = fakeSession();
  cat.attachSession(session);
  const out = JSON.parse(((await cat.loader.tool.execute("1", { names: ["todoist_create_task", "things_add"] })) as any).content[0].text);
  expect(out.activated).toEqual([]);
  expect(out.unknown).toEqual(["todoist_create_task", "things_add"]);
  expect(session.names()).not.toContain("todoist_create_task");
});
