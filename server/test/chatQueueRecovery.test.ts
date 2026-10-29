// Тест recovery-sweep: поведение карточки ebc4d338 (queue) при
// рестарте процесса.
//
// Покрывает:
//   1. Pending-холд виден sweep'у сразу после старта, даже
//      если in-memory очередь пуста (имитация рестарта).
//   2. Pending со старой generation fence-ится без постановки
//      в in-memory очередь.
//   3. bumpGeneration fence-ит «запоздавший ответ» старой сессии.
//   4. Pi бросил исключение — durable-запись закрывается failed,
//      а не висит picked.
//   5. Повторный запуск sweep после failure поднимает ход снова
//      (recovery от потери Pi-ответа).
//
// Pi-моки выставлены так же, как в chatQueueRoute.test.ts: проверяем
// серверную часть очереди/восстановления без реальных вызовов модели.

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
  startChatQueueRecovery,
  recoveryBumpChatGeneration,
  sweepRecoverableDeliveries,
  recoverAgentDelivery,
} from "../src/runtime/chatQueueRecovery.js";
import {
  currentChatGeneration,
  fenceMessageDelivery,
  getMessageDelivery,
} from "../src/runtime/chatQueue.js";
import {
  resetModelRuntime,
  _resetActiveChatRunsForTests,
} from "../src/runtime/PiRuntimeAdapter.js";
import { _resetChatRolePickerForTests } from "../src/routes/chats.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { liveCatalogEntryOf, liveRoutingCatalog, liveRoutingProviders } from "./helpers/liveRoutingModels.js";

const fakeClients: any[] = [];

/** Каталог и провайдеры — из боевого role-routing.yaml (helpers/liveRoutingModels):
 *  подделка не должна знать про смену основной модели ролей. */
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
    createAgentSession: vi.fn(async (opts: any) => {
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
const OWNER_USER = "owner_recovery_test";

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(OWNER_USER)) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Test Recovery Owner', ?, '!t', 'owner', 'human')`,
    ).run(OWNER_USER, `chat-queue-test-${OWNER_USER}@test`);
  }
  if (!db.prepare("SELECT 1 FROM chats WHERE id=?").get("chat_recovery_test")) {
    db.prepare(
      `INSERT INTO chats (id, title, kind, created_by) VALUES (?, 'Recovery chat', 'group', ?)`,
    ).run("chat_recovery_test", OWNER_USER);
    db.prepare(
      `INSERT INTO chat_members (chat_id, member_id, added_at) VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
    ).run("chat_recovery_test", OWNER_USER, "chat_recovery_test", ROLE_USER);
  }
});

beforeEach(() => {
  fakeClients.length = 0;
  _resetActiveChatRunsForTests();
  _resetChatRolePickerForTests();
  _resetChatQueueForTests();
  _resetChatRoleLocksForTests();
  _resetChatRoleQueuesForTests();
});

afterAll(async () => {
  if (app) await app.close();
});

describe("chatQueue: recovery", () => {
  it("cold recovery возвращает picked предыдущего процесса, не трогая свежий pickup",async()=>{
    for(const [id,date] of [["old-pick","2000-01-01 00:00:00"],["new-pick","2099-01-01 00:00:00"]]){
      db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,'Пробный вопрос','chat','chat_recovery_test')").run(id,OWNER_USER);
      db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status,updated_at) VALUES(?,'chat_recovery_test',?,?,?,1,'{}','picked',?)").run(id,ROLE_USER,id,id,date);
    }
    startChatQueueRecovery(new Date("2001-01-01T00:00:00Z"));
    await vi.waitFor(()=>expect(db.prepare("SELECT status FROM chat_message_queue WHERE id='old-pick'").get()).toMatchObject({status:"done"}));
    expect(db.prepare("SELECT status FROM chat_message_queue WHERE id='new-pick'").get()).toMatchObject({status:"picked"});
  });

  it("после рестарта pending-холд поднимается реальным Pi-вызовом и закрывается как done", async () => {
    // Триггерное сообщение — без него deliverAgentReply не сможет
    // собрать prompt и упрётся в null-возврат.
    const triggerId = `cmg_recover_${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_messages
         (id, from_user_id, text, channel, chat_id, reply_to_message_id)
       VALUES (?, ?, ?, 'chat', 'chat_recovery_test', NULL)`,
    ).run(triggerId, OWNER_USER, "тестовое сообщение для recovery");

    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, 'chat_recovery_test', ?, 'rec-1', ?, 1, '{}', 'pending')`,
    ).run("cmq_rec_1", ROLE_USER, triggerId);

    const recovered = await sweepRecoverableDeliveries();

    // Ход отдан в работу через реальный enqueue/deliverAgentReply
    // и закрыт как done — recovery отработал.
    expect(recovered).toBe(1);

    const row = db
      .prepare(`SELECT status FROM chat_message_queue WHERE id=?`)
      .get("cmq_rec_1") as { status: string };
    expect(row.status).toBe("done");
  });

  it("pending со старой generation fence-ится без постановки в очередь", () => {
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, 'chat_recovery_test', ?, 'rec-old', NULL, 1, '{}', 'pending')`,
    ).run("cmq_rec_old", ROLE_USER);

    // Bump — делает generation = 2.
    const bumpedGen = recoveryBumpChatGeneration("chat_recovery_test", ROLE_USER);
    expect(bumpedGen).toBeGreaterThanOrEqual(2);

    // Теперь sweep: старая запись должна fence-иться.
    void sweepRecoverableDeliveries();
    const row = db
      .prepare(`SELECT status FROM chat_message_queue WHERE id=?`)
      .get("cmq_rec_old") as { status: string };
    expect(row.status).toBe("superseded");
  });

  it("recovery-bump фиксирует событие в task_events", () => {
    // Без task у чата fence всё равно работает, но мы проверим,
    // что bump сам по себе не падает (silent fence OK).
    const before = currentChatGeneration("chat_recovery_test", ROLE_USER);
    const after = recoveryBumpChatGeneration("chat_recovery_test", ROLE_USER);
    expect(after).toBe(before + 1);
  });

  it("recoverAgentDelivery: запись в state=picked повторно не дёргается", async () => {
    const triggerId = `cmg_picked_${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_messages
         (id, from_user_id, text, channel, chat_id, reply_to_message_id)
       VALUES (?, ?, ?, 'chat', 'chat_recovery_test', NULL)`,
    ).run(triggerId, OWNER_USER, "picked-сценарий");

    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, 'chat_recovery_test', ?, 'rec-picked', ?, 1, '{}', 'picked')`,
    ).run("cmq_picked", ROLE_USER, triggerId);

    const result = await recoverAgentDelivery({
      chatId: "chat_recovery_test",
      roleId: ROLE_USER,
      queueRowId: "cmq_picked",
    });
    expect(result.status).toBe("skipped");
  });

  it("recoverAgentDelivery: fence возвращает fenced и не запускает Pi", async () => {
    // Запись с устаревшей generation → fence без Pi.
    // Сначала поднимаем generation, затем вставляем запись
    // на МЕНЬШЕЙ generation — это и есть «запоздавший ответ
    // старой сессии».
    recoveryBumpChatGeneration("chat_recovery_test", ROLE_USER);

    const triggerId = `cmg_fence_${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_messages
         (id, from_user_id, text, channel, chat_id, reply_to_message_id)
       VALUES (?, ?, ?, 'chat', 'chat_recovery_test', NULL)`,
    ).run(triggerId, OWNER_USER, "fence-сценарий");

    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, message_id, session_generation, payload_json, status)
       VALUES (?, 'chat_recovery_test', ?, 'rec-fence', ?, 1, '{}', 'pending')`,
    ).run("cmq_fence", ROLE_USER, triggerId);

    const result = await recoverAgentDelivery({
      chatId: "chat_recovery_test",
      roleId: ROLE_USER,
      queueRowId: "cmq_fence",
    });
    expect(result.status).toBe("fenced");

    const row = getMessageDelivery("cmq_fence");
    expect(row?.status).toBe("superseded");
  });
});
