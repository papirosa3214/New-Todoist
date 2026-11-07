// Роль должна получить инструменты на НАСТОЯЩЕМ движке Pi (владелец
// 02.10.2026: «у меня нет никаких инструментов»). У SDK `tools` — список
// имён; объекты туда давали пустой набор, и ни один мок этого не ловил.
import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  createCodingTools,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";

const model: any = {
  id: "test-model", name: "test", provider: "test", api: "openai-completions",
  baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 1000,
};

async function activeTools(tools: unknown, customTools: any[]) {
  const cwd = os.tmpdir();
  const { session } = await createAgentSession({
    cwd, model, tools: tools as any, customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  } as any);
  try {
    return (session as any).getActiveToolNames() as string[];
  } finally {
    session.dispose();
  }
}

describe("инструменты роли на движке Pi", () => {
  const custom = defineTool({
    name: "taskflow_task", label: "taskflow_task", description: "карточка",
    parameters: Type.Object({ id: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "{}" }], details: {} }),
  } as any);
  const builtin = createCodingTools(os.tmpdir()).filter((t: any) => ["read", "bash"].includes(t.name));

  it("имена в tools — роль получает и встроенные, и трекер", async () => {
    const names = await activeTools([...builtin.map((t: any) => t.name), "taskflow_task"], [...builtin, custom]);
    expect(names).toEqual(expect.arrayContaining(["read", "bash", "taskflow_task"]));
  });

  it("объекты в tools — роль остаётся без инструментов (так было сломано)", async () => {
    const names = await activeTools(builtin, [custom]);
    expect(names).toEqual([]);
  });
});
