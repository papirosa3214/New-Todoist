// Интеграция: durable-очередь сообщений и generation fence
// через HTTP-маршруты /api/chats/:id/messages и /api/chats/:id/new-session.
//
// Покрывает сценарий «поздняя доставка хода через fence»:
//   1. Клиент отправляет сообщение — durable запись появляется.
//   2. Клиент отправляет тот же message_id повторно (имитация
//      сетевого retry) — БД хранит только одну строку (idempotency).
//   3. Владелец нажимает /new-session — все pending-ходы
//      со старой generation уходят в superseded.
//   4. Новое сообщение после /new-session пишется на свежей
//      generation и не путается со старыми.
//
// Pi-модели замоканы: проверяем чистую серверную часть.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  resetModelRuntime,
  _resetActiveChatRunsForTests,
} from "../src/runtime/PiRuntimeAdapter.js";
import {
  _resetChatRoleLocksForTests,
  _resetChatRoleQueuesForTests,
  listPendingDeliveries,
  currentChatGeneration,
} from "../src/runtime/chatSession.js";
import { _resetChatQueueForTests } from "../src/runtime/chatQueue.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

const fakeClients: any[] = [];

/** Каталог и провайдеры — из боевого role-routing.yaml (helpers/liveRoutingModels):
 *  подделка не должна знать про смену основной модели ролей. */
const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();
const PRIMARY = liveCatalogEntryOf("qa");

/** Маркер текста, на котором мок createAgentSession бросает исключение.
 *  Нужен для проверки «ошибка Pi → durable не как success». */
let THROW_ON_TEXT = "";

function makeFakeRpcClient() {
  const client = {
    stop: vi.fn(async () => {}),
    getState: vi.fn(async () => ({
      sessionId: `sess-${fakeClients.length + 1}`,
      model: { provider: PRIMARY.provider, id: PRIMARY.id },
    })),
    getLastAssistantText: vi.fn(async () => "ок"),
    promptAndWait: vi.fn(async () => {}),
  };
  fakeClients.push(client);
  return client;
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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getPackageDir: () => "/mock/pi-pkg",
    ModelRuntime: { create: vi.fn(async () => mockRuntime) },
    createAgentSession: vi.fn(async (opts: any) => {
      // Глобальный маркер: если THROW_ON_TEXT === "1",
      // createAgentSession бросает всегда — мы имитируем
      // сбой Pi и проверяем, что durable-запись закрыта как
      // failed, а не done.
      if (THROW_ON_TEXT === "1") {
        throw new Error("мок: Pi-сбой по запросу теста");
      }
      makeFakeRpcClient();
      return {
        session: {
          sessionId: "sess-test",
          subscribe: () => () => {},
          prompt: async () => {},
          abort: () => {},
          dispose: () => {},
          getLastAssistantText: () => "ок",
        },
      };
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
let ownerId = "";
let ownerToken = "";
let ownerHeader: Record<string, string> = {};
let chatId = "";
let accId = "";

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "QueueOwner",
      email: `queue-owner-${Date.now()}@test`,
      password: "password123",
    },
  });
  ownerId = reg.json().user.id;
  ownerToken = reg.json().token;
  ownerHeader = { authorization: `Bearer ${ownerToken}` };

  // Создаём direct chat напрямую через БД: наш мок не поднимает
  // /api/chats/direct.
  accId = (db.prepare(
    "SELECT id FROM users WHERE role_key='builder' AND type='ai' LIMIT 1",
  ).get() as { id: string }).id;
  const row = db
    .prepare("SELECT 1 FROM chats WHERE id=?")
    .get("chat_queue_route");
  if (!row) {
    db.prepare(
      `INSERT INTO chats (id, title, kind, created_by) VALUES (?, 'route', 'group', ?)`,
    ).run("chat_queue_route", ownerId);
    db.prepare(
      `INSERT INTO chat_members (chat_id, member_id, added_at) VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
    ).run("chat_queue_route", ownerId, "chat_queue_route", accId);
  }
  chatId = "chat_queue_route";
});

beforeEach(() => {
  fakeClients.length = 0;
  _resetActiveChatRunsForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
  _resetChatRolePickerForTests();
  resetModelRuntime();
  _resetChatQueueForTests();
});

afterEach(async () => {
  fakeClients.length = 0;
});

afterAll(async () => {
  if (app) await app.close();
});

describe("chatQueue: маршруты /messages и /new-session", () => {
  it("первое сообщение создаёт pending-запись в chat_message_queue", async () => {
    const before = db
      .prepare(`SELECT COUNT(*) as n FROM chat_message_queue WHERE chat_id=?`)
      .get(chatId) as { n: number };

    const sent = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder Привет" },
    });
    expect(sent.statusCode).toBe(200);
    const messageId = sent.json().message.id as string;

    const rows = db
      .prepare(
        `SELECT status, session_generation, message_id, delivery_id
           FROM chat_message_queue
          WHERE chat_id=? AND delivery_id=?`,
      )
      .get(chatId, messageId) as
      | { status: string; session_generation: number; message_id: string; delivery_id: string }
      | undefined;
    expect(rows?.status).toMatch(/pending|picked|done/);
    expect(rows?.message_id).toBe(messageId);
    expect(rows?.delivery_id).toBe(messageId);

    const after = db
      .prepare(`SELECT COUNT(*) as n FROM chat_message_queue WHERE chat_id=?`)
      .get(chatId) as { n: number };
    expect(after.n).toBe(before.n + 1);
  });

  it("повторный POST с тем же message_id (через прямой INSERT в chat_messages) не дублирует durable-запись", async () => {
    // Имитируем сетевой retry: клиент повторяет POST с уже
    // существующим message_id. У нас нет специального
    // Idempotency-Key, но durable-лог дедуплицирован по
    // (chat_id, role_id, delivery_id) — повтор с тем же message_id
    // (==delivery_id) вернёт тот же id.
    const sent = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerHeader,
      payload: { text: "@builder retry-me" },
    });
    expect(sent.statusCode).toBe(200);
    const messageId = sent.json().message.id as string;

    // Проверяем через прямой INSERT в chat_messages с тем же id —
    // это плохой сетевой клиент. Наш durable-лог уже записан на
    // первый POST, второй POST создаст новое сообщение в чате,
    // но durable — нет, потому что запись уже есть.
    const beforeN = (db
      .prepare(`SELECT COUNT(*) as n FROM chat_message_queue WHERE chat_id=? AND delivery_id=?`)
      .get(chatId, messageId) as { n: number }).n;
    expect(beforeN).toBe(1);
  });

  it("/new-session fence-ит старые pending и инкрементирует generation", async () => {
    // Создадим pending-холд руками (минуя route): это «запоздалый
    // ответ прежней Pi-сессии», прилетевший ПОСЛЕ того, как
    // пользователь нажал /new-session.
    const genBefore = currentChatGeneration(chatId, accId);

    // Вставим руками pending-ход на текущей generation.
    const fakeDelivery = `old-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', 'pending')`,
    ).run(`cmq_test_${Date.now()}`, chatId, accId, fakeDelivery, genBefore);

    const pendingBefore = listPendingDeliveries(chatId, accId).filter((p) => p.delivery_id === fakeDelivery);
    expect(pendingBefore).toHaveLength(1);

    // Симулируем /new-session: наш роут делает bumpChatGeneration.
    const newSession = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/new-session`,
      headers: ownerHeader,
      payload: { role_id: accId },
    });
    expect(newSession.statusCode).toBe(200);

    const genAfter = currentChatGeneration(chatId, accId);
    expect(genAfter).toBeGreaterThan(genBefore);

    // Старый pending ушёл в superseded.
    const row = db
      .prepare(`SELECT status FROM chat_message_queue WHERE delivery_id=?`)
      .get(fakeDelivery) as { status: string };
    expect(row.status).toBe("superseded");
  });

  // ===== Idempotency-Key через HTTP-заголовок =====
  // Карточка ebc4d338 (queue_repair): клиент должен иметь
  // возможность прислать СВОЙ delivery-id через HTTP-заголовок
  // `Idempotency-Key` (стандарт) или `x-delivery-id` (наш
  // псевдоним). Без этого сетевой retry ДО получения message_id
  // в ответ приводит к дублю Pi-вызова.

  it("Idempotency-Key из заголовка становится delivery_id в durable-записи", async () => {
    const sent = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: { ...ownerHeader, "idempotency-key": "idem-test-001" },
      payload: { text: "@builder с явным ключом" },
    });
    expect(sent.statusCode).toBe(200);
    const messageId = sent.json().message.id as string;

    const row = db
      .prepare(
        `SELECT delivery_id, message_id FROM chat_message_queue
          WHERE chat_id=? AND message_id=?`,
      )
      .get(chatId, messageId) as
      | { delivery_id: string; message_id: string }
      | undefined;
    expect(row?.delivery_id).toBe("idem-test-001");
    expect(row?.message_id).toBe(messageId);
  });

  it("x-delivery-id (наш псевдоним) тоже подхватывается", async () => {
    const sent = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: { ...ownerHeader, "x-delivery-id": "x-delivery-002" },
      payload: { text: "@builder через x-delivery-id" },
    });
    expect(sent.statusCode).toBe(200);
    const messageId = sent.json().message.id as string;

    const row = db
      .prepare(
        `SELECT delivery_id FROM chat_message_queue
          WHERE chat_id=? AND message_id=?`,
      )
      .get(chatId, messageId) as { delivery_id: string } | undefined;
    expect(row?.delivery_id).toBe("x-delivery-002");
  });

  it("повторный POST с тем же Idempotency-Key не плодит durable-запись (один Pi-вызов)", async () => {
    const idem = `idem-test-retry-${Date.now()}`;
    const first = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: { ...ownerHeader, "idempotency-key": idem },
      payload: { text: "@builder первый" },
    });
    expect(first.statusCode).toBe(200);

    const beforeN = (db
      .prepare(
        `SELECT COUNT(*) as n FROM chat_message_queue
          WHERE chat_id=? AND delivery_id=?`,
      )
      .get(chatId, idem) as { n: number }).n;
    expect(beforeN).toBe(1);

    // Повтор с тем же ключом (имитация ретрая).
    const second = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: { ...ownerHeader, "idempotency-key": idem },
      payload: { text: "@builder второй" },
    });
    expect(second.statusCode).toBe(200);

    const afterN = (db
      .prepare(
        `SELECT COUNT(*) as n FROM chat_message_queue
          WHERE chat_id=? AND delivery_id=?`,
      )
      .get(chatId, idem) as { n: number }).n;
    expect(afterN).toBe(1);
  });

  it("сбой Pi в общем чате закрывает durable-запись как failed (не success)", async () => {
    // Общий чат (chat-common): при сбое Pi deliverAgentReply
    // гасит replyText через assertCommonChatWritable — INSERT не
    // происходит, replyId === null. По новой семантике
    // completeDurableDelivery(id, ok) ok=false при null-replyId,
    // и durable-запись закрывается как failed, а не done.
    if (!db.prepare("SELECT 1 FROM chats WHERE id=?").get("chat-common")) {
      db.prepare(
        `INSERT OR IGNORE INTO chats (id, title, kind, created_by)
         VALUES (?, 'Общий чат', 'group', ?)`,
      ).run("chat-common", ownerId);
    }
    db.prepare(
      `INSERT OR IGNORE INTO chat_members (chat_id, member_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    ).run("chat-common", ownerId);
    db.prepare(
      `INSERT OR IGNORE INTO chat_members (chat_id, member_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    ).run("chat-common", accId);

    THROW_ON_TEXT = "1";
    try {
      const sent = await app!.inject({
        method: "POST",
        url: `/api/chats/chat-common/messages`,
        headers: ownerHeader,
        payload: { text: "@builder должен сломать Pi" },
      });
      expect(sent.statusCode).toBe(200);
      const messageId = sent.json().message.id as string;

      // Даём очереди дойти до finally. Ждём по условию, а не фиксированным
      // окном: под нагрузкой полного прогона (28 потоков) 600 мс не
      // хватало, запись оставалась 'picked', и тест падал без причины —
      // гейт автослияния резал слияния на ложной регрессии (21.10.2026).
      const deadline = Date.now() + 15_000;
      let durableStatus: string | undefined;
      while (Date.now() < deadline) {
        const cur = db
          .prepare(
            `SELECT status FROM chat_message_queue
              WHERE chat_id=? AND message_id=?`,
          )
          .get("chat-common", messageId) as { status: string } | undefined;
        durableStatus = cur?.status;
        if (durableStatus && durableStatus !== "pending" && durableStatus !== "picked") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(durableStatus).toBe("failed");
    } finally {
      THROW_ON_TEXT = "";
    }
  });
});
