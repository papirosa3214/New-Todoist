// Лавина в очереди ролей и мёртвые доставки в очереди чата (карточка
// 568a2b93, 21.10.2026).
//
// Проверяем три вещи:
//   1. накопившиеся дубли заданий очереди ролей сворачиваются в одно
//      задание на намерение (по группе «шаг»/«карточка»);
//   2. доставка очереди чата, которую никто не забрал, получает срок жизни:
//      старше порога — терминальный статус, и сторож выкладки её больше
//      не считает занятостью;
//   3. сторож выкладки (scripts/deploy-when-idle.py) считает занятыми только
//      ЖИВЫЕ доставки — мёртвая доставка не держит выкладку main.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import {
  collapseDuplicateQueuedJobs,
  roleRunJobGroup,
} from "../src/runtime/roleRunQueue.js";
import {
  chatDeliveryLeaseMinutes,
  chatDeliveryMaxReclaims,
  chatDeliveryTtlMinutes,
  expireStaleDeliveries,
  reclaimStalePickedDeliveries,
} from "../src/runtime/chatQueueRecovery.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const OWNER_USER = "owner_avalanche_test";
const ROLE_USER = "role_qa";
const CHAT_ID = "chat_avalanche_test";

function seedTask(taskId: string): void {
  seedOwner();
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, creator_id) VALUES (?, 'Лавина очереди ролей', ?)`,
  ).run(taskId, OWNER_USER);
}

function seedOwner(): void {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
     VALUES (?, 'Avalanche Owner', ?, '!t', 'owner', 'human')`,
  ).run(OWNER_USER, `avalanche-${OWNER_USER}@test`);
}

function seedChat(): void {
  seedOwner();
  db.prepare(
    `INSERT OR IGNORE INTO chats (id, title, kind, created_by) VALUES (?, 'Avalanche chat', 'group', ?)`,
  ).run(CHAT_ID, OWNER_USER);
}

let app: FastifyInstance;

beforeAll(async () => {
  // Схема БД создаётся при подъёме приложения (миграции) — без него
  // таблиц очередей ещё нет.
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  seedChat();
});

beforeEach(() => {
  db.prepare("DELETE FROM role_run_jobs WHERE task_id LIKE 'avalanche_task_%'").run();
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(CHAT_ID);
});

afterAll(async () => {
  db.prepare("DELETE FROM role_run_jobs WHERE task_id LIKE 'avalanche_task_%'").run();
  db.prepare("DELETE FROM chat_message_queue WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM tasks WHERE id LIKE 'avalanche_task_%'").run();
  if (app) await app.close();
});

describe("очередь ролей: лавина заданий", () => {
  it("группа задания выводится из ключа дедупликации", () => {
    expect(roleRunJobGroup("stalled-restart:abc-123")).toBe("stalled-restart:abc-123");
    expect(roleRunJobGroup("stalled-restart:abc-123:attempt-1")).toBe("stalled-restart:abc-123");
    expect(roleRunJobGroup("review:task-9:attempt:7")).toBe("review:task-9");
    expect(roleRunJobGroup("commented:task-9")).toBeNull();
  });

  it("дубли одного намерения сворачиваются в одно задание, лишние — в cancelled", () => {
    const taskId = "avalanche_task_dupes";
    seedTask(taskId);
    const insert = db.prepare(
      `INSERT INTO role_run_jobs (id, task_id, reason, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'after_run', ?, 'queued', datetime('now'), datetime('now'))`,
    );
    // Лавина: пять заданий одного и того же автоперезапуска (старый формат
    // ключа со случайным идентификатором) и три задания проверки карточки.
    for (let i = 0; i < 5; i += 1) {
      insert.run(`rrj_dupe_${i}`, taskId, `stalled-restart:sub-1:uuid-${i}`);
    }
    for (let i = 0; i < 3; i += 1) {
      insert.run(`rrj_review_${i}`, taskId, `review:${taskId}:attempt-${i}`);
    }
    // Чужое намерение (комментарий) не склеивается ни с чем.
    insert.run("rrj_other", taskId, "commented:whatever");

    const collapsed = collapseDuplicateQueuedJobs();

    expect(collapsed).toBe(6); // 4 лишних дубля перезапуска + 2 дубля проверки
    const queued = db
      .prepare(
        "SELECT dedupe_key FROM role_run_jobs WHERE task_id = ? AND status = 'queued' ORDER BY id",
      )
      .all(taskId) as Array<{ dedupe_key: string }>;
    expect(queued.length).toBe(3); // по одному на перезапуск, проверку и комментарий
    expect(queued.map((row) => row.dedupe_key)).toContain("stalled-restart:sub-1:uuid-4");
    expect(queued.map((row) => row.dedupe_key)).toContain(`review:${taskId}:attempt-2`);
    expect(queued.map((row) => row.dedupe_key)).toContain("commented:whatever");
    const cancelled = db
      .prepare("SELECT count(*) AS n FROM role_run_jobs WHERE task_id = ? AND status = 'cancelled'")
      .get(taskId) as { n: number };
    expect(cancelled.n).toBe(6);
  });

  it("повторный запуск на чистой очереди ничего не трогает", () => {
    const taskId = "avalanche_task_clean";
    seedTask(taskId);
    db.prepare(
      `INSERT INTO role_run_jobs (id, task_id, reason, dedupe_key, status, created_at, updated_at)
       VALUES (?, ?, 'after_run', 'stalled-restart:sub-clean', 'queued', datetime('now'), datetime('now'))`,
    ).run("rrj_clean", taskId);
    expect(collapseDuplicateQueuedJobs()).toBe(0);
    const row = db.prepare("SELECT status FROM role_run_jobs WHERE id='rrj_clean'").get() as { status: string };
    expect(row.status).toBe("queued");
  });
});

describe("очередь чата: срок жизни доставки", () => {
  function insertDelivery(id: string, status: string, updatedAt: string): void {
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, session_generation, payload_json, status, updated_at)
       VALUES (?, ?, ?, ?, 1, '{}', ?, ?)`,
    ).run(id, CHAT_ID, ROLE_USER, id, status, updatedAt);
  }

  it("доставка старше порога уходит в терминальный статус, свежая остаётся", () => {
    insertDelivery("cmq_stale_pending", "pending", "2020-01-01 00:00:00");
    insertDelivery("cmq_stale_picked", "picked", "2020-01-01 00:00:00");
    insertDelivery("cmq_fresh_pending", "pending", "2099-01-01 00:00:00");
    insertDelivery("cmq_done_old", "done", "2020-01-01 00:00:00");

    const closed = expireStaleDeliveries(60);

    expect(closed).toBe(2);
    const status = (id: string): string =>
      (db.prepare("SELECT status FROM chat_message_queue WHERE id=?").get(id) as { status: string }).status;
    expect(status("cmq_stale_pending")).toBe("failed");
    expect(status("cmq_stale_picked")).toBe("failed");
    expect(status("cmq_fresh_pending")).toBe("pending");
    expect(status("cmq_done_old")).toBe("done");
  });

  it("порог берётся из настройки, значение по умолчанию — 60 минут", () => {
    delete process.env.TASKFLOW_CHAT_DELIVERY_TTL_MIN;
    expect(chatDeliveryTtlMinutes()).toBe(60);
    process.env.TASKFLOW_CHAT_DELIVERY_TTL_MIN = "15";
    expect(chatDeliveryTtlMinutes()).toBe(15);
    delete process.env.TASKFLOW_CHAT_DELIVERY_TTL_MIN;
  });
});

describe("очередь чата: аренда хода", () => {
  function insertPicked(id: string, minutesAgo: number, payload = "{}"): void {
    db.prepare(
      `INSERT INTO chat_message_queue
         (id, chat_id, role_id, delivery_id, session_generation, payload_json, status, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'picked', datetime('now', ?))`,
    ).run(id, CHAT_ID, ROLE_USER, id, payload, `-${minutesAgo} minutes`);
  }
  const status = (id: string): string =>
    (db.prepare("SELECT status FROM chat_message_queue WHERE id=?").get(id) as { status: string }).status;
  const payload = (id: string): any =>
    JSON.parse((db.prepare("SELECT payload_json FROM chat_message_queue WHERE id=?").get(id) as { payload_json: string }).payload_json ?? "{}");

  it("оборванный ход возвращается в очередь, а не висит picked", () => {
    insertPicked("cmq_dead_picked", 30);
    const report = reclaimStalePickedDeliveries(5);
    expect(report.reclaimed).toBe(1);
    expect(status("cmq_dead_picked")).toBe("pending");
    expect(payload("cmq_dead_picked").reclaimCount).toBe(1);
  });

  it("живая аренда не отбирается", () => {
    insertPicked("cmq_live_picked", 1);
    const report = reclaimStalePickedDeliveries(5);
    expect(report.reclaimed).toBe(0);
    expect(status("cmq_live_picked")).toBe("picked");
  });

  it("после лимита возвратов ход закрывается, а не крутится вечно", () => {
    insertPicked("cmq_hopeless", 30, JSON.stringify({ reclaimCount: 2 }));
    const report = reclaimStalePickedDeliveries(5);
    expect(report.closed).toBe(1);
    expect(status("cmq_hopeless")).toBe("failed");
    expect(payload("cmq_hopeless").expired).toBe(1);
  });

  it("ход живой роли не отбирают даже при старой аренде", () => {
    const taskId = "avalanche_task_live_turn";
    seedTask(taskId);
    db.prepare(
      `INSERT INTO attempts (id, task_id, executor_id, heartbeat_at)
       VALUES ('att_live_turn', ?, ?, datetime('now'))`,
    ).run(taskId, ROLE_USER);
    insertPicked("cmq_live_role", 30);
    try {
      const report = reclaimStalePickedDeliveries(5);
      expect(report.reclaimed).toBe(0);
      expect(status("cmq_live_role")).toBe("picked");
    } finally {
      db.prepare("DELETE FROM attempts WHERE id='att_live_turn'").run();
    }
  });

  it("аренда и лимит возвратов берутся из настроек", () => {
    delete process.env.TASKFLOW_CHAT_DELIVERY_LEASE_MIN;
    delete process.env.TASKFLOW_CHAT_DELIVERY_RECLAIMS;
    expect(chatDeliveryLeaseMinutes()).toBe(5);
    expect(chatDeliveryMaxReclaims()).toBe(2);
    process.env.TASKFLOW_CHAT_DELIVERY_LEASE_MIN = "3";
    process.env.TASKFLOW_CHAT_DELIVERY_RECLAIMS = "4";
    expect(chatDeliveryLeaseMinutes()).toBe(3);
    expect(chatDeliveryMaxReclaims()).toBe(4);
    delete process.env.TASKFLOW_CHAT_DELIVERY_LEASE_MIN;
    delete process.env.TASKFLOW_CHAT_DELIVERY_RECLAIMS;
  });
});

describe("сторож выкладки: мёртвые доставки не держат выкладку", () => {
  it("python-сторож считает занятыми только живые доставки", () => {
    const dbPath = path.join(os.tmpdir(), `taskflow-deploy-busy-${process.pid}.db`);
    fs.rmSync(dbPath, { force: true });
    const script = path.join(process.cwd(), "scripts", "deploy-when-idle.py");
    const python = `
import importlib.util, os, sqlite3, sys
db_path = sys.argv[1]
script_path = sys.argv[2]
con = sqlite3.connect(db_path)
con.execute("""CREATE TABLE chat_message_queue(
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL, status TEXT NOT NULL,
  updated_at TEXT NOT NULL)""")
con.execute("INSERT INTO chat_message_queue VALUES('m1','c','r','d1','picked', datetime('now','-3 hours'))")
con.execute("INSERT INTO chat_message_queue VALUES('f1','c','r','d2','pending', datetime('now'))")
con.execute("INSERT INTO chat_message_queue VALUES('p1','c','r','d4','picked', datetime('now','-1 minutes'))")
con.execute("INSERT INTO chat_message_queue VALUES('d1','c','r','d3','done', datetime('now','-5 hours'))")
con.commit()
spec = importlib.util.spec_from_file_location("deploy_when_idle", script_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.pending_chat_deliveries(con))
`;
    const out = execFileSync("python3", ["-c", python, dbPath, script], { encoding: "utf8" });
    fs.rmSync(dbPath, { force: true });
    // Мёртвый ход (3 часа) не считается занятостью, свежие pending и
    // живой picked (1 минута) — считаются.
    expect(out.trim()).toBe("2");
  });
});
