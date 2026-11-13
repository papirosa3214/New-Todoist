// server/test/closedTasksFeed.test.ts
//
// Лёгкая выдача закрытых задач и снимок статистики для телефона
// (владелец 13.11.2026): «карточка с итогом и названием… архив 1 мес…
// статистика — фото с сервера… чисто по дням, в какой день сколько задач».
// Полная карточка на телефон не возится — только мини-карточки; на сервере
// ничего не удаляется.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

type Reg = { id: string; jwt: string };

async function makeUser(app: FastifyInstance, name: string, email: string, role?: string): Promise<Reg> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
  return { id: body.user.id, jwt: body.token };
}

const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

describe("Лёгкая выдача закрытых задач и снимок статистики по дням", () => {
  let app: FastifyInstance;
  let owner: Reg;
  let stranger: Reg;

  beforeAll(async () => {
    app = await buildApp();
    owner = await makeUser(app, "Владелец", "owner@closed-feed.test", "owner");
    stranger = await makeUser(app, "Чужой", "stranger@closed-feed.test");
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeTask(title: string, description = "") {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(owner.jwt),
      payload: { title, description },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { task: { id: string } }).task.id;
  }

  function complete(id: string, at = "datetime('now')") {
    db.prepare(`UPDATE tasks SET status = 'completed', completed_at = ${at} WHERE id = ?`).run(id);
  }

  async function closed(since?: string) {
    const r = await app.inject({
      method: "GET",
      url: since ? `/api/tasks/closed?since=${encodeURIComponent(since)}` : "/api/tasks/closed",
      headers: bearer(owner.jwt),
    });
    expect(r.statusCode).toBe(200);
    return r.json() as {
      server_time: string;
      full: boolean;
      items: Array<{ id: string; title: string; project_name: string | null; kind: string; closed_at: string; outcome: string | null }>;
      removed_ids: string[];
    };
  }

  async function daily(since?: string) {
    const r = await app.inject({
      method: "GET",
      url: since ? `/api/stats/completed-daily?since=${encodeURIComponent(since)}` : "/api/stats/completed-daily",
      headers: bearer(owner.jwt),
    });
    expect(r.statusCode).toBe(200);
    return r.json() as { server_time: string; full: boolean; days: Array<{ day: string; count: number }> };
  }

  it("отдаёт мини-карточки выполненных и архивных задач с итогом, без активных", async () => {
    const done = await makeTask("Сделать вход", "Первая строка описания\nвторая");
    const archived = await makeTask("Старая идея");
    const active = await makeTask("Ещё в работе");
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, result) VALUES ('st-feed-1', ?, 'Шаг', 1, 1, 'Вход работает, проверено на телефоне')",
    ).run(done);
    complete(done);
    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${archived}`, headers: bearer(owner.jwt) });
    expect(del.statusCode).toBe(200);

    const body = await closed();
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(done)).toMatchObject({ title: "Сделать вход", kind: "completed", outcome: "Вход работает, проверено на телефоне" });
    expect(byId.get(archived)).toMatchObject({ title: "Старая идея", kind: "archived" });
    expect(byId.has(active)).toBe(false);
    // Мини-карточка — без описания, шагов и истории.
    expect(Object.keys(byId.get(done)!).sort()).toEqual(["closed_at", "id", "kind", "outcome", "project_name", "title"]);
  });

  it("итог без шагов — первая строка описания", async () => {
    const id = await makeTask("Без шагов", "  Итог из описания  \nдальше не нужно");
    complete(id);
    const item = (await closed()).items.find((i) => i.id === id);
    expect(item?.outcome).toBe("Итог из описания");
  });

  it("архив — только последний месяц", async () => {
    const old = await makeTask("Давно закрыта");
    complete(old, "datetime('now', '-40 days')");
    expect((await closed()).items.some((i) => i.id === old)).toBe(false);
  });

  it("с курсором — только изменения: новая закрытая приходит, переоткрытая уходит", async () => {
    const a = await makeTask("Закроется после курсора");
    const b = await makeTask("Переоткроется");
    complete(b);
    const first = await closed();
    expect(first.items.some((i) => i.id === b)).toBe(true);

    complete(a);
    db.prepare("UPDATE tasks SET status = 'active', completed_at = NULL WHERE id = ?").run(b);
    const delta = await closed(first.server_time);
    expect(delta.full).toBe(false);
    expect(delta.items.map((i) => i.id)).toContain(a);
    expect(delta.removed_ids).toContain(b);
    // Нетронутые карточки повторно не возятся.
    expect(delta.items.length).toBeLessThan(first.items.length + 1);
  });

  it("статистика: по дням сколько задач, с курсором — только изменившиеся дни", async () => {
    const t1 = await makeTask("Вчерашняя");
    complete(t1, "datetime('now', '-1 day')");
    const snap = await daily();
    expect(snap.days.length).toBeGreaterThan(0);
    for (const d of snap.days) {
      expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.count).toBeGreaterThan(0);
    }
    const yesterdayCount = (day: string, list: Array<{ day: string; count: number }>) =>
      list.find((d) => d.day === day)?.count ?? 0;

    // Ничего не менялось — пусто.
    const idle = await daily(snap.server_time);
    expect(idle.days).toEqual([]);

    // Переоткрыли вчерашнюю — пришёл только её день с уменьшенным числом.
    const yesterday = (db.prepare("SELECT date(datetime('now', '-1 day'), '+3 hours') AS d").get() as { d: string }).d;
    const before = yesterdayCount(yesterday, snap.days);
    db.prepare("UPDATE tasks SET status = 'active', completed_at = NULL WHERE id = ?").run(t1);
    const changed = await daily(snap.server_time);
    expect(changed.days).toEqual([{ day: yesterday, count: before - 1 }]);
  });

  it("на сервере ничего не удаляется: закрытые старше месяца лежат в базе и считаются в статистике", async () => {
    const old = await makeTask("Очень старая");
    complete(old, "datetime('now', '-60 days')");
    expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get(old)).toBeTruthy();
    const day = (db.prepare("SELECT date(datetime('now', '-60 days'), '+3 hours') AS d").get() as { d: string }).d;
    expect((await daily()).days.find((d) => d.day === day)?.count).toBeGreaterThanOrEqual(1);
  });

  it("только владельцу", async () => {
    for (const url of ["/api/tasks/closed", "/api/stats/completed-daily"]) {
      const r = await app.inject({ method: "GET", url, headers: bearer(stranger.jwt) });
      expect(r.statusCode).toBe(403);
    }
  });
});
