// Сторож доставок сообщений ролям: упавший ход поднимается заново, а
// висящий вопрос не остаётся без ответа (владелец 23.10.2026).
//
// Покрывает:
//   1. Ход роли упал (Pi-сбой) — доставка поднимается заново тем же
//      путём, что и живое сообщение, и вопрос получает ответ.
//   2. Доставка, истёкшая по TTL (помечена `expired`), не поднимается:
//      вопрос по ней неактуален.
//   3. Попытки исчерпаны — владельцу уходит уведомление, и второй
//      проход не дублирует его.
//   4. Вопрос висит (роль не работает по карточке) — владельцу уходит
//      пинг; свежий вопрос не пинается; работающая роль не пинается.
//
// Pi-моки выставлены так же, как в chatQueueRecovery.test.ts: проверяем
// серверную часть очереди без реальных вызовов модели.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { _resetChatQueueForTests } from "../src/runtime/chatQueue.js";
import {
  _resetChatRoleLocksForTests,
  _resetChatRoleQueuesForTests,
} from "../src/runtime/chatSession.js";
import {
  sweepFailedDeliveries,
  sweepStalledDeliveries,
  DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE,
  DELIVERY_STALLED_NOTICE_TYPE,
} from "../src/runtime/chatDeliveryWatch.js";
import { _resetActiveChatRunsForTests } from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

const fakeClients: any[] = [];

const CATALOG = liveRoutingCatalog();
const PROVIDERS = liveRoutingProviders();
const PRIMARY = liveCatalogEntryOf("qa");

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
    createAgentSession: vi.fn(async () => {
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

const ROLE_USER = "role_builder";
const OWNER_USER = "owner_delivery_watch_test";
const CHAT_ID = "chat_delivery_watch_test";
const TASK_ID = "task_delivery_watch_test";

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(OWNER_USER)) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Test Delivery Owner', ?, '!t', 'owner', 'human')`,
    ).run(OWNER_USER, `delivery-watch-${OWNER_USER}@test`);
  }
  if (!db.prepare("SELECT 1 FROM chats WHERE id=?").get(CHAT_ID)) {
    db.prepare(
      `INSERT INTO chats (id, title, kind, created_by) VALUES (?, 'Delivery watch chat', 'group', ?)`,
    ).run(CHAT_ID, OWNER_USER);
    db.prepare(
      `INSERT INTO chat_members (chat_id, member_id, added_at) VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
    ).run(CHAT_ID, OWNER_USER, CHAT_ID, ROLE_USER);
  }
  if (!db.prepare("SELECT 1 FROM tasks WHERE id=?").get(TASK_ID)) {
    db.prepare(
      `INSERT INTO tasks (id, title, status, creator_id) VALUES (?, 'Карточка для висящего вопроса', 'active', ?)`,
    ).run(TASK_ID, OWNER_USER);
  }
});

beforeEach(() => {
  fakeClients.length = 0;
  _resetActiveChatRunsForTests();
  _resetChatRolePickerForTests();
  _resetChatQueueForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
  db.prepare("DELETE FROM notifications WHERE type IN (?,?)").run(
    DELIVERY_STALLED_NOTICE_TYPE,
    DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE,
  );
});

afterAll(async () => {
  if (app) await app.close();
});

/** Триггерное сообщение — без него Pi-вызову нечего отвечать. */
function insertTrigger(id: string, text: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO chat_messages (id, from_user_id, text, channel, chat_id)
     VALUES (?, ?, ?, 'chat', ?)`,
  ).run(id, OWNER_USER, text, CHAT_ID);
}

function insertDelivery(options: {
  id: string;
  messageId: string;
  status: string;
  payload?: string;
  ageMinutes?: number;
}): void {
  const age = options.ageMinutes ?? 30;
  db.prepare(
    `INSERT OR REPLACE INTO chat_message_queue
       (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now', ?), datetime('now', ?))`,
  ).run(
    options.id,
    CHAT_ID,
    ROLE_USER,
    options.id,
    options.messageId,
    options.payload ?? "{}",
    options.status,
    `-${age} minutes`,
    `-${age} minutes`,
  );
}

describe("chatDeliveryWatch: упавший ход", () => {
  it("ход, упавший после сбоя, поднимается заново и вопрос получает ответ", async () => {
    const triggerId = "cmg_retry_trigger";
    insertTrigger(triggerId, "вопрос роли, который остался без ответа");
    insertDelivery({ id: "cmq_retry_1", messageId: triggerId, status: "failed" });

    const report = await sweepFailedDeliveries({ minAgeMinutes: 1 });

    expect(report.retried).toBe(1);
    const row = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get("cmq_retry_1") as { status: string };
    expect(row.status).toBe("done");
    const reply = db
      .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE chat_id=? AND reply_to_message_id=?")
      .get(CHAT_ID, triggerId) as { c: number };
    expect(reply.c).toBeGreaterThan(0);
  });

  it("доставка, истёкшая по TTL, не поднимается заново", async () => {
    const triggerId = "cmg_expired_trigger";
    insertTrigger(triggerId, "вопрос по истёкшей доставке");
    insertDelivery({
      id: "cmq_expired_1",
      messageId: triggerId,
      status: "failed",
      payload: JSON.stringify({ expired: 1 }),
    });

    const report = await sweepFailedDeliveries({ minAgeMinutes: 1 });

    expect(report.retried).toBe(0);
    const row = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get("cmq_expired_1") as { status: string };
    expect(row.status).toBe("failed");
  });

  it("после исчерпания попыток владельцу уходит уведомление, и повтор его не дублирует", async () => {
    const triggerId = "cmg_exhausted_trigger";
    insertTrigger(triggerId, "вопрос, на который роль не ответила");
    insertDelivery({
      id: "cmq_exhausted_1",
      messageId: triggerId,
      status: "failed",
      payload: JSON.stringify({ retryCount: 3 }),
    });

    const first = await sweepFailedDeliveries({ minAgeMinutes: 1, maxAttempts: 3 });
    expect(first.exhausted).toBe(1);
    const notices = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE type=? AND user_id=?")
      .get(DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE, OWNER_USER) as { c: number };
    expect(notices.c).toBe(1);

    const second = await sweepFailedDeliveries({ minAgeMinutes: 1, maxAttempts: 3 });
    expect(second.exhausted).toBe(0);
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE type=? AND user_id=?")
      .get(DELIVERY_RETRY_EXHAUSTED_NOTICE_TYPE, OWNER_USER) as { c: number };
    expect(after.c).toBe(1);
  });
});

describe("chatDeliveryWatch: висящий вопрос", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM subtasks WHERE task_id=?").run(TASK_ID);
    db.prepare("DELETE FROM role_run_jobs WHERE task_id=?").run(TASK_ID);
  });

  it("вопрос, который ждёт неработающую роль, уходит владельцу в уведомления", () => {
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, agent_id, agent_state, done)
       VALUES (?, ?, 'Слот вопроса', ?, 'done', 1)`,
    ).run("sub_stalled_1", TASK_ID, ROLE_USER);
    db.prepare(
      `INSERT OR REPLACE INTO chats (id, title, kind, created_by, task_id)
       VALUES (?, 'Чат карточки', 'group', ?, ?)`,
    ).run(CHAT_ID, OWNER_USER, TASK_ID);
    const triggerId = "cmg_stalled_trigger";
    insertTrigger(triggerId, "@builder [slot: implementation_pack] Уточняющий вопрос по этапу");
    insertDelivery({ id: "cmq_stalled_1", messageId: triggerId, status: "pending" });

    const report = sweepStalledDeliveries({ minAgeMinutes: 1 });

    expect(report.stalled).toBe(1);
    expect(report.notified).toBe(1);
    const notice = db
      .prepare("SELECT text FROM notifications WHERE type=? AND user_id=?")
      .get(DELIVERY_STALLED_NOTICE_TYPE, OWNER_USER) as { text: string } | undefined;
    expect(notice?.text).toContain("Уточняющий вопрос по этапу");
  });

  it("свежий вопрос не пинается", () => {
    db.prepare(
      `INSERT OR REPLACE INTO chats (id, title, kind, created_by, task_id)
       VALUES (?, 'Чат карточки', 'group', ?, ?)`,
    ).run(CHAT_ID, OWNER_USER, TASK_ID);
    const triggerId = "cmg_fresh_trigger";
    insertTrigger(triggerId, "@builder [slot: implementation_pack] Свежий вопрос");
    insertDelivery({ id: "cmq_fresh_1", messageId: triggerId, status: "pending", ageMinutes: 1 });

    const report = sweepStalledDeliveries({ minAgeMinutes: 20 });

    expect(report.notified).toBe(0);
  });

  it("роль, которая работает по карточке, не пинается", () => {
    db.prepare(
      `INSERT INTO subtasks (id, task_id, title, agent_id, agent_state, done)
       VALUES (?, ?, 'Слот в работе', ?, 'in_progress', 0)`,
    ).run("sub_working_1", TASK_ID, ROLE_USER);
    db.prepare(
      `INSERT OR REPLACE INTO chats (id, title, kind, created_by, task_id)
       VALUES (?, 'Чат карточки', 'group', ?, ?)`,
    ).run(CHAT_ID, OWNER_USER, TASK_ID);
    const triggerId = "cmg_working_trigger";
    insertTrigger(triggerId, "@builder [slot: implementation_pack] Вопрос в работу");
    insertDelivery({ id: "cmq_working_1", messageId: triggerId, status: "pending" });

    const report = sweepStalledDeliveries({ minAgeMinutes: 1 });

    expect(report.stalled).toBe(0);
    expect(report.notified).toBe(0);
  });
});
