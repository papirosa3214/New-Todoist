// Спек 1.2, задача 1.2.3: POST /api/tasks/:id/retry — подтверждение retry
// агентом после /stop с reason_code='insufficient_capability'. Сценарии —
// по subtasks 4–6 карточки.
//
// Тесты строят реальное серверное окружение через buildApp() (как в
// stopReasons.test.ts): не мокают логику лесенки, а ставят стартовую модель
// попытки через UPDATE attempts SET model=... — иначе нельзя проверить
// именно ту ветку, по которой /stop выдаёт next_attempt_template.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

interface StartedTask {
  id: string;
  attemptId: string;
}

describe("POST /api/tasks/:id/retry (спек 1.2, 1.2.3)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OwnerRetry",
        email: "owner-retry@test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;
    ownerId = owner.json().user.id;

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentRetry",
        email: "agent-retry@test",
        password: "password123",
      },
    });
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
    agentToken = (
      await app.inject({
        method: "POST",
        url: "/api/auth/api-token",
        headers: { authorization: `Bearer ${agent.json().token}` },
      })
    ).json().api_token;
  });

  afterAll(async () => {
    await app.close();
  });

  // Готовим задачу: owner создал → ready → agent claim'нул → попытке выставлен
  // стартовый `model`. Возвращаем id задачи и id текущей (живой) попытки.
  async function setupTask(opts: {
    title: string;
    initialModel: string;
    runner?: string | null;
  }): Promise<StartedTask> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: opts.title },
    });
    const id = created.json().task.id as string;
    markReadyForPickup(id);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(
      agentId,
      id,
    );
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": `seed-${id}`,
      },
      payload: {},
    });
    expect(claim.statusCode).toBe(200);
    db.prepare(
      "UPDATE attempts SET model = ?, runner = COALESCE(?, runner) WHERE id = ?",
    ).run(opts.initialModel, opts.runner ?? null, claim.json().task.current_attempt_id);
    return {
      id,
      attemptId: claim.json().task.current_attempt_id as string,
    };
  }

  // Прогон stop'а с недостаточной способностью — переводит задачу в blocked
  // и возвращает next_attempt_template, на который и подаём retry.
  async function stopInsufficientCapability(taskId: string, attemptId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/stop`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": attemptId,
      },
      payload: { reason_code: "insufficient_capability", comment: "не тянет" },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("retry на Sonnet после stop insufficient_capability создаёт attempt на Opus", async () => {
    // Стартуем с sonnet → следующая ступень по лесенке = opus.
    const t = await setupTask({
      title: "retry sonnet→opus",
      initialModel: "sonnet",
      runner: "claude",
    });
    const stop = await stopInsufficientCapability(t.id, t.attemptId);
    expect(stop.next_attempt_template).toEqual({
      model: "opus",
      runner: "claude",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": t.attemptId,
      },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "opus", runner: "claude" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe("opus");
    expect(body.runner).toBe("claude");
    expect(body.attempt_id).toBeTypeOf("string");
    expect(body.attempt_id).not.toBe(t.attemptId);
    expect(body.task.agent_state).toBe("in_progress");
    expect(body.task.current_attempt_id).toBe(body.attempt_id);

    // Старый attempt закрыт с outcome='needs_escalation'.
    const old = db
      .prepare("SELECT outcome, ended_at FROM attempts WHERE id = ?")
      .get(t.attemptId) as { outcome: string; ended_at: string | null };
    expect(old.outcome).toBe("needs_escalation");
    expect(old.ended_at).not.toBeNull();

    // Новый attempt жив, на нужной модели и runner'е.
    const fresh = db
      .prepare(
        "SELECT model, runner, ended_at FROM attempts WHERE id = ?",
      )
      .get(body.attempt_id) as {
      model: string;
      runner: string | null;
      ended_at: string | null;
    };
    expect(fresh.model).toBe("opus");
    expect(fresh.runner).toBe("claude");
    expect(fresh.ended_at).toBeNull();
  });

  it("retry с чужим attempt_id отдаёт 400 attempt_id_mismatch", async () => {
    const t = await setupTask({
      title: "retry чужой attempt_id",
      initialModel: "haiku",
    });
    await stopInsufficientCapability(t.id, t.attemptId);

    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: fakeId,
        template: { model: "sonnet", runner: null },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/attempt_id_mismatch/);
    expect(res.json().error).toContain(fakeId);
  });

  it("двойной retry на одном attempt_id отдаёт 400", async () => {
    const t = await setupTask({
      title: "retry двойной",
      initialModel: "haiku",
    });
    await stopInsufficientCapability(t.id, t.attemptId);

    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "sonnet", runner: null },
      },
    });
    expect(first.statusCode).toBe(200);
    const secondAttemptId = first.json().attempt_id;

    // Второй раз с тем же (уже устаревшим) attempt_id.
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "opus", runner: null },
      },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/attempt_id_mismatch/);
    expect(second.json().error).toContain(secondAttemptId);
    expect(second.json().error).toContain(t.attemptId);
  });

  it("retry с шаблоном, отличным от серверного next_attempt_template → 400", async () => {
    const t = await setupTask({
      title: "retry template_mismatch",
      initialModel: "haiku",
    });
    await stopInsufficientCapability(t.id, t.attemptId);

    // Сервер предлагает sonnet; агент шлёт opus — лесенка ≠ присланному.
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "opus", runner: null },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/template_mismatch/);
  });

  it("retry после reason_code ≠ insufficient_capability → 400", async () => {
    const t = await setupTask({
      title: "retry без insufficient_capability",
      initialModel: "haiku",
    });
    // Закрываем попытку не лесенкой, а другим reason (permission_or_owner).
    await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/stop`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-agent-attempt-id": t.attemptId,
      },
      payload: { reason_code: "permission_or_owner", comment: "нужен владелец" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "sonnet", runner: null },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/insufficient_capability/);
  });

  it("retry при attempts_count ≥ 3 → 400 (потолок лесенки)", async () => {
    const t = await setupTask({
      title: "retry потолок",
      initialModel: "haiku",
    });
    // Заполняем две фейковые закрытые попытки с insufficient_capability,
    // чтобы attempts_count стал 3 (текущая живая + две закрытые).
    for (let i = 0; i < 2; i += 1) {
      db.prepare(
        `INSERT INTO attempts
           (id, task_id, executor_id, runner, model,
            started_at, ended_at, outcome, reason_code)
         VALUES (?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?),
                 'needs_escalation', 'insufficient_capability')`,
      ).run(
        `fake-${t.id}-${i}`,
        t.id,
        agentId,
        null,
        i === 0 ? "haiku" : "sonnet",
        `-${i + 2} hours`,
        `-${i + 2} hours`,
      );
    }
    // Теперь stop'аем текущую попытку с insufficient_capability — итого 4
    // попытки, retries_count >= 3.
    await stopInsufficientCapability(t.id, t.attemptId);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${t.id}/retry`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        attempt_id: t.attemptId,
        template: { model: "sonnet", runner: null },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/потолок/);
  });
});
