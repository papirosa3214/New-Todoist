// Ручная карточка идёт тем же путём, что и постановка Секретаря
// (владелец 23.09.2026): роль с причиной от модели, личное дело — владельцу.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const pick = vi.hoisted(() => ({
  next: null as null | { role: string | null; roleReason: string; where: string | null },
}));

vi.mock("../src/routes/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routes/ai.js")>();
  return { ...actual, pickRoleByModel: async () => pick.next };
});
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

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

describe("ручная карточка: подбор как у Секретаря", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "ManualOwner", email: `manual-owner-${Date.now()}@test`, password: "password123" },
    });
    ownerId = reg.json().user.id;
    ownerAuth = `Bearer ${reg.json().token}`;
    db.prepare("UPDATE users SET role = 'owner', task_intake_mode = 'automatic' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function create(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: ownerAuth },
      payload: { title },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().task.id as string;
    for (let i = 0; i < 40; i++) {
      const r = db.prepare("SELECT assignee_id FROM tasks WHERE id = ?").get(id) as { assignee_id: string | null };
      if (r.assignee_id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return id;
  }

  it("роль от модели с причиной — и карточка уходит именно этой роли", async () => {
    pick.next = { role: "builder", roleReason: "нужно событие на сервере и показ в приложении", where: "iphone" };
    const id = await create("Показывать «печатает» в чате");
    const row = db
      .prepare("SELECT machine_selected_role, dispatched_role, description FROM tasks WHERE id = ?")
      .get(id) as { machine_selected_role: string; dispatched_role: string; description: string };
    expect(row.machine_selected_role).toBe("builder");
    expect(row.dispatched_role).toBe("builder");
    expect(row.description).toContain("📍 ГДЕ: приложение на iPhone");
    const ev = db
      .prepare("SELECT actor_id, to_value FROM task_events WHERE task_id = ? AND kind = 'role_choice' ORDER BY rowid LIMIT 1")
      .get(id) as { actor_id: string | null; to_value: string };
    expect(ev.actor_id).toBeNull();
    expect(ev.to_value).toContain("событие на сервере");
  }, 20_000);

  it("личное дело остаётся владельцу: без флага и без раздачи", async () => {
    pick.next = { role: null, roleReason: "", where: "личное" };
    const id = await create("Продлить ОСАГО");
    const row = db
      .prepare("SELECT assignee_id, ready_for_pickup, dispatched_role FROM tasks WHERE id = ?")
      .get(id) as { assignee_id: string; ready_for_pickup: number; dispatched_role: string | null };
    expect(row.assignee_id).toBe(ownerId);
    expect(row.ready_for_pickup).toBe(0);
    expect(row.dispatched_role).toBeNull();
  }, 20_000);
});
