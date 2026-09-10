// Владелец снимает задачу с агента — карточка обязана расклиниться.
//
// Симптом, пойманный Максимом 24.08.2026: «карточки, заблокированные
// агентом, остаются заблокированными даже после выполнения задачи…
// отсутствует возможность отправить задачу на доработку агенту, из-за чего
// карточка зависает». Причин было две, и обе здесь:
//
//  1. состояние задачи не всегда хранится у самой задачи — если её
//     agent_state пуст, оно достраивается СНИЗУ, из незакрытого шага
//     (routes/tasks.ts, withAgentStale). Владелец писал NULL туда, где NULL
//     и так был, шаг продолжал держать отметку о работе, и карточка
//     перечитывалась занятой;
//  2. закрытие задачи гасило agent_state только у неё самой — и «Агент
//     пропал» горел на уже выполненной карточке.
//
// Проверяем не колонки ради колонок, а то, что видит владелец: задача,
// прочитанная через API после его действия, больше не занята.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("Снятие задачи с агента расклинивает карточку", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@owner-release.test",
        password: "password123",
      },
    });
    ownerToken = ownerReg.json().token;
    // 29.08.2026 (задача be329d8e): закрыть/вернуть может только роль
    // owner/orchestrator — регистрация её не выдаёт, ставим в базе.
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(
      ownerReg.json().user.id,
    );

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Agent",
        email: "agent@owner-release.test",
        password: "password123",
      },
    });
    agentToken = agentReg.json().token;
    agentId = agentReg.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Задача с одним шагом, назначенная на агента. */
  async function makeTask(title: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title, assignee_id: agentId },
    });
    const taskId = created.json().task.id;
    markReadyForPickup(taskId);
    const sub = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Шаг, за который взялся агент" },
    });
    return { taskId, subtaskId: sub.json().id };
  }

  /** Как задачу видит владелец, открыв карточку. */
  async function readTask(taskId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    return res.json();
  }

  /** Отодвинуть последний сигнал агента в прошлое — «агент пропал». */
  function expireLease(taskId: string, subtaskId: string) {
    const давно = "datetime('now', '-1 hour')";
    db.exec(
      `UPDATE tasks SET agent_heartbeat_at = ${давно} WHERE id = '${taskId}'`,
    );
    db.exec(
      `UPDATE subtasks SET agent_heartbeat_at = ${давно} WHERE id = '${subtaskId}'`,
    );
  }

  it("шаг, оставшийся в работе, держал задачу занятой — теперь отпускается", async () => {
    const { taskId, subtaskId } = await makeTask("Агент взял шаг и пропал");

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expireLease(taskId, subtaskId);

    // До вмешательства владельца карточка выглядит именно так, как он и
    // жаловался: работа стоит, а задача занята.
    const залипшая = await readTask(taskId);
    expect(залипшая.agent_state).toBe("in_progress");
    expect(залипшая.agent_stale).toBe(true);

    const released = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { state: null },
    });
    expect(released.statusCode).toBe(200);

    const свободная = await readTask(taskId);
    expect(свободная.agent_state).toBe(null);
    expect(свободная.agent_stale).toBe(false);
    expect(свободная.subtasks[0].state).toBe("pending");
  });

  it("заблокированный шаг тоже отпускается — иначе будильник обойдёт задачу", async () => {
    const { taskId, subtaskId } = await makeTask("Агент упёрся на шаге");

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", result: "нужен доступ к базе" },
    });

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { state: null },
    });

    // Задача не должна остаться «заблокированной» роллапом с шага: такие
    // задачи будильник пропускает («заблокирована, ждёт владельца»), и
    // возврат на доработку не привёл бы ни к чему.
    const свободная = await readTask(taskId);
    expect(свободная.agent_state).toBe(null);
    // Объяснение агента остаётся в карточке — гасится отметка о работе, а
    // не сама работа.
    expect(свободная.subtasks[0].result).toBe("нужен доступ к базе");
  });

  it("закрытая задача не показывает «агент пропал»", async () => {
    const { taskId, subtaskId } = await makeTask("Агент доделал, но не сдал");

    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expireLease(taskId, subtaskId);

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { status: "completed" },
    });

    const закрытая = await readTask(taskId);
    expect(закрытая.status).toBe("completed");
    expect(закрытая.agent_state).toBe(null);
    expect(закрытая.agent_stale).toBe(false);
  });

  it("снять задачу с агента может только владелец", async () => {
    const { taskId } = await makeTask("Чужой снять не может");

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: null },
    });
    expect(res.statusCode).toBe(400);
  });
});
