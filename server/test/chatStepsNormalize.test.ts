import { describe, expect, it } from "vitest";
import { normalizeSavedSteps } from "../src/lib/chatMessages.js";

describe("normalizeSavedSteps", () => {
  it("оборачивает голый массив items в SavedSteps", () => {
    const items = [
      { kind: "text", id: "text-1", text: "привет" },
      { kind: "thinking", id: "thinking-0", tool: "thinking", text: "", status: "done" },
    ];
    expect(normalizeSavedSteps(items)).toEqual({ duration_ms: 0, items });
  });

  it("оставляет уже правильный объект", () => {
    const steps = {
      duration_ms: 1200,
      items: [{ kind: "text", id: "t", text: "ok" }],
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    };
    expect(normalizeSavedSteps(steps)).toEqual(steps);
  });

  it("битое и пустое — null, без исключения", () => {
    expect(normalizeSavedSteps(null)).toBeNull();
    expect(normalizeSavedSteps("x")).toBeNull();
    expect(normalizeSavedSteps({ duration_ms: 1 })).toBeNull();
  });
});
