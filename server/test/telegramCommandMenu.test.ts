import { describe, expect, it } from "vitest";
import {
  TELEGRAM_COMMAND_CAP,
  TELEGRAM_COMMAND_DESCRIPTION_MAX,
  TELEGRAM_COMMAND_MAX_LENGTH,
  telegramCommandName,
  toTelegramCommands,
} from "../src/lib/telegramCommands.js";
import { TELEGRAM_KNOWN_METHODS, isKnownTelegramMethod, telegramDraftId, telegramReactionsEnabled, telegramStreamMode } from "../src/integrations/telegram.js";

const command = (id: string, description = "Описание") => ({
  id,
  title: id,
  kind: "mcp" as const,
  description,
  invocation: `/mcp:${id} `,
  summary: "",
  icon: "wrench",
});

describe("telegram command menu", () => {
  it("fits Bot API limits: 1-32 chars of a-z0-9_ and description up to 256", () => {
    expect(telegramCommandName("taskflow_ask_user_question")).toBe("ask_user_question");
    expect(telegramCommandName("Meeting Notes / Встреча")).toBe("meeting_notes");
    expect(telegramCommandName("taskflow_very_long_tool_name_that_does_not_fit")).toHaveLength(TELEGRAM_COMMAND_MAX_LENGTH);
    expect(telegramCommandName("!!!")).toBeNull();
    const [entry] = toTelegramCommands([command("taskflow_send", "я".repeat(400))]);
    expect(entry.command).toBe("send");
    expect(entry.description).toHaveLength(TELEGRAM_COMMAND_DESCRIPTION_MAX);
    expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it("deduplicates command names and keeps the invocation back to the chat registry", () => {
    const entries = toTelegramCommands([command("read"), command("taskflow_read", "второй"), command("write")]);
    expect(entries.map((item) => item.command)).toEqual(["read", "write"]);
    expect(entries[0].invocation).toBe("/mcp:read");
    expect(TELEGRAM_COMMAND_CAP).toBe(60);
  });
});

describe("telegram delivery contract", () => {
  it("knows the transports it dispatches by payload.method", () => {
    expect(isKnownTelegramMethod("sendMessage")).toBe(true);
    expect(isKnownTelegramMethod("setMessageReaction")).toBe(true);
    expect(isKnownTelegramMethod("sendMessageDraft")).toBe(true);
    expect(isKnownTelegramMethod("deleteWebhook")).toBe(false);
    expect(TELEGRAM_KNOWN_METHODS).not.toContain("sendRichMessage");
  });

  it("keeps a stable non-zero draft id per turn and defaults stream to auto", () => {
    expect(telegramDraftId("msg-1")).toBe(telegramDraftId("msg-1"));
    expect(telegramDraftId("msg-1")).not.toBe(telegramDraftId("msg-2"));
    expect(telegramDraftId("msg-1")).toBeGreaterThan(0);
    const previous = process.env.TASKFLOW_TELEGRAM_STREAM;
    delete process.env.TASKFLOW_TELEGRAM_STREAM;
    expect(telegramStreamMode()).toBe("auto");
    process.env.TASKFLOW_TELEGRAM_STREAM = "edit";
    expect(telegramStreamMode()).toBe("edit");
    process.env.TASKFLOW_TELEGRAM_STREAM = "мусор";
    expect(telegramStreamMode()).toBe("auto");
    if (previous === undefined) delete process.env.TASKFLOW_TELEGRAM_STREAM; else process.env.TASKFLOW_TELEGRAM_STREAM = previous;
  });

  it("keeps reactions off unless the switch says otherwise", () => {
    const previous = process.env.TASKFLOW_TELEGRAM_REACTIONS;
    delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
    expect(telegramReactionsEnabled()).toBe(false);
    process.env.TASKFLOW_TELEGRAM_REACTIONS = "off";
    expect(telegramReactionsEnabled()).toBe(false);
    process.env.TASKFLOW_TELEGRAM_REACTIONS = "on";
    expect(telegramReactionsEnabled()).toBe(true);
    if (previous === undefined) delete process.env.TASKFLOW_TELEGRAM_REACTIONS; else process.env.TASKFLOW_TELEGRAM_REACTIONS = previous;
  });
});
