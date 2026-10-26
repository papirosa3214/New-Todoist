import { describe, expect, it } from "vitest";
import { contextBreakdown } from "../src/runtime/chatContextUsage.js";

const session = (messages: any[]) => ({
  systemPrompt: "x".repeat(400),
  getActiveToolNames: () => ["read"],
  getAllTools: () => [
    { name: "read", description: "d", parameters: {} },
    { name: "write", description: "не активен", parameters: {} },
  ],
  state: { messages },
});

describe("разбивка занятого окна контекста", () => {
  it("части по ролям сообщений, сумма равна настоящему итогу", () => {
    const b = contextBreakdown(session([
      { role: "user", content: [{ type: "text", text: "y".repeat(80) }] },
      { role: "assistant", content: [{ type: "text", text: "z".repeat(40) }] },
      { role: "toolResult", content: [{ type: "text", text: "w".repeat(40) }] },
    ]), 1000)!;
    expect(b.system).toBe(100);
    expect(b.user).toBeGreaterThan(0);
    expect(b.assistant).toBeGreaterThan(0);
    expect(b.toolResults).toBeGreaterThan(0);
    expect(b.system + b.tools + b.user + b.assistant + b.toolResults + b.other).toBe(1000);
  });

  it("оценка больше итога — части ужимаются, «прочее» не отрицательное", () => {
    const b = contextBreakdown(session([]), 50)!;
    expect(b.other).toBeGreaterThanOrEqual(0);
    expect(b.system + b.tools + b.other).toBeLessThanOrEqual(51);
  });
});
