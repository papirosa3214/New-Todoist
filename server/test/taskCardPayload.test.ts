// Карточка не тащит телефону тексты промптов (владелец 20.10.2026: карточка
// весила 422 КБ и тормозила, из них 283 КБ — снимки промптов ролей, которые
// ни один клиент не показывает). В базе они остаются целиком.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("GET /api/tasks/:id — без текстов промптов", () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Payload owner",
        email: `payload-${Date.now()}@test`,
        password: "password123",
      },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(
      reg.json().user.id,
    );
    auth = { authorization: `Bearer ${reg.json().token}` };
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("снимок промпта не отдаётся, событие запуска — только суть", async () => {
    const taskId = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: auth,
        payload: { title: "Лёгкая карточка" },
      })
    ).json().task.id as string;
    const manifest = "x".repeat(20000);
    db.prepare(
      "UPDATE tasks SET composed_prompt_snapshot = ? WHERE id = ?",
    ).run(manifest, taskId);
    db.prepare(
      "INSERT INTO task_events (id, task_id, actor_id, kind, field, to_value) VALUES (?, ?, NULL, 'instruction_snapshot', 'run-1', ?)",
    ).run(
      crypto.randomUUID(),
      taskId,
      JSON.stringify({ mode: "work", resumed: false, manifest }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const task = body.task ?? body;
    expect(task.composed_prompt_snapshot).toBeUndefined();
    const ev = task.events.find(
      (e: { kind: string }) => e.kind === "instruction_snapshot",
    );
    expect(JSON.parse(ev.to_value)).toEqual({ mode: "work", resumed: false });
    expect(res.body.length).toBeLessThan(10000);

    // В базе — целиком.
    expect(
      (
        db
          .prepare("SELECT composed_prompt_snapshot AS s FROM tasks WHERE id=?")
          .get(taskId) as { s: string }
      ).s,
    ).toBe(manifest);
  });
});
