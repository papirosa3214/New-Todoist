// Работа сама подтверждает, что агент жив (09.09.2026, решение владельца).
//
// Раньше аренду держал только пинг — его слал хук внутри Claude Code и
// служба-будильник. У остальных исполнителей хука нет, а с выключенным
// будильником пинга не было ни у кого: работающий агент числился пропавшим
// через пять минут. При этом он всё это время слал в канал активности
// «правлю такой-то файл» — сервер это принимал, показывал владельцу и тут же
// считал автора мёртвым.
//
// Проверяем: POST /api/tasks/:id/activity обновляет отметку живости, и делает
// это даже когда аренда уже протухла (иначе замкнутый круг — вернувшегося
// агента не слышат, потому что он до этого молчал).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Активность продлевает аренду", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerAct", email: "owner@act-lease.test", password: "password123" },
    });
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.json().user.id);

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentAct", email: "agent@act-lease.test", password: "password123" },
    });
    agentToken = agent.json().token;
    agentId = agent.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Задача, взятая агентом в работу. */
  async function taskInProgress(title: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    const id = created.json().task.id;
    markReadyForPickup(id);
    await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    return id;
  }

  const heartbeatOf = (id: string) =>
    (db.prepare("SELECT agent_heartbeat_at FROM tasks WHERE id = ?").get(id) as any)
      ?.agent_heartbeat_at as string | null;

  /** Отматываем последний сигнал назад — аренда 5 минут, берём с запасом. */
  function silenceFor(id: string, minutes: number) {
    db.prepare(
      `UPDATE tasks SET agent_heartbeat_at = datetime('now', ?) WHERE id = ?`,
    ).run(`-${minutes} minutes`, id);
  }

  it("действие агента обновляет отметку живости", async () => {
    const id = await taskInProgress("Активность держит аренду");
    silenceFor(id, 3);
    const before = heartbeatOf(id);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/activity`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { kind: "edit", target: "src/lib/search.ts" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);

    const after = heartbeatOf(id);
    expect(after).not.toBe(before);
    expect(new Date(`${after}Z`).getTime()).toBeGreaterThan(
      new Date(`${before}Z`).getTime(),
    );
  });

  it("вернувшегося агента слышат, даже если аренда уже протухла", async () => {
    const id = await taskInProgress("Аренда протухла, агент вернулся");
    silenceFor(id, 30);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/activity`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { kind: "run", target: "npm", detail: "npm test" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);

    // И задача снова считается живой, а не «пропал».
    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(card.json().agent_stale).toBe(false);
  });

  it("задачу, которую никто не держит, активность не оживляет", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Никем не взята", assignee_id: agentId },
    });
    const id = created.json().task.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/activity`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { kind: "edit", target: "src/lib/search.ts" },
    });
    expect(res.json().accepted).toBe(false);
    expect(heartbeatOf(id)).toBeNull();
  });
});
