import { describe, expect, it } from "vitest";
import { resolveChatContext } from "../src/runtime/chatTools.js";

describe("контекст чата для инструментов роли (владелец 13.11.2026)", () => {
  it("пустой chatId в карточке — берётся чат задачи", () => {
    const ctx = resolveChatContext({ chatId: "", messageId: "" }, () => ({ chatId: "task-chat", messageId: "" }));
    expect(ctx?.chatId).toBe("task-chat");
  });
  it("настоящий чат остаётся своим", () => {
    const ctx = resolveChatContext({ chatId: "c1", messageId: "m1" }, () => ({ chatId: "task-chat", messageId: "" }));
    expect(ctx?.chatId).toBe("c1");
  });
  it("без чата и без задачи — контекста нет", () => {
    expect(resolveChatContext({ chatId: "", messageId: "" })).toBeUndefined();
  });
});
