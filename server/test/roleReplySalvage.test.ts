import { describe, expect, it } from "vitest";
import {
  normalizeRoleReplyV1,
  salvageMarkdownFromJsonParseFailure,
} from "../src/lib/roleContractV1.js";

describe("Markdown-ответ роли не валит JSON.parse", () => {
  it("Node-сообщение с многоточием спасает заголовок, полный текст идёт в text-блок", () => {
    const md = "## Результат\nГотово.";
    const err = new SyntaxError(`Unexpected token '#', "${md.slice(0, 12)}"... is not valid JSON`);
    expect(salvageMarkdownFromJsonParseFailure(err, "")).toBe(md.slice(0, 12));
    expect(salvageMarkdownFromJsonParseFailure(err, md)).toBe(md);
    expect(salvageMarkdownFromJsonParseFailure(new Error("ENOENT"), md)).toBeNull();
    const wrapped = normalizeRoleReplyV1(md);
    expect(wrapped.envelope.output).toEqual([
      { type: "heading", level: 2, text: "Результат" },
      { type: "text", text: "Готово." },
    ]);
    expect(wrapped.normalizedByServer).toBe(true);
  });
});
