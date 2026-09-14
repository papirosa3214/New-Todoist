// GET /api/agent/can-stop — серверное правило «можно ли агенту закончить ход».
//
// Само событие «ход заканчивается» видно только внутри клиента, поэтому
// Stop-хук остаётся курьером, а решение принимается здесь и действует на
// любого исполнителя. Тестов на это правило не было вовсе — и оно разъехалось
// с собственной формулировкой: держало сессию за карточки, которые агент
// никогда не брал.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");

describe("can-stop: держит только за работу, которую агент реально ведёт", () => {
  let app: FastifyInstance;
  let agentId: string;
  let agentAuth: string;
  let ownerId: string;

  const uid = () => crypto.randomUUID();

  /** Активная задача на агенте с двумя нетронутыми шагами. */
  const makeTask = (title: string) => {
    const taskId = uid();
    db.prepare(
      `INSERT INTO tasks (id, title, status, creator_id, assignee_id)
       VALUES (?, ?, 'active', ?, ?)`,
    ).run(taskId, title, ownerId, agentId);
    for (const [i, step] of ["шаг раз", "шаг два"].entries()) {
      db.prepare(
        "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)",
      ).run(uid(), taskId, step, i + 1);
    }
    return taskId;
  };

  const canStop = async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/agent/can-stop",
      headers: { authorization: agentAuth },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "CanStopOwner",
        email: `can-stop-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = owner.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "CanStopAgent",
        email: `can-stop-agent-${Date.now()}@test`,
        password: "password123",
      },
    });
    agentId = agent.json().user.id;
    agentAuth = `Bearer ${agent.json().token}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("назначенная, но ни разу не начатая задача уходить не мешает", async () => {
    makeTask("Назначили заранее, никто не брал");

    // Владелец может назначить карточку впрок — это ещё не работа. Раньше
    // такая задача попадала в гейт как «задача, которую ты ведёшь», и выйти
    // из него было нельзя: claim её не трогает, а перевести в blocked сервер
    // не даёт («invalid transition» из состояния «не взята»). Сессия
    // запиралась насмерть на работе, к которой никто не притрагивался.
    const answer = await canStop();
    expect(answer.can_stop).toBe(true);
  });

  it("начатый шаг задачу удерживает", async () => {
    const taskId = makeTask("Работа пошла");
    const step = db
      .prepare("SELECT id FROM subtasks WHERE task_id = ? LIMIT 1")
      .get(taskId) as { id: string };
    db.prepare(
      "UPDATE subtasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now') WHERE id = ?",
    ).run(step.id);

    const answer = await canStop();
    expect(answer.can_stop).toBe(false);
    expect(answer.reason).toContain("Работа пошла");
  });

  it("взятая задача с незакрытыми шагами удерживает даже без движения по шагам", async () => {
    // Сначала убираем след предыдущего теста, иначе держать будет он.
    db.prepare(
      "UPDATE subtasks SET agent_state = NULL, agent_heartbeat_at = NULL, done = 1",
    ).run();

    const taskId = makeTask("Взята в работу");
    db.prepare("UPDATE tasks SET agent_state = 'in_progress' WHERE id = ?").run(
      taskId,
    );

    const answer = await canStop();
    expect(answer.can_stop).toBe(false);
    expect(answer.reason).toContain("Взята в работу");
  });

  it("закрытые шаги отпускают", async () => {
    db.prepare("UPDATE subtasks SET done = 1").run();
    db.prepare("UPDATE tasks SET agent_state = NULL WHERE assignee_id = ?").run(
      agentId,
    );

    const answer = await canStop();
    expect(answer.can_stop).toBe(true);
  });
});
