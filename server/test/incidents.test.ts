import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { raiseIncident, openIncidentTaskId } from "../src/lib/incidents.js";
import { purgeTasks } from "../src/lib/taskPurge.js";

// Поломка — уведомление, а не задача в проекте (решение владельца
// 12.10.2026). Карточка починки служебная: в списках и поиске её нет,
// пока поломка открыта — дублей нет.
describe("поломка → уведомление → скрытая карточка починки", () => {
  let app: FastifyInstance;
  const KEY = "test-incident";
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });
  const clean = () =>
    purgeTasks((db.prepare("SELECT id FROM tasks WHERE incident_key = ?").all(KEY) as any[]).map((r) => r.id));

  beforeAll(async () => { app = await buildApp(); clean(); });
  afterAll(async () => { clean(); await app.close(); });

  it("заводит одну карточку и одно уведомление, повтор ничего не создаёт", () => {
    const first = raiseIncident({ key: KEY, title: "Проверочная поломка шлюза", description: "## Причина\nпроба" });
    expect(first?.created).toBe(true);
    const again = raiseIncident({ key: KEY, title: "Проверочная поломка шлюза", description: "повтор" });
    expect(again).toEqual({ taskId: first!.taskId, created: false });

    const t = db.prepare("SELECT project_id, service_hidden, status FROM tasks WHERE id = ?").get(first!.taskId) as any;
    expect(t).toEqual({ project_id: null, service_hidden: 1, status: "active" });
    const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND type = 'incident'").get(first!.taskId) as any;
    expect(n.n).toBe(1);
  });

  it("карточки нет в общем списке и в поиске, но она открывается по id", async () => {
    const id = openIncidentTaskId(KEY)!;
    const list = await app.inject({ method: "GET", url: "/api/tasks?include_children=true", headers: headers() });
    expect(list.statusCode).toBe(200);
    expect((list.json() as any[]).some((t) => t.id === id)).toBe(false);

    const service = await app.inject({ method: "GET", url: "/api/tasks?include_children=true&service=true", headers: headers() });
    expect((service.json() as any[]).some((t) => t.id === id)).toBe(true);

    const found = await app.inject({ method: "GET", url: "/api/search?q=" + encodeURIComponent("Проверочная поломка шлюза"), headers: headers() });
    expect(JSON.stringify(found.json())).not.toContain(id);

    const direct = await app.inject({ method: "GET", url: "/api/tasks/" + id, headers: headers() });
    expect(direct.statusCode).toBe(200);
  });

  it("после закрытия карточки та же поломка заводится заново", () => {
    const id = openIncidentTaskId(KEY)!;
    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(id);
    const next = raiseIncident({ key: KEY, title: "Проверочная поломка шлюза", description: "снова" });
    expect(next?.created).toBe(true);
    expect(next?.taskId).not.toBe(id);
  });
});
