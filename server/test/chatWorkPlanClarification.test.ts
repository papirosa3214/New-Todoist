// Уточнение владельца во время работы роли по чек-листу (карточка b504958a,
// доработка D1/D2).
//
// Сценарий приёмки №1 контракта: уточнение во время первого пункта —
// сообщение сохранено сразу, ход отменён, поколение пары выросло, старая
// доставка ушла в «устаревшая», а задание следующего хода называет ТОТ ЖЕ
// текущий пункт и содержит уточнение.
//
// Pi замокан (висящий prompt, отпускается по abort) — живых моделей и сети
// нет. RED на коде до переноса границы: поколение не росло, старая доставка
// оставалась «в работе», а поздняя сдача проходила как свежая.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";
import { currentChatGeneration } from "../src/runtime/chatQueue.js";
import {
  chatDeliveryStateOf,
  chatPlanView,
  chatWorkPlanPrompt,
  saveChatWorkPlan,
  submitChatWorkItem,
} from "../src/lib/subtaskWorkPlan.js";
import { startChatRun, _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRoleLocksForTests, _resetChatRoleQueuesForTests } from "../src/runtime/chatSession.js";

const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();

/** Системные инструкции, с которыми сервер поднимал ходы: в них входит
 *  задание чек-листа (текущий пункт). */
const capturedSystemPrompts: string[] = [];
const capture = vi.hoisted(() => ({ prompts: [] as string[] }));

vi.mock("../src/runtime/instructionResources.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createTaskResourceLoader: async (role: string, cwd: string, systemPrompt: string, ...rest: any[]) => {
      capture.prompts.push(systemPrompt);
      return actual.createTaskResourceLoader(role, cwd, systemPrompt, ...rest);
    },
  };
});

/** Журнал сессий фальшивого Pi: какие промпты уходили в ход. */
const sessions: Array<{ sessionId: string; prompts: string[]; aborted: boolean; waiting: boolean }> = [];
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
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (record.aborted) {
                clearInterval(timer);
                resolve();
              }
            }, 5);
            timer.unref?.();
          });
          throw Object.assign(new Error("ход остановлен владельцем"), { code: "CHAT_RUN_CANCELLED" });
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
      return makeSession(`sess-${sessionCounter}`);
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
let ownerId = "";
let chatId = "";
let roleUserId = "";

const FIRST = "@builder Начни первый пункт: изучи контракт";
const CLARIFICATION = "@builder Уточнение: сначала разберись с контрактом, потом иди дальше";

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "OwnerClarification",
      email: `owner-clarification-${Date.now()}@test`,
      password: "password123",
    },
  });
  ownerHeader = { authorization: `Bearer ${reg.json().token}` };
  ownerId = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
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
  // Чек-лист роли: три пункта, текущий — первый.
  saveChatWorkPlan(chatId, roleUserId, 0, [
    { id: "p1", title: "Изучить контракт", state: "pending" },
    { id: "p2", title: "Сделать", state: "pending" },
    { id: "p3", title: "Проверить", state: "pending" },
  ] as any);
});

beforeEach(() => {
  sessions.length = 0;
  hangIndex = -1;
  sessionCounter = 0;
  capture.prompts.length = 0;
  _resetActiveChatRunsForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
  db.prepare("DELETE FROM chat_sessions WHERE chat_id=?").run(chatId);
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id=?").run(chatId);
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(async () => {
  if (app) await app.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Первое сообщение владельца: ход роли повисает на нём. */
async function startHangingRun() {
  hangIndex = 0;
  const res = await app!.inject({
    method: "POST",
    url: `/api/chats/${chatId}/messages`,
    headers: ownerHeader,
    payload: { text: FIRST },
  });
  expect(res.statusCode).toBe(200);
  for (let i = 0; i < 100 && !(sessions[0]?.waiting ?? false); i += 1) await sleep(20);
  expect(sessions[0]?.waiting).toBe(true);
}

function messageIdByText(text: string): string {
  const row = db
    .prepare("SELECT id FROM chat_messages WHERE chat_id=? AND text=? ORDER BY rowid DESC LIMIT 1")
    .get(chatId, text) as { id: string } | undefined;
  if (!row) throw new Error(`сообщение не найдено: ${text}`);
  return row.id;
}

describe("уточнение владельца во время пункта чек-листа", () => {
  it("поколение выросло, старая доставка устарела, следующий ход знает тот же пункт и уточнение", async () => {
    await startHangingRun();
    const generationBefore = currentChatGeneration(chatId, roleUserId);
    const firstMessageId = messageIdByText(FIRST);

    // Уточнение владельца приходит во время работы роли.
    const second = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: CLARIFICATION },
    });
    expect(second.statusCode).toBe(200);

    // 1. Граница: поколение пары выросло.
    expect(currentChatGeneration(chatId, roleUserId)).toBeGreaterThan(generationBefore);

    // 2. Прежняя доставка ушла в «устаревшая» — её поздний ответ не сдвинет пункт.
    await sleep(100);
    const oldDelivery = db
      .prepare("SELECT status FROM chat_message_queue WHERE chat_id=? AND role_id=? AND message_id=?")
      .get(chatId, roleUserId, firstMessageId) as { status: string } | undefined;
    expect(oldDelivery?.status).toBe("superseded");
    expect(chatDeliveryStateOf(chatId, roleUserId, firstMessageId)).toBe("stale");

    // 3. Задание следующего хода называет ТОТ ЖЕ текущий пункт.
    const view = chatPlanView(chatId, roleUserId)!;
    expect(view.current_item_id).toBe("p1");
    const planText = chatWorkPlanPrompt(chatId, roleUserId);
    expect(planText).toContain("Текущий пункт — «Изучить контракт» (id p1)");

    // 4. Уточнение дошло до следующего хода.
    for (let i = 0; i < 100 && sessions.length < 2; i += 1) await sleep(20);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const nextPrompt = sessions[sessions.length - 1].prompts.join("\n");
    expect(nextPrompt).toContain("разберись с контрактом");
    // Задание именно СЛЕДУЮЩЕГО хода (последняя поднятая системная
    // инструкция) называет тот же текущий пункт.
    const systemPrompt = capture.prompts[capture.prompts.length - 1] ?? "";
    expect(systemPrompt).toContain("Текущий пункт — «Изучить контракт» (id p1)");

    // 5. Поздняя сдача из прежнего хода не принимается.
    expect(() =>
      submitChatWorkItem({
        chatId,
        roleId: roleUserId,
        itemId: "p1",
        result: "Сделал.",
        outcome: "done",
        messageId: firstMessageId,
      }),
    ).toThrow(/устаревшего|закрытого хода/);
    expect(chatPlanView(chatId, roleUserId)!.current_item_id).toBe("p1");

    // 6. Сдача из нового хода принимается и открывает следующий пункт.
    const secondMessageId = messageIdByText(CLARIFICATION);
    const accepted = submitChatWorkItem({
      chatId,
      roleId: roleUserId,
      itemId: "p1",
      result: "Изучил контракт.",
      outcome: "done",
      messageId: secondMessageId,
    });
    expect(accepted.next_item?.id).toBe("p2");
    expect(chatPlanView(chatId, roleUserId)!.current_item_id).toBe("p2");
  });
});


it("настроенный потолок времени явно останавливает чек-лист, а не оставляет вечный текущий пункт",async()=>{
 hangIndex=0;
 await expect(startChatRun({chatId,role:"builder",roleId:roleUserId,prompt:"Начни пункт",timeoutMs:30,idleMs:0})).rejects.toMatchObject({code:"CHAT_RUN_CEILING"});
 expect(chatPlanView(chatId,roleUserId)!.status).toBe("stopped");
 expect(chatPlanView(chatId,roleUserId)!.stop_reason).toBe("budget_exhausted");
});
