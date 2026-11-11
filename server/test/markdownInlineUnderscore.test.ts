import { describe, expect, it } from "vitest";
import { parseInline } from "../src/lib/markdownToTiptap.js";

// Подчёркивание внутри слова — не курсив: `note_accesses и knowledge_index_jobs`
// без кавычек превращалось в «noteaccesses и knowledgeindex_jobs» (владелец 11.11.2026).
describe("parseInline: подчёркивание внутри слова", () => {
  it("не делает курсив из snake_case", () => {
    const nodes = parseInline("следы в note_accesses и knowledge_index_jobs");
    expect(nodes.map((n) => n.text).join("")).toBe("следы в note_accesses и knowledge_index_jobs");
    expect(nodes.some((n) => n.marks?.some((m) => m.type === "italic"))).toBe(false);
  });
  it("курсив _словом_ по-прежнему работает", () => {
    const nodes = parseInline("это _важно_ сейчас");
    expect(nodes.find((n) => n.text === "важно")?.marks).toEqual([{ type: "italic" }]);
  });
});
