// Владелец 20.10.2026: QA оставил в карточке три служебных комментария
// («Материал собран», «Начинаю проверку», «Проверка закончена»), каждый
// поставил исполнителю карточки задание «ответь на комментарий», и шаг
// Критика полчаса стоял в очереди за ними. Правило: роль реагирует на
// комментарий только владельца; между собой роли говорят в чате.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return {
    ...actual,
    runRoleInProcess: async () => ({
      runId: "comment-wake-run",
      completion: Promise.resolve(),
    }),
  };
});

import { buildApp } from "../src/index.js";
import db, { hashApiToken } from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

describe("комментарий будит роль только от владельца", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  const qaToken = `tf_comment_wake_qa_${Date.now()}`;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "comment-wake owner",
        email: `comment-wake-${Date.now()}@test`,
        password: "password123",
      },
    });
    db.prepare(
      "UPDATE users SET role='owner', task_intake_mode='manual' WHERE id=?",
    ).run(reg.json().user.id);
    ownerAuth = { authorization: `Bearer ${reg.json().token}` };
    db.prepare("UPDATE users SET api_token=? WHERE id='role_qa'").run(hashApiToken(qaToken));
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function taskAssignedToBuilder(): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Карточка у Разработчика" },
    });
    const id = (r.json().task as { id: string }).id;
    db.prepare("UPDATE tasks SET assignee_id='role_builder', creator_id='role_qa' WHERE id=?").run(
      id,
    );
    return id;
  }

  const commentJobs = (taskId: string) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM role_run_jobs WHERE task_id=? AND reason='commented'",
        )
        .get(taskId) as { n: number }
    ).n;

  it("комментарий владельца ставит исполнителю задание", async () => {
    const taskId = await taskAssignedToBuilder();
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: ownerAuth,
      payload: { text: "Поправь заголовок" },
    });
    expect(r.statusCode).toBeLessThan(300);
    expect(commentJobs(taskId)).toBe(1);
  });

  it("комментарий другой роли исполнителя не будит", async () => {
    const taskId = await taskAssignedToBuilder();
    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${qaToken}` },
      payload: { text: "Начинаю проверку по критериям приёмки" },
    });
    expect(r.statusCode).toBeLessThan(300);
    expect(commentJobs(taskId)).toBe(0);
  });

  it("комментарий владельца будит роль, чей слот в блоке, а старт слота её не вытесняет", async () => {
    const { followSlotAssignee } = await import("../src/runtime/planSubtaskAdmission.js");
    const taskId = await taskAssignedToBuilder();
    db.prepare("UPDATE tasks SET assignee_id='role_qa' WHERE id=?").run(taskId);
    db.prepare(
      "INSERT INTO subtasks(id,task_id,title,agent_state,agent_id,block_type) VALUES(?,?,?,'blocked','role_builder','needs_input')",
    ).run(`blocked-${taskId}`, taskId, "Шаг Разработчика ждёт владельца");
    const assignee = () => (db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(taskId) as { assignee_id: string }).assignee_id;

    const r = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: ownerAuth,
      payload: { text: "Ответ на твой вопрос: делай вариант А" },
    });
    expect(r.statusCode).toBeLessThan(300);
    expect(assignee()).toBe("role_builder");
    expect(commentJobs(taskId)).toBe(1);

    followSlotAssignee(taskId, "critic_verifier", "taskflow_system");
    expect(assignee()).toBe("role_builder");
  });
});
