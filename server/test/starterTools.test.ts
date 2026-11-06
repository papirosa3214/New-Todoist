// Стартовый набор инструментов TaskFlow — один для всех ролей; остальное через taskflow_tools.
import { expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog, STARTER_TOOLS } from "../src/runtime/roleToolCatalog.js";

migrate(); runMigrations();
const wire = (names: string[], tools: any[]) => JSON.stringify(tools.filter((t) => names.includes(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;

it("активны только стартовые операции (с учётом фильтра режима) и загрузчик", () => {
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c1", messageId: "m1", executionMode: "chat" } as any);
  const starter = new Set<string>(STARTER_TOOLS);
  const active = cat.activeNames.filter((n) => n !== "taskflow_tools");
  expect(cat.activeNames).toContain("taskflow_tools");
  expect(active.every((n) => starter.has(n))).toBe(true);
  for (const n of ["taskflow_work_item_submit", "taskflow_inspect", "taskflow_host_bash", "taskflow_work_plan", "taskflow_recall"]) expect(active, n).toContain(n);
  // вне списка — не в стартовых схемах
  for (const n of ["taskflow_claim", "taskflow_heartbeat", "taskflow_state", "taskflow_routines", "taskflow_review"]) expect(active, n).not.toContain(n);
  // в чате карточные операции по-прежнему скрыты
  for (const n of ["taskflow_subtask_done", "taskflow_subtask_work", "taskflow_slot_snapshot"]) expect(active, n).not.toContain(n);
  // каталог при этом полный: вне списка зарегистрировано сильно больше
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
