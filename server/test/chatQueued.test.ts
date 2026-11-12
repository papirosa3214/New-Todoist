// Отложенные сообщения владельца (12.11.2026, как в T3 Code): пока роль
// отвечает, новое сообщение встаёт в очередь, а не прерывает ход. Через
// настоящие маршруты; Pi замокан «висящим» ходом, который отпускает тест.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";
import { _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRoleLocksForTests, _resetChatRoleQueuesForTests } from "../src/runtime/chatSession.js";
import { broadcastToUsers } from "../src/ws.js";

const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();

const sessions: Array<{ prompts: string[]; aborted: boolean; waiting: boolean; released: boolean }> = [];
let hangText = "";

function makeSession(sessionId: string) {
  const record = { prompts: [] as string[], aborted: false, waiting: false, released: false };
  sessions.push(record);
  const session = {
    sessionId,
    subscribe: () => () => {},
    prompt: async (text: string) => {
      record.prompts.push(text);
      if (hangText && text.includes(hangText)) {
        record.waiting = true;
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (record.aborted || record.released) { clearInterval(timer); resolve(); }
          }, 5);
          timer.unref?.();
        });
        if (record.aborted) throw Object.assign(new Error("остановлен"), { code: "CHAT_RUN_CANCELLED" });
      }
    },
    abort: async () => { record.aborted = true; },
    waitForIdle: async () => {},
    dispose: () => {},
    getLastAssistantText: () => "ок",
  };
  return { record, session };
}

const mockRuntime = {
  getModels: vi.fn(() => CATALOG), getAvailable: vi.fn(async () => CATALOG), getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn(() => PROVIDERS[0]), getProviderAuthStatus: vi.fn(() => ({ configured: true })),
  checkAuth: vi.fn(async () => ({ type: "api_key" })), login: vi.fn(async () => ({ type: "api_key" })),
  refresh: vi.fn(async () => ({})), getError: vi.fn(() => undefined), setRuntimeApiKey: vi.fn(async () => {}),
  isUsingOAuth: vi.fn(() => false), isUsingSubscription: vi.fn(() => false), hasConfiguredAuth: vi.fn(() => true),
  logout: vi.fn(async () => {}),
};
let sessionCounter = 0;
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPackageDir: () => "/mock/pi-pkg",
    ModelRuntime: { create: vi.fn(async () => mockRuntime) },
    createAgentSession: vi.fn(async (opts: any) => {
      sessionCounter += 1;
      const existing = opts.sessionManager?.getSessionId?.();
      return makeSession(existing ? String(existing) : `sess-new-${sessionCounter}`);
    }),
  };
});
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

let app: FastifyInstance;
let ownerHeader: Record<string, string> = {};
let chatId = "";

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { name: "OwnerQueued", email: `owner-queued-${Date.now()}@test`, password: "password123" },
  });
  ownerHeader = { authorization: `Bearer ${reg.json().token}` };
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(reg.json().user.id);
});

beforeEach(async () => {
  sessions.length = 0; hangText = ""; sessionCounter = 0;
  _resetActiveChatRunsForTests(); _resetChatRoleLocksForTests(); _resetChatRoleQueuesForTests();
  const chat = await app.inject({ method: "POST", url: "/api/chats", headers: ownerHeader, payload: { kind: "direct", member_ids: ["role_builder"] } });
  chatId = chat.json().chat.id;
});
afterEach(async () => {
  for (const s of sessions) s.released = true;
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(async () => { await app.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (text: string) => app.inject({ method: "POST", url: `/api/chats/${chatId}/messages`, headers: ownerHeader, payload: { text } });
const status = async () => (await app.inject({ method: "GET", url: `/api/chats/${chatId}/composer-status`, headers: ownerHeader })).json();
const inFeed = (needle: string) => (db.prepare("SELECT 1 FROM chat_messages WHERE chat_id=? AND text LIKE ?").get(chatId, `%${needle}%`) ? true : false);
const hung = () => sessions.find((s) => hangText && s.prompts.some((p) => p.includes(hangText)));
async function startHungTurn(marker: string) {
  hangText = marker;
  expect((await send(`@builder ${marker}`)).statusCode).toBe(200);
  for (let i = 0; i < 500 && !(hung()?.waiting ?? false); i += 1) await sleep(20);
  expect(hung()?.waiting).toBe(true);
}
async function until(cond: () => boolean | Promise<boolean>, ms = 9000) {
  for (let t = 0; t < ms; t += 50) { if (await cond()) return true; await sleep(50); }
  return false;
}

describe("отложенные сообщения владельца", () => {
  it("во время хода сообщение встаёт в очередь: ход не прерван, в ленте его нет", async () => {
    await startHungTurn("Долгая работа Q1");
    const res = await send("@builder Уточнение Q1");
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(true);
    expect(res.json().message.queued).toBe(true);
    expect(hung()!.aborted).toBe(false);
    expect(inFeed("Уточнение Q1")).toBe(false);
    const st = await status();
    expect(st.queued).toHaveLength(1);
    expect(st.queued[0]).toMatchObject({ message_id: res.json().message.id, text: "@builder Уточнение Q1" });
    expect(st.running).toEqual([]);
    expect(broadcastToUsers).toHaveBeenCalledWith(expect.anything(), { type: "chat.composer_status", chat_id: chatId });
  });

  it("после хода первое отложенное уходит роли само, обычным сообщением", async () => {
    await startHungTurn("Долгая работа Q2");
    const res = await send("@builder Уточнение Q2");
    const id = res.json().message.id;
    hung()!.released = true; // ход закончился
    expect(await until(() => inFeed("Уточнение Q2"))).toBe(true);
    expect(db.prepare("SELECT id FROM chat_messages WHERE chat_id=? AND text LIKE '%Уточнение Q2%'").get(chatId)).toEqual({ id });
    expect(await until(() => sessions.some((s) => s.prompts.some((p) => p.includes("Уточнение Q2"))))).toBe(true);
    expect((await status()).queued).toEqual([]);
  });

  it("«Отправить сейчас» вставляет в текущий ход, не прерывая его", async () => {
    await startHungTurn("Долгая работа Q3");
    const id = (await send("@builder Срочное Q3")).json().message.id;
    const res = await app.inject({ method: "POST", url: `/api/chats/${chatId}/queued/${id}/send-now`, headers: ownerHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toEqual([]);
    expect(inFeed("Срочное Q3")).toBe(true);
    expect(hung()!.aborted).toBe(false);
    // повтор: сообщения в очереди уже нет
    const again = await app.inject({ method: "POST", url: `/api/chats/${chatId}/queued/${id}/send-now`, headers: ownerHeader });
    expect(again.statusCode).toBe(404);
  });

  it("«Убрать» отменяет: роль сообщение не получает, в ленте его нет", async () => {
    await startHungTurn("Долгая работа Q4");
    const id = (await send("@builder Лишнее Q4")).json().message.id;
    const res = await app.inject({ method: "DELETE", url: `/api/chats/${chatId}/queued/${id}`, headers: ownerHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toEqual([]);
    hung()!.released = true;
    await sleep(2500);
    expect(inFeed("Лишнее Q4")).toBe(false);
    expect(sessions.some((s) => s.prompts.some((p) => p.includes("Лишнее Q4")))).toBe(false);
  });

  it("несколько отложенных уходят по одному, в порядке отправки", async () => {
    await startHungTurn("Долгая работа Q5");
    await send("@builder Первое Q5");
    await send("@builder Второе Q5");
    expect((await status()).queued.map((q: any) => q.text)).toEqual(["@builder Первое Q5", "@builder Второе Q5"]);
    hung()!.released = true;
    expect(await until(() => inFeed("Первое Q5") && inFeed("Второе Q5"), 15000)).toBe(true);
    const rows = db.prepare("SELECT text FROM chat_messages WHERE chat_id=? AND text LIKE '%Q5' AND from_user_id NOT LIKE 'role_%' ORDER BY rowid").all(chatId) as Array<{ text: string }>;
    expect(rows.map((r) => r.text).slice(-2)).toEqual(["@builder Первое Q5", "@builder Второе Q5"]);
  });
});
