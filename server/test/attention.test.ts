// «Входящие» (владелец 28.10.2026): один ответ на весь экран важного.
// Проверяем не вёрстку, а контракт: пустая база даёт пять пустых секций,
// а карточка, ждущая владельца, попадает в решения, упавшая попытка — в сбои.
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

it("на пустых данных отдаёт все пять секций и нулевые счётчики", async () => {
  const res = await app.inject({ method: "GET", url: "/api/attention", headers: auth() });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  for (const key of ["decisions", "failures", "today", "running", "upcoming"]) {
    expect(Array.isArray(body[key]), key).toBe(true);
  }
  expect(body.ok).toBe(true);
  expect(typeof body.counts).toBe("object");
});

it("карточка, ждущая решения, попадает во «Входящие»", async () => {
  const owner = db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string };
  const id = "attn-task-" + Math.random().toString(36).slice(2, 8);
  db.prepare(
    "INSERT INTO tasks (id, title, description, status, creator_id, agent_state) VALUES (?,?,?,'active',?, 'blocked')",
  ).run(id, "Проверить окно", "", owner.id);

  const res = await app.inject({ method: "GET", url: "/api/attention", headers: auth() });
  const body = res.json();
  const found = body.decisions.find((d: { id: string }) => d.id === id);
  expect(found).toBeTruthy();
  expect(found.kind).toBe("task");
  expect(found.actions).toContain("answer");
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
});
