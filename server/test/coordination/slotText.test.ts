// Заголовок подзадачи в плане — это JSON-описание слота: сервер хранит
// `{"key":"work_1","title":"…","result":"…","role":"…","depends_on":[…],…}`
// в `subtasks.title` и сверяет по нему шаги. Владельцу это показывать нельзя:
// на телефон уходил весь JSON (02.11.2026). Сервер разбирает слот и отдаёт
// человеческий текст: название шага, результат и очередь ожидания.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/index.js";
import db from "../../src/db.js";
import type { FastifyInstance } from "fastify";

const uid = (): string => crypto.randomUUID();

let app: FastifyInstance;
let token: string;
let userId: string;
let taskId: string;
let planId: string;
let subtaskId: string;

const SLOT = {
  key: "work_1",
  title: "Восстановить рабочий прокси",
  result: "Порт 10811 возвращает HTTP 200, причина сбоя зафиксирована.",
  role: "infra_engineer",
  depends_on: [],
  parallel_with: ["work_2"],
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const u1 = db.prepare("SELECT id FROM users WHERE id = 'u1'").get() as { id: string } | undefined;
  if (u1) db.prepare("UPDATE users SET role = 'agent' WHERE id = ?").run("u1");
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: `slot-owner-${Date.now()}@test.local`, password: "test-password-strong-1", name: "Slot Owner" },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  userId = body.user.id;
  token = body.token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);

  taskId = `task_${uid()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, status, creator_id, assignee_id, agent_state, position, archived_at)
     VALUES (?, 'slot-test', 'active', ?, ?, NULL, 0, NULL)`,
  ).run(taskId, userId, userId);

  planId = `plan_${uid()}`;
  db.prepare(
    `INSERT INTO task_collaboration_plans (id, task_id, status, revision, profile, rationale, created_by)
     VALUES (?, ?, 'approved', 1, 'manual', 'slot-test', ?)`,
  ).run(planId, taskId, userId);

  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, 'work_1', 'infra_engineer', 'Restore proxy', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId);

  // Подзадача, у которой заголовок — JSON-слот (как их создаёт план).
  subtaskId = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks (id, task_id, title, position, done, collaboration_plan_id, plan_node_key)
     VALUES (?, ?, ?, 0, 0, ?, 'work_1')`,
  ).run(subtaskId, taskId, JSON.stringify(SLOT), planId);
});

afterAll(async () => {
  await app.close();
});

describe("координация: JSON-слот разбирается в человеческий текст", () => {
  it("название шага — человеческое, а не JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/tasks/${taskId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const payload = res.json() as { task_id: string; resolutions: Array<{ title?: string; notes?: string; waiting_for?: string[] }> };
    const ours = payload.resolutions.find((r) => r.title === SLOT.title);
    expect(ours, res.body).toBeTruthy();
    expect(ours!.title).not.toContain("{");
    expect(ours!.title).toBe(SLOT.title);
  });

  it("результат шага — человеческий текст, а не JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/subtasks/${subtaskId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const resolution = res.json() as { title?: string; notes?: string; waiting_for?: string[] };
    expect(resolution.title).toBe(SLOT.title);
    expect(resolution.notes ?? "").not.toContain("\"key\"");
  });

  it("на телефоне не остаётся простыни JSON", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/tasks/${taskId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
    });
    const payload = res.body;
    // Сырой JSON-слот не должен попадать в ответ целиком.
    expect(payload).not.toContain("\\\"parallel_with\\\"");
  });
});
