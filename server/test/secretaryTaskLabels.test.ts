// Метки задач для Помощника владельца (26.10.2026, коммит 65755daf).
//
// Проверяем серверную часть по HTTP (app.inject), как это делает access.test.ts:
//  1) Помощник (u-secretary) видит метки владельца через GET /api/labels;
//  2) ставит метку на задачу, созданную владельцем (PATCH /api/tasks/:id);
//  3) пустой список меток снимает метки;
//  4) права: операции taskflow_labels/taskflow_set_task_labels достаются
//     только роли secretary (roleToolScope), остальным ролям — нет.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";
import { roleUserId } from "../src/roleRouting.js";

describe("Метки задач для Помощника владельца", () => {
  let app: FastifyInstance;
  let ownerJwt: string;
  let secretaryJwt: string;
  let labelId: string;
  let taskId: string;

  const ownerHeaders = () => ({ authorization: `Bearer ${ownerJwt}` });
  const secretaryHeaders = () => ({ authorization: `Bearer ${secretaryJwt}` });

  beforeAll(async () => {
    migrate();
    runMigrations();
    app = await buildApp();

    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец меток", email: `labels-owner-${Date.now()}@taskflow.local`, password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    ownerJwt = reg.json().token as string;
    const ownerId = reg.json().user.id as string;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    // Помощник владельца — фиксированная ai-учётка (roleRouting.roleUserId).
    const secretaryId = roleUserId("secretary");
    const sec = db.prepare("SELECT id FROM users WHERE id = ?").get(secretaryId);
    if (!sec) {
      db.prepare(
        `INSERT INTO users (id, name, email, password_hash, role, role_key, type, status)
         VALUES (?, 'Помощник владельца', 'u-secretary@taskflow.local', '', 'agent', 'secretary', 'ai', 'offline')`,
      ).run(secretaryId);
    } else {
      db.prepare("UPDATE users SET role_key = 'secretary', type = 'ai' WHERE id = ?").run(secretaryId);
    }
    secretaryJwt = app.jwt.sign({ id: secretaryId }, { expiresIn: "5m" });

    const label = await app.inject({
      method: "POST",
      url: "/api/labels",
      headers: ownerHeaders(),
      payload: { name: "Метка владельца" },
    });
    expect(label.statusCode).toBe(200);
    labelId = label.json().id as string;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerHeaders(),
      payload: { title: "Задача владельца под метку" },
    });
    expect(task.statusCode).toBe(200);
    taskId = (task.json().task?.id ?? task.json().id) as string;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("Помощник видит метки владельца в GET /api/labels", async () => {
    const res = await app.inject({ method: "GET", url: "/api/labels", headers: secretaryHeaders() });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as any[]).map((l: any) => l.id);
    expect(ids).toContain(labelId);
  });

  it("Помощник ставит метку на задачу владельца", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: secretaryHeaders(),
      payload: { label_ids: [labelId] },
    });
    expect(res.statusCode).toBe(200);

    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: ownerHeaders() });
    expect(task.json().labels.map((l: any) => l.id)).toContain(labelId);
  });

  it("пустой список меток снимает метку", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: secretaryHeaders(),
      payload: { label_ids: [] },
    });
    expect(res.statusCode).toBe(200);
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: ownerHeaders() });
    expect(task.json().labels ?? []).toEqual([]);
  });

  it("чужая метка отвергается", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: secretaryHeaders(),
      payload: { label_ids: ["несуществующая-метка"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("Помощник создаёт задачу сразу с меткой", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: secretaryHeaders(),
      payload: { title: "Задача Помощника с меткой", label_ids: [labelId] },
    });
    expect(res.statusCode).toBe(200);
    const id = (res.json().task?.id ?? res.json().id) as string;
    const task = await app.inject({ method: "GET", url: `/api/tasks/${id}`, headers: ownerHeaders() });
    expect(task.json().labels.map((l: any) => l.id)).toContain(labelId);
  });

  it("операции меток достаются только Помощнику владельца", () => {
    // Права проверяются при вызове (roleToolAllowed), а не составом каталога.
    expect(roleToolAllowed("secretary", "taskflow_labels")).toBe(true);
    expect(roleToolAllowed("secretary", "taskflow_set_task_labels")).toBe(true);
    for (const роль of ["builder", "analyst", "researcher", "critic_verifier"]) {
      expect(roleToolAllowed(роль, "taskflow_labels")).toBe(false);
      expect(roleToolAllowed(роль, "taskflow_set_task_labels")).toBe(false);
    }
  });
});
