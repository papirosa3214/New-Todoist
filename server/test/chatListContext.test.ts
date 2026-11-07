import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  closeChatSession,
  markChatContextCompacted,
  measureChatSession,
  openChatSession,
  readChatListContext,
  resetChatContext,
} from "../src/runtime/chatContextUsage.js";

const OWNER = "list-context-owner";
const ROLE = "list-context-role";
const OTHER = "list-context-other";
const CHAT = "list-context-chat";

let usage: { tokens: number | null; contextWindow: number } | null;
const fakeSession = () => ({ getContextUsage: () => usage, state: { messages: [] }, systemPrompt: "" });
const open = (roleId = ROLE) =>
  openChatSession({ chatId: CHAT, roleId, session: fakeSession(), sessionId: "s1", provider: "p", model: "m" });

beforeAll(() => {
  migrate();
  runMigrations();
  for (const id of [OWNER, ROLE, OTHER]) {
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,type) VALUES(?,?,?,\x27!\x27,\x27ai\x27)").run(id, id, `${id}@test.local`);
  }
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,\x27t\x27,\x27direct\x27,?)").run(CHAT, OWNER);
});

beforeEach(() => {
  resetChatContext(CHAT, ROLE);
  resetChatContext(CHAT, OTHER);
  usage = { tokens: 42000, contextWindow: 100000 };
});

describe("контекст сессии в списке чатов", () => {
  it("замер виден списку и остаётся после конца хода", () => {
    open();
    closeChatSession(CHAT, ROLE);
    expect(readChatListContext(CHAT)).toMatchObject({ tokens: 42000, context_window: 100000 });
  });

  it("новый замер заменяет прежний", () => {
    open();
    usage = { tokens: 50000, contextWindow: 100000 };
    measureChatSession(CHAT, ROLE);
    expect(readChatListContext(CHAT)?.tokens).toBe(50000);
  });

  it("сброс сессии убирает устаревшее число", () => {
    open();
    resetChatContext(CHAT, ROLE);
    expect(readChatListContext(CHAT)).toBeNull();
  });

  it("после сжатия устаревшее число не показывается", () => {
    open();
    markChatContextCompacted(CHAT, ROLE);
    expect(readChatListContext(CHAT)).toBeNull();
  });

  it("замер без числа токенов не оставляет старое значение", () => {
    open();
    usage = { tokens: null, contextWindow: 100000 };
    measureChatSession(CHAT, ROLE);
    expect(readChatListContext(CHAT)).toBeNull();
  });
});
