// Владелец 22.09.2026: родитель со своими пунктами исполняется после
// дочерних. Как только все дочерние на проверке или закрыты, а у родителя
// есть невыполненные пункты, сервер в автоматическом режиме поднимает ему
// флаг и отдаёт исполнителю (admitParentAfterChildren в routes/dispatch.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";

// Будильник «работает» — иначе раздача не идёт (см. readyDispatchBridge).
vi.mock("../src/routes/agent-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/agent-service.js")>();
  return {
    ...actual,
    unitState: async () => ({
      active: true,
      enabled: true,
      last_alive_at: null,
      next_scan_at: null,
      scan_interval_sec: 180,
    }),
  };
});

import { buildApp } from "../src/index.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { admitParentAfterChildren } from "../src/routes/dispatch.js";
import db from "../src/db.js";

const uid = () => crypto.randomUUID();

describe("родитель со своими пунктами исполняется после дочерних", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let agentId: string;
  let agentAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = async (name: string, email: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/register",
          payload: { name, email, password: "password123" },
        })
      ).json();
    const owner = await reg("ParentOwner", `parent-owner-${Date.now()}@test`);
    ownerId = owner.user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    const agent = await reg("ParentAgent", `parent-agent-${Date.now()}@test`);
    agentId = agent.user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
    agentAuth = `Bearer ${agent.token}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    db.prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE role = 'owner'").run();
  });

  /** Дерево: родитель (+ свои пункты) и дочерние с заданными состояниями. */
  function tree(opts: {
    parentSteps: number;
    children: Array<{ status?: string; agent_state?: string | null; assignee?: string }>;
  }) {
    const parentId = uid();
    db.prepare(
      "INSERT INTO tasks (id, title, creator_id, status) VALUES (?, ?, ?, 'active')",
    ).run(parentId, "Родитель", ownerId);
    for (let i = 0; i < opts.parentSteps; i++) {
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)",
      ).run(uid(), parentId, `Свой пункт ${i + 1}`, i + 1);
    }
    const childIds = opts.children.map((c) => {
      const id = uid();
      db.prepare(
        `INSERT INTO tasks (id, title, creator_id, parent_id, status, agent_state, assignee_id, ready_for_pickup)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, "Дочерняя", ownerId, parentId, c.status ?? "active", c.agent_state ?? null, c.assignee ?? null);
      return id;
    });
    return { parentId, childIds };
  }

  const parentRow = (id: string) =>
    db.prepare("SELECT ready_for_pickup, assignee_id FROM tasks WHERE id = ?").get(id) as {
      ready_for_pickup: number;
      assignee_id: string | null;
    };

  it("все дочерние сданы или закрыты — родитель получает флаг и исполнителя", async () => {
    const { parentId, childIds } = tree({
      parentSteps: 1,
      children: [{ agent_state: "review" }, { status: "completed" }],
    });
    expect(await admitParentAfterChildren(childIds[0])).toBe(true);
    const row = parentRow(parentId);
    expect(row.ready_for_pickup).toBe(1);
    expect(row.assignee_id).not.toBeNull();
    const ev = db
      .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'ready_flag_changed'")
      .get(parentId) as { n: number };
    expect(ev.n).toBe(1);
    // Флаг и раздачу сделала автоматика — в ленте «Система», не владелец.
    const actors = db
      .prepare(
        "SELECT kind, actor_id FROM task_events WHERE task_id = ? AND kind IN ('ready_flag_changed', 'task_dispatched', 'role_choice')",
      )
      .all(parentId) as Array<{ kind: string; actor_id: string | null }>;
    expect(actors.map((a) => a.kind).sort()).toEqual(
      ["ready_flag_changed", "role_choice", "task_dispatched"],
    );
    expect(actors.every((a) => a.actor_id === null)).toBe(true);
  }, 20_000);

  it("не все дочерние сданы — родитель ждёт", async () => {
    const { parentId, childIds } = tree({
      parentSteps: 1,
      children: [{ agent_state: "review" }, { agent_state: "in_progress" }],
    });
    expect(await admitParentAfterChildren(childIds[0])).toBe(false);
    expect(parentRow(parentId).ready_for_pickup).toBe(0);
  });

  it("у родителя нет своих пунктов — флаг не ставится", async () => {
    const { parentId, childIds } = tree({
      parentSteps: 0,
      children: [{ agent_state: "review" }, { agent_state: "review" }],
    });
    expect(await admitParentAfterChildren(childIds[0])).toBe(false);
    expect(parentRow(parentId).ready_for_pickup).toBe(0);
  });

  it("ручной режим — флаг ставит владелец, не сервер", async () => {
    db.prepare("UPDATE users SET task_intake_mode = 'manual' WHERE role = 'owner'").run();
    const { parentId, childIds } = tree({
      parentSteps: 1,
      children: [{ agent_state: "review" }],
    });
    expect(await admitParentAfterChildren(childIds[0])).toBe(false);
    expect(parentRow(parentId).ready_for_pickup).toBe(0);
  });

  it("исполнитель сдал последнюю дочернюю через /state — родитель уехал сам", async () => {
    const { parentId, childIds } = tree({
      parentSteps: 1,
      children: [{ agent_state: "review" }, { agent_state: "in_progress", assignee: agentId }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${childIds[1]}/state`,
      headers: { authorization: agentAuth },
      payload: { state: "review", comment: "сделано" },
    });
    expect(res.statusCode).toBe(200);
    for (let i = 0; i < 40 && parentRow(parentId).ready_for_pickup !== 1; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(parentRow(parentId).ready_for_pickup).toBe(1);
  }, 20_000);
});

describe("лента: отправка на проверку видна", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  const serviceKey = `svc-${crypto.randomUUID()}`;
  const PI_AGENT_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "JournalOwner", email: `journal-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    ownerAuth = `Bearer ${reg.json().token}`;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    // Служебная учётка будильника (Pi Agent) со своим ключом.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
       VALUES (?, 'Pi Agent', 'pi-journal@test', 'x', 'agent', 'ai')`,
    ).run(PI_AGENT_ID);
    db.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(
      crypto.createHash("sha256").update(serviceKey, "utf8").digest("hex"),
      PI_AGENT_ID,
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function newTask() {
    const id = uid();
    db.prepare(
      "INSERT INTO tasks (id, title, creator_id, status) VALUES (?, 'Карточка', ?, 'active')",
    ).run(id, ownerId);
    return id;
  }

  it("служба отмечает отправку на проверку — запись от системы", async () => {
    const id = newTask();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/journal`,
      headers: { authorization: `Bearer ${serviceKey}` },
      payload: { kind: "reviewer_sent", to_value: "Критик-проверяющий" },
    });
    expect(res.statusCode).toBe(200);
    const ev = db
      .prepare("SELECT actor_id, to_value FROM task_events WHERE task_id = ? AND kind = 'reviewer_sent'")
      .get(id) as { actor_id: string | null; to_value: string };
    expect(ev.actor_id).toBeNull();
    expect(ev.to_value).toBe("Критик-проверяющий");
  });

  it("не служба в ленту писать не может, неизвестное событие не принимается", async () => {
    const id = newTask();
    const byOwner = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/journal`,
      headers: { authorization: ownerAuth },
      payload: { kind: "reviewer_sent" },
    });
    expect(byOwner.statusCode).toBe(403);
    const unknown = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/journal`,
      headers: { authorization: `Bearer ${serviceKey}` },
      payload: { kind: "task_created" },
    });
    expect(unknown.statusCode).toBe(400);
  });

});
