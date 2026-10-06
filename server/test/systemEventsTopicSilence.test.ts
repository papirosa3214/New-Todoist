import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { logStepOutcome } from "../src/runtime/stepOutcome.js";

// MAK-99, пункт 3: системные события (сбои, переключения модели, автозапуск)
// живут в ленте действий карточки (task_events) и НЕ пишутся в чат темы.
describe("MAK-99: системные события не попадают в чат темы", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerSilence", email: "owner-silence@test", password: "password123" },
    });
    ownerId = owner.json().user.id;
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Системное событие и чат" },
    });
    taskId = created.json().task.id;
  });

  afterAll(async () => {
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM task_events WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM chat_messages WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("DELETE FROM users WHERE id = ?").run(ownerId);
    db.pragma("foreign_keys = ON");
    await app.close();
  });

  it("сбой запуска шага идёт в ленту карточки, а не в чат темы", () => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE task_id = ?").get(taskId) as { n: number }
    ).n;
    logStepOutcome({
      taskId,
      outcome: "failed",
      error: "429 Too Many Requests: provider rate limit",
      message: "провайдер ответил 429",
    });
    const event = db
      .prepare(
        "SELECT to_value FROM task_events WHERE task_id = ? AND kind = 'step_outcome' ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId) as { to_value: string } | undefined;
    expect(event).toBeTruthy();
    expect(event!.to_value).toContain("provider_rate_limit");
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE task_id = ?").get(taskId) as { n: number }
    ).n;
    expect(after).toBe(before);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE task_id = ? AND message_type = 'system'")
        .get(taskId),
    ).toEqual({ n: 0 });
  });
});
