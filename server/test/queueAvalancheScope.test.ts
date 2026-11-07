// Доработка правки очереди ролей (карточка 568a2b93, доработка 1).
//
// Два замечания проверяющей по правке d2789497:
//
//   1. Свёртка лавины узнавала только три вида ключей заданий
//      (`stalled-restart`, `review`, `ready`). Задания с ключами других видов
//      (продолжение захода `after-run`, реакция на комментарий `comment`,
//      ручной запуск `manual-start`, проверка узла плана `plan-review`)
//      в очереди оставались. Теперь свёртка понимает все виды.
//
//   2. Часовой порог срока жизни доставки помечал неуспешной доставку
//      легитимного долгого хода роли, который ещё работает. Теперь такая
//      доставка не просрочивается, пока ход роли жив.
//
// Проверяем на настоящей схеме БД: поднимаем приложение (миграции),
// сеем роли и карточки.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { collapseDuplicateQueuedJobs } from "../src/runtime/roleRunQueue.js";
import { expireStaleDeliveries } from "../src/runtime/chatQueueRecovery.js";
import {
  acquireChatRoleLock,
  releaseChatRoleLock,
} from "../src/runtime/chatSession.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const OWNER_USER = "owner_scope_test";
const ROLE_USER = "role_qa";
const CHAT_ID = "chat_scope_test";

let app: FastifyInstance;

function seedOwner(): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
     VALUES (?, 'Scope Owner', ?, '!t', 'owner', 'human')`,
  ).run(OWNER_USER, `scope-${OWNER_USER}@test`);
}

function seedTask(taskId: string): void {
  seedOwner();
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, creator_id) VALUES (?, 'Свертка лавины', ?)`,
  ).run(taskId, OWNER_USER);
}

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  seedOwner();
  db.prepare(
    `INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, 'Scope chat', 'group', ?)`,
  ).run(CHAT_ID, OWNER_USER);
});

beforeEach(() => {
  db.prepare("DELETE FROM role_run_jobs WHERE task_id LIKE 'scope_task_%'").run();
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE id LIKE 'scope_task_%'").run();
});

afterAll(async () => {
  db.prepare("DELETE FROM role_run_jobs WHERE task_id LIKE 'scope_task_%'").run();
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE id LIKE 'scope_task_%'").run();
  if (app) await app.close();
});

function insertJob(id: string, taskId: string, dedupeKey: string, reason = "after_run"): void {
  db.prepare(
    `INSERT INTO role_run_jobs (id, task_id, reason, dedupe_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', datetime('now'), datetime('now'))`,
  ).run(id, taskId, reason, dedupeKey);
}

function queuedKeys(taskId: string): string[] {
  return (
    db
      .prepare(
        "SELECT dedupe_key FROM role_run_jobs WHERE task_id = ? AND status = 'queued' ORDER BY id",
      )
      .all(taskId) as Array<{ dedupe_key: string }>
  ).map((row) => row.dedupe_key);
}

describe("свёртка лавины: все виды ключей заданий", () => {
  it("продолжение захода одной карточки сворачивается в одно задание", () => {
    const taskId = "scope_task_after_run";
    seedTask(taskId);
    // Старый формат ключа: идентификатор захода менялся от тика к тику.
    insertJob("rrj_ar_1", taskId, "after-run:run-1");
    insertJob("rrj_ar_2", taskId, "after-run:run-2");
    insertJob("rrj_ar_3", taskId, "after-run:run-3");

    expect(collapseDuplicateQueuedJobs()).toBe(2);
    expect(queuedKeys(taskId)).toEqual(["after-run:run-3"]);
  });

  it("продолжения захода РАЗНЫХ карточек не склеиваются", () => {
    const first = "scope_task_after_a";
    const second = "scope_task_after_b";
    seedTask(first);
    seedTask(second);
    insertJob("rrj_ar_a", first, "after-run:run-a");
    insertJob("rrj_ar_b", second, "after-run:run-b");

    expect(collapseDuplicateQueuedJobs()).toBe(0);
    expect(queuedKeys(first)).toHaveLength(1);
    expect(queuedKeys(second)).toHaveLength(1);
  });

  it("реакции на комментарии одной карточки сворачиваются в одно задание", () => {
    const taskId = "scope_task_comment";
    seedTask(taskId);
    insertJob("rrj_c_1", taskId, "comment:c-1", "commented");
    insertJob("rrj_c_2", taskId, "comment:c-2", "commented");

    expect(collapseDuplicateQueuedJobs()).toBe(1);
    expect(queuedKeys(taskId)).toEqual(["comment:c-2"]);
  });

  it("ручные запуски одной карточки сворачиваются в одно задание", () => {
    const taskId = "scope_task_manual";
    seedTask(taskId);
    insertJob("rrj_m_1", taskId, "manual-start:card-1:uuid-1", "assigned");
    insertJob("rrj_m_2", taskId, "manual-start:card-1:uuid-2", "assigned");

    expect(collapseDuplicateQueuedJobs()).toBe(1);
    expect(queuedKeys(taskId)).toEqual(["manual-start:card-1:uuid-2"]);
  });

  it("проверки ОДНОГО узла плана сворачиваются, разные узлы — нет", () => {
    const taskId = "scope_task_plan_review";
    seedTask(taskId);
    insertJob("rrj_pr_1", taskId, "plan-review:plan-1:node-1:v1", "review");
    insertJob("rrj_pr_2", taskId, "plan-review:plan-1:node-1:v1:r1", "review");
    insertJob("rrj_pr_3", taskId, "plan-review:plan-1:node-2:v1", "review");

    expect(collapseDuplicateQueuedJobs()).toBe(1);
    const keys = queuedKeys(taskId);
    expect(keys).toHaveLength(2);
    expect(keys).toContain("plan-review:plan-1:node-2:v1");
    expect(keys.some((key) => key.startsWith("plan-review:plan-1:node-1"))).toBe(true);
  });
});

describe("срок жизни доставки: живой ход роли не выбрасывается", () => {
  function insertDelivery(id: string, status: string, updatedAt: string): void {
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, session_generation, payload_json, status, updated_at)
       VALUES (?, ?, ?, ?, 1, '{}', ?, ?)`,
    ).run(id, CHAT_ID, ROLE_USER, id, status, updatedAt);
  }

  it("доставка, которую роль ещё разбирает, не просрочивается", () => {
    insertDelivery("cmq_busy_picked", "picked", "2020-01-01 00:00:00");
    // Роль занята этой парой (чат, роль) — ход идёт прямо сейчас.
    acquireChatRoleLock(CHAT_ID, ROLE_USER);
    try {
      expect(expireStaleDeliveries(60)).toBe(0);
      const row = db
        .prepare("SELECT status FROM chat_message_queue WHERE id='cmq_busy_picked'")
        .get() as { status: string };
      expect(row.status).toBe("picked");
    } finally {
      releaseChatRoleLock(CHAT_ID, ROLE_USER);
    }
  });

  it("после завершения хода роли просроченная доставка закрывается", () => {
    insertDelivery("cmq_dead_picked", "picked", "2020-01-01 00:00:00");
    insertDelivery("cmq_dead_pending", "pending", "2020-01-01 00:00:00");

    expect(expireStaleDeliveries(60)).toBe(2);
    const status = (id: string): string =>
      (db.prepare("SELECT status FROM chat_message_queue WHERE id=?").get(id) as { status: string })
        .status;
    expect(status("cmq_dead_picked")).toBe("failed");
    expect(status("cmq_dead_pending")).toBe("failed");
  });
});
