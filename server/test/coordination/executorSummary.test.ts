// Сводка по исполнителям карточки — «окно исполнителя» на телефоне.
//
// Владелец открыл «Координацию» и по факту ничего не мог: узлы показывали
// состояние, но не отвечали на вопрос «кто это делает, чего ждёт и что ему
// сказать». Эндпоинт собирает по слоту всё, что нужно для управления, и
// отдаёт человеческий текст — телефон ничего не разбирает.
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
let builderSlot: string;
let qaSlot: string;
let chatId: string;

const SLOT = {
  key: "work_1",
  title: "Восстановить рабочий прокси",
  result: "Порт 10811 возвращает HTTP 200, причина сбоя зафиксирована.",
  role: "infra_engineer",
  depends_on: [],
  parallel_with: [],
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `exec-owner-${Date.now()}@test.local`,
      password: "test-password-strong-1",
      name: "Exec Owner",
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const body = reg.json() as { user: { id: string }; token: string };
  userId = body.user.id;
  token = body.token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);

  taskId = `task_${uid()}`;
  db.prepare(
    `INSERT INTO tasks (id, title, status, creator_id, assignee_id, agent_state, position, archived_at)
     VALUES (?, 'executor-summary', 'active', ?, ?, NULL, 0, NULL)`,
  ).run(taskId, userId, userId);

  planId = `plan_${uid()}`;
  db.prepare(
    `INSERT INTO task_collaboration_plans (id, task_id, status, revision, profile, rationale, created_by)
     VALUES (?, ?, 'approved', 1, 'manual', 'executor-summary', ?)`,
  ).run(planId, taskId, userId);

  db.prepare(
    `INSERT INTO task_collaboration_plan_nodes
       (id, plan_id, slot_key, role_key, expected_result, output_artifact_json, instructions, iteration, skipped_at, rework_of_key)
     VALUES (?, ?, 'work_1', 'infra_engineer', 'Restore proxy', NULL, NULL, 0, NULL, NULL),
            (?, ?, 'work_2', 'qa', 'Check the fix', NULL, NULL, 0, NULL, NULL)`,
  ).run(`node_${uid()}`, planId, `node_${uid()}`, planId);

  builderSlot = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks (id, task_id, title, position, done, collaboration_plan_id, plan_node_key)
     VALUES (?, ?, ?, 0, 0, ?, 'work_1')`,
  ).run(builderSlot, taskId, JSON.stringify(SLOT), planId);

  qaSlot = `sub_${uid()}`;
  db.prepare(
    `INSERT INTO subtasks (id, task_id, title, position, done, collaboration_plan_id, plan_node_key)
     VALUES (?, ?, 'Проверить починку', 1, 1, ?, 'work_2')`,
  ).run(qaSlot, taskId, planId);

  // Тема задачи: в ней владелец пишет исполнителю и получает ответы.
  chatId = `chat_${uid()}`;
  db.prepare(
    `INSERT INTO chats (id, title, kind, created_by, task_id, project_id, parent_chat_id)
     VALUES (?, 'Тема задачи', 'group', ?, ?, NULL, NULL)`,
  ).run(chatId, userId, taskId);
  db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(chatId, userId);

  // Вопрос роли владельцу: «какой бэкенд выбрать?»
  const builder = db
    .prepare("SELECT id FROM users WHERE role_key='builder' AND type='ai' LIMIT 1")
    .get() as { id: string } | undefined;
  if (builder) {
    db.prepare(
      `INSERT INTO chat_questions (id, chat_id, role_id, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, 'open', datetime('now'))`,
    ).run(
      `q_${uid()}`,
      chatId,
      builder.id,
      JSON.stringify({
        questions: [
          {
            question: "Какой бэкенд выбрать?",
            header: "Бэкенд",
            options: [{ label: "Прокси" }, { label: "Прямой" }],
          },
        ],
        note: "Ответь в чате — продолжу.",
      }),
    );
  }
});

afterAll(async () => {
  await app.close();
});

type Executor = {
  subtask_id: string;
  title: string;
  role: string | null;
  role_title: string | null;
  executor_id: string | null;
  state: string;
  state_title: string;
  status_text: string;
  waiting_for: string[];
  addressable: boolean;
  address_block_reason: string | null;
  pending_messages: number;
  questions: Array<{ id: string; payload: Record<string, unknown> | null }>;
  messages: Array<{ id: string; text: string; direction: string }>;
};

type Summary = {
  task_id: string;
  task_title: string;
  orchestrator: { role: string; title: string; executor_id: string; slot_id: string | null };
  executors: Executor[];
  pending_questions: Array<{ id: string }>;
};

async function fetchSummary(): Promise<Summary> {
  const res = await app.inject({
    method: "GET",
    url: `/api/coordination/tasks/${taskId}/executors`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Summary;
}

describe("координация: сводка по исполнителям", () => {
  it("по каждому слоту есть роль, название и человеческое состояние", async () => {
    const summary = await fetchSummary();
    expect(summary.task_id).toBe(taskId);
    expect(summary.executors.length).toBe(2);
    const work = summary.executors.find((e) => e.subtask_id === builderSlot);
    expect(work, JSON.stringify(summary)).toBeTruthy();
    expect(work!.role).toBe("infra_engineer");
    expect(work!.role_title).toBeTruthy();
    expect(work!.executor_id).toBeTruthy();
    // Название шага — человеческое, а не JSON-слот.
    expect(work!.title).toBe(SLOT.title);
    expect(work!.title).not.toContain("{");
    expect(work!.state_title.length).toBeGreaterThan(0);
    expect(work!.status_text.length).toBeGreaterThan(0);
  });

  it("закрытый шаг помечен как готовый и недоступен для адресации", async () => {
    const summary = await fetchSummary();
    const done = summary.executors.find((e) => e.subtask_id === qaSlot);
    expect(done, JSON.stringify(summary)).toBeTruthy();
    expect(done!.state).toBe("done");
    expect(done!.state_title).toBe("Готово");
    expect(done!.addressable).toBe(false);
  });

  it("оркестратор известен: роль, название и учётка", async () => {
    const summary = await fetchSummary();
    expect(summary.orchestrator.role).toBe("code_orchestrator");
    expect(summary.orchestrator.executor_id).toBe("role_code_orchestrator");
    expect(summary.orchestrator.title.length).toBeGreaterThan(0);
  });

  it("вопрос роли, ждущий владельца, попадает в сводку", async () => {
    const summary = await fetchSummary();
    const questions = [
      ...summary.executors.flatMap((e) => e.questions.map((q) => ({ ...q, role: e.role }))),
      ...summary.pending_questions,
    ];
    expect(questions.length, JSON.stringify(summary)).toBeGreaterThan(0);
    expect(questions[0].payload).toBeTruthy();
  });

  it("чужая карточка не отдаётся", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/coordination/tasks/task_missing/executors`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
