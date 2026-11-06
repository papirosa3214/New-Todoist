// Автоподключённый вызов уходит провайдеру без признака ошибки — во всех используемых форматах.
import { expect, it } from "vitest";
import { Type } from "typebox";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildRoleToolCatalog, clearAutoConnectedErrorFlags, fixAutoConnectedMessage } from "../src/runtime/roleToolCatalog.js";

migrate(); runMigrations();
const IDS = new Set(["c1"]);
const NF = "Tool taskflow_state not found";

it("Anthropic: is_error снят, текст not found убран; чужой вызов не тронут", () => {
  const p: any = { messages: [{ role: "user", content: [
    { type: "tool_result", tool_use_id: "c1", is_error: true, content: [{ type: "text", text: NF }, { type: "text", text: "реальный итог" }] },
    { type: "tool_result", tool_use_id: "other", is_error: true, content: [{ type: "text", text: NF }] }] }] };
  clearAutoConnectedErrorFlags(p, IDS);
  expect(p.messages[0].content[0]).toMatchObject({ is_error: false, content: [{ type: "text", text: "реальный итог" }] });
  expect(p.messages[0].content[1].is_error).toBe(true);
});
it("OpenAI Chat Completions и Responses: остаток not found убран", () => {
  const chat: any = { messages: [{ role: "tool", tool_call_id: "c1", content: NF }, { role: "tool", tool_call_id: "x", content: NF }] };
  clearAutoConnectedErrorFlags(chat, IDS);
  expect(chat.messages[0].content).toBe(""); expect(chat.messages[1].content).toBe(NF);
  const resp: any = { input: [{ type: "function_call_output", call_id: "c1", output: NF }] };
  clearAutoConnectedErrorFlags(resp, IDS);
  expect(resp.input[0].output).toBe("");
});
it("Google, Bedrock, Mistral: признак ошибки снят", () => {
  const g: any = { contents: [{ role: "user", parts: [{ functionResponse: { id: "c1", name: "taskflow_state", response: { error: "итог" } } }] }] };
  clearAutoConnectedErrorFlags(g, IDS);
  expect(g.contents[0].parts[0].functionResponse.response).toEqual({ output: "итог" });
  const b: any = { messages: [{ role: "user", content: [{ toolResult: { toolUseId: "c1", status: "error", content: [{ text: "итог" }] } }] }] };
  clearAutoConnectedErrorFlags(b, IDS);
  expect(b.messages[0].content[0].toolResult.status).toBe("success");
  const m: any = { messages: [{ role: "tool", tool_call_id: "c1", content: "[tool error] итог" }] };
  clearAutoConnectedErrorFlags(m, IDS);
  expect(m.messages[0].content).toBe("итог");
});
it("сообщение toolResult правится до сохранения в сессии; в сессионном состоянии признак не возвращается", async () => {
  const stub = { name: "taskflow_state", description: "s", parameters: Type.Object({ state: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "итог" }], details: {} }) };
  const cat = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "r", taskId: "t1", subtaskId: "s1" } as any, [stub as any]);
  cat.attachSession({ getActiveToolNames: () => [], setActiveToolsByName: () => {} });
  await cat.onAgentEvent({ type: "tool_execution_start", toolCallId: "c9", toolName: "taskflow_state", args: { state: "review" } });
  await cat.onAgentEvent({ type: "tool_execution_end", toolCallId: "c9", toolName: "taskflow_state", isError: true, result: { content: [{ type: "text", text: NF }], details: {} } });
  expect(cat.autoConnected.has("c9")).toBe(true);
  const message: any = { role: "toolResult", toolCallId: "c9", isError: true, content: [{ type: "text", text: "итог" }] };
  await cat.onAgentEvent({ type: "message_end", message });
  expect(message.isError).toBe(false);
  const plain: any = { role: "toolResult", toolCallId: "zzz", isError: true, content: [] };
  await cat.onAgentEvent({ type: "message_end", message: plain });
  expect(plain.isError).toBe(true);
  const m2: any = { isError: true, content: [{ type: "text", text: NF }, { type: "text", text: "x" }] };
  fixAutoConnectedMessage(m2);
  expect(m2).toMatchObject({ isError: false, content: [{ type: "text", text: "x" }] });
});
