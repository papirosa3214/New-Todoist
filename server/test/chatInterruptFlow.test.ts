// Этап 2 плана карточки 252c400e: сквозной сценарий обычного чата.
//
// Сценарий «уточнение прерывает прежнюю работу, новая идёт с новым
// контекстом» через настоящий HTTP-маршрут /api/chats/:id/messages:
//   1. владелец пишет — роль начинает ход (фальшивый Pi виснет на долгом
//      действии);
//   2. владелец пишет ещё раз — прежняя работа останавливается: поколение
//      пары увеличивается, ход прежнего поколения закрыт, частичный ответ
//      сохранён с признаком прерывания;
//   3. следующий ход идёт в СВЕЖУЮ сессию с трёхсекционной выжимкой, а не
//      продолжает прежний файл сессии; в промпте нет сырых размышлений.
//
// Pi замокан: внешняя работа имитируется «висящим» prompt, который
// отпускается по abort. Сети и живых моделей нет.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";
import { currentChatGeneration } from "../src/runtime/chatQueue.js";
import { _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRoleLocksForTests, _resetChatRoleQueuesForTests } from "../src/runtime/chatSession.js";

const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();
const PRIMARY = liveCatalogEntryOf("qa");

/** Журнал вызовов фальшивого Pi: какие сессии открывались и с каким промптом. */
const sessions: Array<{ sessionId: string; prompts: string[]; aborted: boolean; waiting: boolean }> = [];
/** Индекс сессии, которая должна висеть до abort. */
let hangIndex = -1;

function makeSession(sessionId: string) {
  const record = { sessionId, prompts: [] as string[], aborted: false, waiting: false };
  sessions.push(record);
  return {
    record,
    session: {
      sessionId,
      subscribe: () => () => {},
      prompt: async (text: string) => {
        record.prompts.push(text);
        const index = sessions.length - 1;
        if (index === hangIndex) {
          record.waiting = true;
          // Висим, пока ход не отменят.
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (record.aborted) {
                clearInterval(timer);
                resolve();
              }
            }, 5);
            timer.unref?.();
          });
          const error = Object.assign(new Error("ход остановлен владельцем"), {
            code: "CHAT_RUN_CANCELLED",
          });
          throw error;
        }
      },
      abort: async () => {
        record.aborted = true;
      },
      waitForIdle: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "ок",
    },
  };
}

const mockRuntime = {
  getModels: vi.fn(() => CATALOG),
  getAvailable: vi.fn(async () => CATALOG),
  getProviders: vi.fn(() => PROVIDERS),
  getProvider: vi.fn(() => PROVIDERS[0]),
  getProviderAuthStatus: vi.fn(() => ({ configured: true })),
  checkAuth: vi.fn(async () => ({ type: "api_key" })),
  login: vi.fn(async () => ({ type: "api_key" })),
  refresh: vi.fn(async () => ({})),
  getError: vi.fn(() => undefined),
  setRuntimeApiKey: vi.fn(async () => {}),
  isUsingOAuth: vi.fn(() => false),
  isUsingSubscription: vi.fn(() => false),
  hasConfiguredAuth: vi.fn(() => true),
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
      const id = existing && String(existing).startsWith("sess-old") ? String(existing) : `sess-new-${sessionCounter}`;
      return makeSession(id);
    }),
  };
});

vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(),
  addClient: vi.fn(),
  removeClient: vi.fn(),
  onUserGone: vi.fn(),
  broadcast: vi.fn(),
  broadcastTaskEvent: vi.fn(),
  broadcastToUsers: vi.fn(),
}));

let app: FastifyInstance | undefined;
let ownerHeader: Record<string, string> = {};
let chatId = "";
let roleUserId = "";

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "OwnerInterrupt",
      email: `owner-interrupt-${Date.now()}@test`,
      password: "password123",
    },
  });
  ownerHeader = { authorization: `Bearer ${reg.json().token}` };
  // Зарегистрированная учётка — обычный человек; владельцем её делает
  // сервер (права владельца включают остановку хода по уточнению).
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(reg.json().user.id);
  roleUserId = (db
    .prepare("SELECT id FROM users WHERE role_key='builder' AND type='ai' LIMIT 1")
    .get() as { id: string }).id;
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    headers: ownerHeader,
    payload: { kind: "direct", member_ids: ["role_builder"] },
  });
  chatId = chat.json().chat.id;
});

beforeEach(() => {
  sessions.length = 0;
  hangIndex = -1;
  sessionCounter = 0;
  _resetActiveChatRunsForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
  db.prepare("DELETE FROM chat_sessions WHERE chat_id=?").run(chatId);
  // Таблицы выжимки на старом коде ещё нет — чистка не должна падать,
  // чтобы падение теста было про поведение, а не про схему.
  try {
    db.prepare("DELETE FROM chat_checkpoints WHERE chat_id=?").run(chatId);
  } catch {
    /* на старом коде таблицы нет */
  }
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id=?").run(chatId);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  if (app) await app.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("обычный чат: уточнение прерывает прежнюю работу", () => {
  it("прежний ход остановлен, поколение увеличено, новый ход идёт с выжимкой", async () => {
    // Первая сессия «висит» на долгом действии.
    hangIndex = 0;
    const first = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни долгую работу" },
    });
    expect(first.statusCode).toBe(200);
    // Ждём, пока ход действительно начался и повис.
    for (let i = 0; i < 100 && !(sessions[0]?.waiting ?? false); i += 1) await sleep(20);
    expect(sessions[0]?.waiting).toBe(true);
    const generationBefore = currentChatGeneration(chatId, roleUserId);

    // Второе сообщение владельца — уточнение: прежняя работа прерывается.
    const second = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Стоп, теперь другое" },
    });
    expect(second.statusCode).toBe(200);

    // Граница сработала: поколение пары увеличилось.
    expect(currentChatGeneration(chatId, roleUserId)).toBeGreaterThan(generationBefore);
    // Прежний ход реально остановлен (abort дошёл до фальшивого Pi).
    await sleep(50);
    expect(sessions[0]?.aborted).toBe(true);
    // Ходы прежнего поколения закрыты — восстановление их не повторит.
    const stale = db
      .prepare("SELECT status FROM chat_message_queue WHERE chat_id=? AND role_id=?")
      .all(chatId, roleUserId) as Array<{ status: string }>;
    expect(stale.every((row) => row.status !== "pending" && row.status !== "picked")).toBe(true);
  });

  it("прерванный ответ помечен: почему прерван и что он частичный", async () => {
    hangIndex = 0;
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни работу, потом уточню" },
    });
    for (let i = 0; i < 100 && !(sessions[0]?.waiting ?? false); i += 1) await sleep(20);
    expect(sessions[0]?.waiting).toBe(true);
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Стоп" },
    });
    for (let i = 0; i < 100; i += 1) {
      const marked = db
        .prepare(
          "SELECT id, stop_reason, partial FROM chat_messages WHERE chat_id=? AND from_user_id=? AND stop_reason IS NOT NULL",
        )
        .all(chatId, roleUserId) as Array<{ id: string; stop_reason: string; partial: number }>;
      if (marked.length) {
        expect(marked[0].stop_reason).toBe("owner_interrupt");
        expect(marked[0].partial).toBe(1);
        return;
      }
      await sleep(20);
    }
    throw new Error("прерванный ответ не помечен stop_reason");
  });

  it("после прерывания следующий ход идёт в свежую сессию с выжимкой, а не продолжает прежнюю", async () => {
    // Первая сессия «висит» на долгом действии.
    hangIndex = 0;
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Начни долгую работу" },
    });
    for (let i = 0; i < 100 && !(sessions[0]?.waiting ?? false); i += 1) await sleep(20);
    expect(sessions[0]?.waiting).toBe(true);
    const firstSessionId = sessions[0].sessionId;

    // Уточнение владельца прерывает прежнюю работу.
    await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Стоп, теперь другое" },
    });
    for (let i = 0; i < 100 && sessions.length < 2; i += 1) await sleep(20);
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    const next = sessions[sessions.length - 1];
    // Свежая сессия: прежний файл не продолжается.
    expect(next.sessionId).not.toBe(firstSessionId);
    const prompt = next.prompts.join("\n");
    // В промпте — выжимка тремя разделами.
    expect(prompt).toContain("Что было");
    expect(prompt).toContain("Цель и задача");
    expect(prompt).toContain("Что выполнить");
    // Сырых размышлений в промпте нет.
    expect(prompt).not.toContain("[Assistant thinking]");
  });
});
