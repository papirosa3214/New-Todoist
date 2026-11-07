// Операция вне активного набора: сервер подключает её и сразу выполняет тот же вызов.
import { expect, it } from "vitest";
import { Type } from "typebox";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";

migrate(); runMigrations();
const stub = (calls: any[]) => ({
  name: "taskflow_state", description: "stub", parameters: Type.Object({ state: Type.String() }),
  execute: async (_id: string, args: any) => { calls.push(args); return { content: [{ type: "text", text: "СДЕЛАНО:" + args.state }], details: { ok: 1 } }; },
});
const notFound = (name: string) => ({ type: "tool_execution_end", toolCallId: "c1", toolName: name, isError: true, result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} } });
const start = (name: string, args: any) => ({ type: "tool_execution_start", toolCallId: "c1", toolName: name, args });

it("taskflow_state вне стартового набора выполняется с первого раза", async () => {
  const calls: any[] = [];
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", taskId: "t1", subtaskId: "s1" } as any, [stub(calls) as any]);
  expect(cat.activeNames).not.toContain("taskflow_state");
  let active = [...cat.activeNames];
  cat.attachSession({ getActiveToolNames: () => active, setActiveToolsByName: (n: string[]) => { active = n; } });
  await cat.onAgentEvent(start("taskflow_state", { state: "review" }));
  const end: any = notFound("taskflow_state");
  await cat.onAgentEvent(end);
  expect(calls).toEqual([{ state: "review" }]);
  expect(end.result.content[0].text).toBe("СДЕЛАНО:review");
  expect(end.isError).toBe(false);
  expect(active).toContain("taskflow_state");
  // сторож не считает это ошибкой и не останавливает ход
  expect(cat.onToolExecutionEnd(end)).toBe(false);
  const audit = db.prepare("SELECT outcome,error_message FROM role_tool_audit WHERE action='auto_connect' AND tool='taskflow_state' ORDER BY created_at DESC LIMIT 1").get() as any;
  expect(audit).toMatchObject({ outcome: "ok", error_message: "auto_connected" });
});
it("запрещённая роли операция и неверные аргументы — прежний отказ, без выполнения", async () => {
  const calls: any[] = [];
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", taskId: "t1", subtaskId: "s1" } as any, [stub(calls) as any]);
  // taskflow_routines — только у Помощника: у builder её нет в каталоге
  const end: any = notFound("taskflow_routines");
  await cat.onAgentEvent(start("taskflow_routines", {}));
  await cat.onAgentEvent(end);
  expect(end.isError).toBe(true);
  expect(end.result.content[0].text).toContain("not found");
  const bad: any = notFound("taskflow_state");
  await cat.onAgentEvent(start("taskflow_state", { state: 42 }));
  await cat.onAgentEvent(bad);
  expect(calls).toHaveLength(0);
  expect(bad.isError).toBe(true);
});
it("в чате карточная операция по-прежнему скрыта и не выполняется", async () => {
  const calls: any[] = [];
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", chatId: "c1", messageId: "m1", executionMode: "chat" } as any, [stub(calls) as any]);
  const end: any = notFound("taskflow_state");
  await cat.onAgentEvent(start("taskflow_state", { state: "review" }));
  await cat.onAgentEvent(end);
  expect(calls).toHaveLength(0);
  expect(end.isError).toBe(true);
});
