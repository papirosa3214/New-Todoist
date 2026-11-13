import { describe, expect, it } from "vitest";
import { catalogAuthorize } from "../src/runtime/roleToolCatalog.js";

describe("сессия владельца не пишет ролям в чаты (владелец 13.11.2026)", () => {
  it("в сессии отправка в чат запрещена, чтение — нет", () => {
    const session = catalogAuthorize({ role: "secretary", ownerSession: true });
    expect(session("taskflow_chat_send")).toBe(false);
    expect(session("taskflow_topic_send")).toBe(false);
  });
  it("в обычном ходе роли отправка в чат как была", () => {
    const chat = catalogAuthorize({ role: "secretary" });
    const session = catalogAuthorize({ role: "secretary", ownerSession: true });
    expect(session("taskflow_chat_read")).toBe(chat("taskflow_chat_read"));
    expect(chat("taskflow_chat_send")).toBe(chat("taskflow_chat_send"));
  });
});
