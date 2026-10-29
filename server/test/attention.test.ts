// «Входящие» (владелец 28.10.2026, переделка 29.10.2026): три группы по статусам
// — «Заблокировано», «В работе», «На проверке». Строка — карточка задачи.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

let app: FastifyInstance;
const auth = () => ({ authorization: `Bearer ${app.jwt.sign({ id: "role_architect" })}` });

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
});
afterAll(async () => {
  await app.close();
});

it("отдаёт ровно три группы в нужном порядке", async () => {
  const res = await app.inject({ method: "GET", url: "/api/attention", headers: auth() });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.groups.map((g: { key: string }) => g.key)).toEqual(["blocked", "in_progress", "review"]);
  expect(body.groups.map((g: { title: string }) => g.title)).toEqual([
    "Заблокировано",
    "В работе",
    "На проверке",
  ]);
  for (const group of body.groups) expect(Array.isArray(group.tasks)).toBe(true);
});

it("заблокированная задача попадает в «Заблокировано», а не в другие группы", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string };
  const id = "attn3-" + Math.random().toString(36).slice(2, 8);
  db.prepare(
    "INSERT INTO tasks (id, title, description, status, creator_id, agent_state) VALUES (?,?,?,'active',?, 'blocked')",
  ).run(id, "Проверить окно", "", owner.id);

  const body = (await app.inject({ method: "GET", url: "/api/attention", headers: auth() })).json();
  const blocked = body.groups.find((g: { key: string }) => g.key === "blocked");
  const others = body.groups.filter((g: { key: string }) => g.key !== "blocked");
  expect(blocked.tasks.some((t: { id: string }) => t.id === id)).toBe(true);
  for (const g of others) expect(g.tasks.some((t: { id: string }) => t.id === id)).toBe(false);
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
});
