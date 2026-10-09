// Тесты durable-очереди сообщений роли и generation fence.
//
// Покрывает четыре требования приёмки карточки ebc4d338 (queue):
//   1. Идемпотентность по delivery_id (повторный POST — тот же id).
//   2. Pending-холды переживают рестарт in-memory очереди (в тесте —
//      моделируем рестарт повторным вызовом `allPendingDeliveries`).
//   3. Fence при смене generation: pending-ходы старой generation
//      переходят в `superseded`, новый ход пишется на свежей.
//   4. Цепочка `claim → finish` отмечает ход как `done` (или
//      `failed`), `fence` поверх `picked` тоже работает.
//
// Тесты пишут в реальную in-memory SQLite-БД через `db.ts`, как и сам
// сервер; миграции накатываются автоматически при импорте.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  enqueueMessageDelivery,
  pendingMessageDeliveries,
  allPendingDeliveries,
  claimMessageDelivery,
  finishMessageDelivery,
  fenceMessageDelivery,
  bumpChatGeneration,
  currentChatGeneration,
  _resetChatQueueForTests,
} from "../src/runtime/chatQueue.js";

interface PrincipalRef { id: string }
const ACCOUNT: PrincipalRef = { id: "role_builder_queue_test" };
const USER_OTHER: PrincipalRef = { id: "owner_queue_test" };

interface ChatRef { id: string }

let app: FastifyInstance | undefined;

beforeAll(async () => {
  app = await buildApp();
  // Минимальный мир для FK.
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, role, type, email, password_hash, is_system_bot)
     VALUES (?, ?, 'agent', 'ai', ?, '!t', 1)`,
  ).run(ACCOUNT.id, "Test Builder", `chat-queue-test-${ACCOUNT.id}@test`);
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, password_hash, role, type)
     VALUES (?, 'Test Owner', ?, '!t', 'owner', 'human')`,
  ).run(USER_OTHER.id, `chat-queue-test-${USER_OTHER.id}@test`);
  db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, 'Chat 1', 'group', ?)",
  ).run("chat_test_1", USER_OTHER.id);
  db.prepare(
    `INSERT OR IGNORE INTO chat_members (chat_id, member_id, added_at)
     VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
  ).run("chat_test_1", USER_OTHER.id, "chat_test_1", ACCOUNT.id);
  db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, 'Chat 2', 'group', ?)",
  ).run("chat_test_2", USER_OTHER.id);
  db.prepare(
    `INSERT OR IGNORE INTO chat_members (chat_id, member_id, added_at)
     VALUES (?, ?, datetime('now')), (?, ?, datetime('now'))`,
  ).run("chat_test_2", USER_OTHER.id, "chat_test_2", ACCOUNT.id);
});

afterAll(async () => {
  _resetChatQueueForTests();
  if (app) await app.close();
});

beforeEach(() => {
  _resetChatQueueForTests();
});

const CHAT: ChatRef = { id: "chat_test_1" };

describe("chat_queue: идемпотентность delivery_id", () => {
  it("один и тот же delivery_id возвращает ранее записанный id без дубля", () => {
    const first = enqueueMessageDelivery({
      chatId: CHAT.id,
      roleId: ACCOUNT.id,
      deliveryId: "msg-A",
      payload: { text: "первый" },
    });
    expect(first.created).toBe(true);

    const second = enqueueMessageDelivery({
      chatId: CHAT.id,
      roleId: ACCOUNT.id,
      deliveryId: "msg-A",
      payload: { text: "повтор" },
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    // Записей в чате с delivery_id=msg-A ровно одна.
    const rows = db
      .prepare(
        `SELECT COUNT(*) as n FROM chat_message_queue
          WHERE chat_id=? AND role_id=? AND delivery_id=?`,
      )
      .get(CHAT.id, ACCOUNT.id, "msg-A") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("delivery_id уникален только в пределах (chat, role)", () => {
    enqueueMessageDelivery({
      chatId: CHAT.id,
      roleId: ACCOUNT.id,
      deliveryId: "msg-B",
      payload: { text: "builder" },
    });
    // Та же delivery_id в другом чате — допустимо (другая пара).
    const r = enqueueMessageDelivery({
      chatId: "chat_test_2",
      roleId: ACCOUNT.id,
      deliveryId: "msg-B",
      payload: { text: "тот же delivery_id, другой чат" },
    });
    expect(r.created).toBe(true);
  });
});

describe("chat_queue: pending-холды выживают «рестарт очереди»", () => {
  it("pendingMessageDeliveries возвращает всё, что записано до отказа", () => {
    enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "p-1", payload: { text: "1" },
    });
    enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "p-2", payload: { text: "2" },
    });
    enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "p-3", payload: { text: "3" },
    });

    // Имитируем рестарт in-memory очереди: «после падения» сервер
    // запрашивает durable-список. Должен увидеть все три хода в
    // порядке создания.
    const pending = pendingMessageDeliveries({ chatId: CHAT.id, roleId: ACCOUNT.id });
    expect(pending.map((p) => p.delivery_id)).toEqual(["p-1", "p-2", "p-3"]);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
  });

  it("allPendingDeliveries возвращает ходы по всем парам (для post-recovery sweep)", () => {
    enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "g-1", payload: { text: "1" },
    });
    enqueueMessageDelivery({
      chatId: "chat_test_2", roleId: ACCOUNT.id, deliveryId: "g-2", payload: { text: "2" },
    });
    const all = allPendingDeliveries();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ids = all.map((p) => p.delivery_id).sort();
    expect(ids).toContain("g-1");
    expect(ids).toContain("g-2");
  });
});

describe("chat_queue: claim → finish и fence", () => {
  it("claim → finish: pending → picked → done", () => {
    const r = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "cl-1", payload: { text: "cl" },
    });
    expect(claimMessageDelivery(r.id)).toBe(true);
    expect(finishMessageDelivery(r.id, true)).toBe(true);
    const row = db
      .prepare("SELECT status, finished_at FROM chat_message_queue WHERE id=?")
      .get(r.id) as { status: string; finished_at: string | null };
    expect(row.status).toBe("done");
    expect(row.finished_at).not.toBeNull();
  });

  it("finish с ok=false ставит status=failed", () => {
    const r = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "cl-2", payload: { text: "cl" },
    });
    claimMessageDelivery(r.id);
    finishMessageDelivery(r.id, false);
    const row = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get(r.id) as { status: string };
    expect(row.status).toBe("failed");
  });

  it("повторный claim одного и того же id возвращает false", () => {
    const r = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "cl-3", payload: { text: "cl" },
    });
    expect(claimMessageDelivery(r.id)).toBe(true);
    expect(claimMessageDelivery(r.id)).toBe(false);
  });

  it("fence поверх picked переводит в superseded", () => {
    const r = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "fe-1", payload: { text: "fe" },
    });
    claimMessageDelivery(r.id);
    expect(fenceMessageDelivery(r.id)).toBe(true);
    const row = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get(r.id) as { status: string };
    expect(row.status).toBe("superseded");
  });
});

describe("chat_queue: generation fence", () => {
  it("bumpChatGeneration инкрементирует generation и fence-ит старые pending", () => {
    // До первого бампа generation пары = 1 по дефолту
    // (никаких строк в chat_session_generation ещё нет, функция
    // возвращает 1 — это сигнал «первое поколение»).
    const before = currentChatGeneration(CHAT.id, ACCOUNT.id);
    expect(before).toBe(1);

    const r1 = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "gen-1", payload: { text: "старый" },
    });
    expect(r1.generation).toBe(1);

    // Меняем поколение (имитация /new-session).
    const bump = bumpChatGeneration({ chatId: CHAT.id, roleId: ACCOUNT.id, reason: "test_bump" });
    expect(bump.generation).toBe(2);
    expect(bump.superseded).toBe(1);

    const oldRow = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get(r1.id) as { status: string };
    expect(oldRow.status).toBe("superseded");

    // Новый ход после бампа идёт на generation=2.
    const r2 = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "gen-2", payload: { text: "свежий" },
    });
    expect(r2.generation).toBe(2);
    expect(currentChatGeneration(CHAT.id, ACCOUNT.id)).toBe(2);
  });

  it("bump без task_id не падает и корректно fence-ит старые pending", () => {
    // Даже если у чата НЕТ task_id (старый тест создаёт task здесь
    // только для лога), bump должен fence-ить старые pending и не
    // падать. Поведение записи в task_events покрыто в общем
    // пути «если задача есть — пишем событие, иначе молча».
    const r1 = enqueueMessageDelivery({
      chatId: CHAT.id, roleId: ACCOUNT.id, deliveryId: "ev-1", payload: { text: "x" },
    });
    // Чат без task_id — отметка в task_events будет пропущена, но
    // сам бамп и fence работают.
    const beforeCurrent = currentChatGeneration(CHAT.id, ACCOUNT.id);
    const res = bumpChatGeneration({
      chatId: CHAT.id, roleId: ACCOUNT.id, reason: "owner_event_test",
    });
    expect(res.generation).toBe(beforeCurrent + 1);
    expect(res.superseded).toBe(1);

    const oldRow = db
      .prepare("SELECT status FROM chat_message_queue WHERE id=?")
      .get(r1.id) as { status: string };
    expect(oldRow.status).toBe("superseded");
  });

  it("bump для чата С task_id пишет chat_session_bump в task_events", () => {
    // Создадим минимальный task для лога, не трогая projects (он не
    // требуется для task_events — только task_id и шесть полей).
    const TASK_ID = "task_test_chat_bump";
    if (!db.prepare("SELECT 1 FROM tasks WHERE id=?").get(TASK_ID)) {
      db.prepare(
        `INSERT INTO tasks(id, title, creator_id, agent_state, created_at, updated_at)
         VALUES (?, 'bump test', ?, 'todo', datetime('now'), datetime('now'))`,
      ).run(TASK_ID, USER_OTHER.id);
    }
    db.prepare("UPDATE chats SET task_id=? WHERE id=?").run(TASK_ID, CHAT.id);

    bumpChatGeneration({ chatId: CHAT.id, roleId: ACCOUNT.id, reason: "events_check" });
    const rows = db
      .prepare(
        `SELECT kind, to_value FROM task_events
          WHERE task_id=? AND kind='chat_session_bump'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(TASK_ID) as
      | { kind: string; to_value: string | null }
      | undefined;
    expect(rows?.kind).toBe("chat_session_bump");
    expect(rows?.to_value).toMatch(/gen=/);
  });
});
