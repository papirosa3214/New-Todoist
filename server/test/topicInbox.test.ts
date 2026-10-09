// Карточка 6f180f38, шаг 3 «Устойчивая доставка сообщений и результатов
// ролям». Подтверждённый аудитом (карточка 57d045eb, пробел №5) пробел:
// строки `slot_topic_inbox` с `delivered_at IS NULL` копятся на закрытых
// и прерванных слотах, пока владелец не вмешается руками.
//
// Этот файл проверяет, что:
//   1) `closeStaleInboxForSubtask` закрывает только строки с
//      `delivered_at IS NULL`, не трогает уже доставленные;
//   2) повторный вызов — no-op (идемпотентность);
//   3) `taskflow_subtask_done` после закрытия слота вызывает закрытие
//      его хвоста в инбоксе темы;
//   4) `recoverInterruptedPlanSubtasks` тоже гасит хвост на прерванном
//      `in_progress`-слоте и на снятом `todo`/`blocked`-слоте;
//   5) `pendingInboxCountForSubtask` и `pendingInboxCountsByTask` показывают
//      только реальные pending-строки.
//
// Изолированная БД через `test/setup.ts`; рабочий `taskflow.db` не трогаем.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  closeStaleInboxForSubtask,
  pendingInboxCountForSubtask,
  pendingInboxCountsByTask,
} from "../src/runtime/topicInbox.js";
import { recoverInterruptedPlanSubtasks } from "../src/runtime/planSubtaskAdmission.js";

const OWNER = "u1"; // миграция 039_seed_owner
const BUILDER = "role_builder"; // roleUserId("builder")

function ensureRoleUsers(): void {
  // role-routing.yaml + agent-inbox.test.ts: для FK на comments.user_id
  // (roleNote) и `agent_id` слота плана нужна явная учётка role_builder.
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(BUILDER)) {
    db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type) " +
        "VALUES (?, ?, ?, '', 'agent', 'ai')",
    ).run(BUILDER, "Разработчик", "builder@topic.test");
  }
}

function insertTask(creatorId: string, title = "доставка"): { taskId: string } {
  const taskId = crypto.randomUUID();
  db.prepare("INSERT INTO tasks (id, title, status, creator_id) VALUES (?, ?, 'active', ?)")
    .run(taskId, title, creatorId);
  return { taskId };
}

function insertPlanWithNode(taskId: string, slotKey = "executor"): { planId: string } {
  const planId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, " +
      "rationale, created_by) VALUES (?, ?, 1, 'approved', 'single_executor', '', ?)",
  ).run(planId, taskId, OWNER);
  db.prepare(
    "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, " +
      "expected_result, origin) VALUES (?, ?, ?, 'builder', 'сделать', 'owner')",
  ).run(crypto.randomUUID(), planId, slotKey);
  return { planId };
}

function insertPlanSubtask(args: {
  taskId: string;
  planId: string;
  slotKey?: string;
  state?: "todo" | "in_progress" | "blocked" | null;
  agentId?: string | null;
}): string {
  const subtaskId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO subtasks (id, task_id, title, position, agent_id, agent_state, " +
      "collaboration_plan_id, plan_node_key, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
  ).run(
    subtaskId,
    args.taskId,
    "узел плана",
    1,
    args.agentId ?? null,
    args.state ?? null,
    args.planId,
    args.slotKey ?? "executor",
  );
  return subtaskId;
}

function insertChatMessage(taskId: string, text = "тема"): string {
  const messageId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) " +
      "VALUES (?, ?, ?, 'chat', NULL)",
  ).run(messageId, OWNER, text);
  return messageId;
}

function insertInboxRows(subtaskId: string, messageIds: string[]): void {
  for (const messageId of messageIds) {
    db.prepare(
      "INSERT INTO slot_topic_inbox (message_id, subtask_id, delivered_at) VALUES (?, ?, NULL)",
    ).run(messageId, subtaskId);
  }
}

function inboxRows(subtaskId: string): Array<{
  message_id: string;
  delivered_at: string | null;
}> {
  return db
    .prepare(
      "SELECT message_id, delivered_at FROM slot_topic_inbox WHERE subtask_id = ? ORDER BY message_id",
    )
    .all(subtaskId) as Array<{ message_id: string; delivered_at: string | null }>;
}

describe("topicInbox / закрытие хвостов slot_topic_inbox", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;

  beforeAll(async () => {
    app = await buildApp();
    ensureRoleUsers();
    const ownerResp = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerTopic", email: "owner@topic.test", password: "password123" },
    });
    ownerToken = ownerResp.json().token;
    ownerId = ownerResp.json().user.id;
  });

  beforeEach(() => {
    // Очистка идёт снизу вверх по FK: сначала листья (комментарии,
    // попытки, строки инбокса), потом узлы, потом задача.
    db.prepare("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE title='доставка')").run();
    db.prepare("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title='доставка')").run();
    db.prepare("DELETE FROM slot_topic_inbox WHERE subtask_id IN (SELECT id FROM subtasks WHERE title='узел плана')").run();
    db.prepare("DELETE FROM chat_messages WHERE channel='chat' AND chat_id IS NULL").run();
    db.prepare("DELETE FROM attempts WHERE subtask_id IN (SELECT id FROM subtasks WHERE title='узел плана')").run();
    db.prepare("DELETE FROM subtasks WHERE title='узел плана'").run();
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE origin='owner' AND role_key='builder' AND plan_id IN (SELECT id FROM task_collaboration_plans WHERE rationale='' AND profile='single_executor')").run();
    db.prepare("DELETE FROM task_collaboration_plans WHERE rationale='' AND profile='single_executor'").run();
    db.prepare("DELETE FROM tasks WHERE title='доставка'").run();
  });

  it("closeStaleInboxForSubtask закрывает только delivered_at IS NULL и идемпотентен", () => {
    const { taskId } = insertTask(ownerId);
    const { planId } = insertPlanWithNode(taskId);
    const subtaskId = insertPlanSubtask({ taskId, planId });
    const msg1 = insertChatMessage(taskId, "первое");
    const msg2 = insertChatMessage(taskId, "второе");
    insertInboxRows(subtaskId, [msg1, msg2]);
    // Эмулируем уже доставленную строку через прямой UPDATE: инбокс — один
    // и тот же путь, что в `inProcessRun.ts:1142-1150`, тут это побочный
    // эффект, который мы не хотим терять.
    db.prepare(
      "UPDATE slot_topic_inbox SET delivered_at = datetime('now') WHERE message_id = ?",
    ).run(msg1);

    const closedFirst = closeStaleInboxForSubtask(subtaskId);
    expect(closedFirst).toBe(1); // только msg2 был NULL
    const closedSecond = closeStaleInboxForSubtask(subtaskId);
    expect(closedSecond).toBe(0); // повторный вызов — no-op
    const rows = inboxRows(subtaskId);
    expect(rows).toHaveLength(2);
    const delivered1 = rows.find((r) => r.message_id === msg1)?.delivered_at;
    const delivered2 = rows.find((r) => r.message_id === msg2)?.delivered_at;
    expect(delivered1).not.toBeNull();
    expect(delivered2).not.toBeNull();
  });

  it("taskflow_subtask_done снимает хвост инбокса темы для слота плана", async () => {
    const { taskId } = insertTask(ownerId);
    const { planId } = insertPlanWithNode(taskId);
    const subtaskId = insertPlanSubtask({
      taskId,
      planId,
      state: "in_progress",
      agentId: BUILDER,
    });
    const msg = insertChatMessage(taskId, "сообщение владельца");
    insertInboxRows(subtaskId, [msg]);
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(1);

    // Подзадача-узел плана закрывается через PATCH /api/subtasks/:id (done=1).
    // Владелец вправе править любую задачу (`access.ts`), так что достаточно
    // токена владельца — ровно та же схема, что в agent-inbox.test.ts.
    const resp = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subtaskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { done: true, result: "готово" },
    });
    expect(resp.statusCode).toBe(200);
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(0);
    const rows = inboxRows(subtaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered_at).not.toBeNull();
  });

  it("recoverInterruptedPlanSubtasks закрывает хвост для прерванного in_progress", async () => {
    const { taskId } = insertTask(ownerId);
    const { planId } = insertPlanWithNode(taskId, "executor_running");
    const subtaskId = insertPlanSubtask({
      taskId,
      planId,
      slotKey: "executor_running",
      state: "in_progress",
      agentId: BUILDER,
    });
    // attempts.executor_id — обязателен (FK на users), role_key там нет —
    // роль восстанавливается через subtask.agent_id (см. db.ts attempts DDL).
    const attemptId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at, ended_at, outcome) " +
        "VALUES (?, ?, ?, ?, datetime('now'), NULL, NULL)",
    ).run(attemptId, taskId, subtaskId, BUILDER);
    db.prepare("UPDATE subtasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, subtaskId);

    const msg = insertChatMessage(taskId, "перед обрывом");
    insertInboxRows(subtaskId, [msg]);
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(1);

    // Сценарий «прерванный ход» — прямой вызов recovery с явной причиной.
    // NB: этот вызов может стартовать новый план-запуск; но в нашем
    // изолированном прогоне worker недоступен, поэтому попытка останется
    // нестартованной — нас интересует только инбокс.
    await recoverInterruptedPlanSubtasks({ reason: "тест: обрыв" });
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(0);
  });

  it("recoverInterruptedPlanSubtasks закрывает хвост для снятого todo/blocked", async () => {
    const { taskId } = insertTask(ownerId);
    const { planId } = insertPlanWithNode(taskId, "executor_todo");
    const subtaskId = insertPlanSubtask({
      taskId,
      planId,
      slotKey: "executor_todo",
      state: "todo",
      agentId: null,
    });
    const msg = insertChatMessage(taskId, "висит в todo");
    insertInboxRows(subtaskId, [msg]);
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(1);

    await recoverInterruptedPlanSubtasks({ reason: "тест: снят todo" });
    expect(pendingInboxCountForSubtask(subtaskId)).toBe(0);
  });

  it("pendingInboxCountsByTask показывает только слоты с реальными pending-строками", () => {
    const { taskId } = insertTask(ownerId);
    const { planId } = insertPlanWithNode(taskId, "executor");
    const s1 = insertPlanSubtask({ taskId, planId, slotKey: "executor" });
    const s2 = insertPlanSubtask({ taskId, planId, slotKey: "executor_other" });
    const msg1 = insertChatMessage(taskId, "s1");
    const msg2 = insertChatMessage(taskId, "s2");
    const msg3 = insertChatMessage(taskId, "s2 done");
    insertInboxRows(s1, [msg1]);
    insertInboxRows(s2, [msg2, msg3]);
    // Закроем одну строку у s2 напрямую — диагностика должна учитывать только NULL.
    db.prepare("UPDATE slot_topic_inbox SET delivered_at = datetime('now') WHERE message_id = ?")
      .run(msg3);

    const counts = pendingInboxCountsByTask(taskId);
    expect(counts).toHaveLength(2);
    const s1Count = counts.find((c) => c.subtask_id === s1)?.pending;
    const s2Count = counts.find((c) => c.subtask_id === s2)?.pending;
    expect(s1Count).toBe(1);
    expect(s2Count).toBe(1); // msg2 остался, msg3 закрыт руками
  });
});