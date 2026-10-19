import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

// MAK-98: типизированный blocked, срок жизни сообщения роли, быстрый отказ
// при недоступном адресате, признак «меняет результат карточки».
describe("MAK-98: типизированный blocked и срок жизни вопроса роли", () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerToken: string;
  let agentId: string;
  let agentToken: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "OwnerTyped", email: "owner-typed@test", password: "password123" },
    });
    ownerId = owner.json().user.id;
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentTyped", email: "agent-typed@test", password: "password123" },
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
    db.pragma("foreign_keys = OFF");
    for (const id of created) {
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM notifications WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM comments WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM attempts WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(ownerId, agentId);
    db.pragma("foreign_keys = ON");
    await app.close();
  });

  async function claimedTask(title: string): Promise<string> {
    const createdRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title },
    });
    const id = createdRes.json().task.id as string;
    created.push(id);
    markReadyForPickup(id);
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(agentId, id);
    const claim = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/claim`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { session_id: `typed-${id}` },
    });
    expect(claim.statusCode).toBe(200);
    return id;
  }

  const stateOf = (id: string) =>
    (db.prepare("SELECT agent_state, block_type FROM tasks WHERE id = ?").get(id) as {
      agent_state: string | null;
      block_type: string | null;
    });
  const eventsOf = (id: string) =>
    db.prepare("SELECT kind, to_value FROM task_events WHERE task_id = ?").all(id) as Array<{
      kind: string;
      to_value: string | null;
    }>;

  async function block(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", comment: "нужно решение", ...payload },
    });
  }

  it("blocked без типа (после вызова помощи) → 400, состояние не меняется", async () => {
    const id = await claimedTask("Без типа");
    const res = await block(id, { help_skip_reason: "ни одна роль это не снимет" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/тип/i);
    expect(stateOf(id).agent_state).toBe("in_progress");
  });

  it("blocked с типом и причиной проходит, тип виден в ленте", async () => {
    const id = await claimedTask("С типом");
    const res = await block(id, {
      block_type: "needs_input",
      help_skip_reason: "нужен ответ владельца по существу",
    });
    expect(res.statusCode).toBe(200);
    expect(stateOf(id)).toMatchObject({ agent_state: "blocked", block_type: "needs_input" });
    expect(eventsOf(id).some((e) => e.kind === "block_type" && e.to_value === "needs_input")).toBe(true);
  });

  it("неизвестный тип отклоняется", async () => {
    const id = await claimedTask("Кривой тип");
    const res = await block(id, {
      block_type: "не-тип",
      help_skip_reason: "никто не решит",
    });
    expect(res.statusCode).toBe(400);
  });

  it("needs_input с признаком «меняет результат» → сигнал владельцу", async () => {
    const id = await claimedTask("Меняет результат");
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ?")
      .get(id) as { n: number };
    const res = await block(id, {
      block_type: "needs_input",
      changes_result: true,
      help_skip_reason: "решение меняет результат карточки",
    });
    expect(res.statusCode).toBe(200);
    expect(eventsOf(id).some((e) => e.kind === "owner_signal")).toBe(true);
    expect(eventsOf(id).some((e) => e.kind === "orchestrator_signal")).toBe(false);
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ?")
      .get(id) as { n: number };
    expect(after.n).toBeGreaterThan(before.n);
  });

  it("needs_input без признака → сигнал оркестратору", async () => {
    const id = await claimedTask("Не меняет результат");
    const res = await block(id, {
      block_type: "needs_input",
      help_skip_reason: "ответ не меняет результат",
    });
    expect(res.statusCode).toBe(200);
    expect(eventsOf(id).some((e) => e.kind === "orchestrator_signal")).toBe(true);
    expect(eventsOf(id).some((e) => e.kind === "owner_signal")).toBe(false);
  });

  it("повторный блок того же вида даёт событие оркестратору", async () => {
    const id = await claimedTask("Повторный блок");
    let res = await block(id, {
      block_type: "dependency",
      help_skip_reason: "жду зависимость",
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    expect(res.statusCode).toBe(200);
    res = await block(id, {
      block_type: "dependency",
      help_skip_reason: "снова жду зависимость",
    });
    expect(res.statusCode).toBe(200);
    expect(eventsOf(id).some((e) => e.kind === "block_type_repeated" && e.to_value === "dependency")).toBe(true);
  });

  it("блок шага без типа отклоняется, с типом — записывается", async () => {
    const taskId = await claimedTask("Шаг и тип");
    const sub = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "шаг" },
    });
    const subtaskId = sub.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "in_progress" },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", result: "нет компетенции", help_skip_reason: "никто не поможет" },
    });
    expect(denied.statusCode).toBe(400);

    const allowed = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        state: "blocked",
        result: "нет компетенции",
        help_skip_reason: "никто не поможет",
        block_type: "capability",
      },
    });
    expect(allowed.statusCode).toBe(200);
    const row = db
      .prepare("SELECT agent_state, block_type FROM subtasks WHERE id = ?")
      .get(subtaskId) as { agent_state: string; block_type: string };
    expect(row).toMatchObject({ agent_state: "blocked", block_type: "capability" });
  });

  // ── Срок жизни вопроса роли и быстрый отказ ──

  it("unit: решение по типу, адресат сигнала, истечение срока", async () => {
    const { evaluateBlockedType, blockSignalTarget, blockTypeFromReasonCode } =
      await import("../src/lib/blockedType.js");
    expect(evaluateBlockedType({ reason: "x" }).ok).toBe(false);
    expect(evaluateBlockedType({ blockType: "dependency", reason: "x" })).toMatchObject({
      ok: true,
      blockType: "dependency",
    });
    expect(evaluateBlockedType({ reasonCode: "insufficient_capability", reason: "x" })).toMatchObject({
      ok: true,
      blockType: "capability",
    });
    expect(evaluateBlockedType({ blockType: "dependency", reason: "" }).ok).toBe(false);
    expect(blockSignalTarget("needs_input", true)).toBe("owner");
    expect(blockSignalTarget("needs_input", false)).toBe("orchestrator");
    expect(blockSignalTarget("dependency", false)).toBeNull();
    expect(blockTypeFromReasonCode("permission_or_owner")).toBe("needs_input");

    const { questionExpired } = await import("../src/runtime/roleMessageWait.js");
    const now = new Date("2026-10-06T12:00:00Z");
    expect(questionExpired("2026-10-06 11:50:00", now, 900)).toBe(false);
    expect(questionExpired("2026-10-06 11:30:00", now, 900)).toBe(true);
  });

  it("вопрос без ответа за срок возвращается с исходом «срок истёк», отвеченный — нет", async () => {
    const { openRoleQuestion, answerRoleQuestionsBy, expireRoleQuestions } =
      await import("../src/runtime/roleMessageWait.js");
    const chatId = `c-${crypto.randomUUID()}`;
    db.prepare(
      "INSERT INTO chats (id, title, kind, created_by) VALUES (?, ?, 'group', ?)",
    ).run(chatId, "тест", ownerId);
    const mkMsg = (from: string) => {
      const messageId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id) VALUES (?, ?, ?, 'chat', ?)",
      ).run(messageId, from, "вопрос", chatId);
      return messageId;
    };
    const q1 = mkMsg(agentId);
    openRoleQuestion({
      messageId: q1,
      chatId,
      fromUserId: agentId,
      toUserId: ownerId,
      text: "проверь, пожалуйста",
    });
    db.prepare("UPDATE role_message_waiting SET created_at = datetime('now','-2 hours') WHERE message_id = ?").run(q1);

    const q2 = mkMsg(agentId);
    openRoleQuestion({
      messageId: q2,
      chatId,
      fromUserId: agentId,
      toUserId: ownerId,
      text: "и это тоже",
    });
    db.prepare("UPDATE role_message_waiting SET created_at = datetime('now','-2 hours') WHERE message_id = ?").run(q2);
    answerRoleQuestionsBy(chatId, ownerId, q2);

    const expired = expireRoleQuestions(new Date());
    expect(expired).toBe(1);
    const statuses = db
      .prepare("SELECT message_id, status FROM role_message_waiting WHERE chat_id = ? ORDER BY message_id")
      .all(chatId) as Array<{ message_id: string; status: string }>;
    expect(statuses.find((s) => s.message_id === q1)?.status).toBe("expired");
    expect(statuses.find((s) => s.message_id === q2)?.status).toBe("answered");
    const returned = db
      .prepare("SELECT text, reply_to_message_id FROM chat_messages WHERE chat_id = ? AND message_type = 'system'")
      .all(chatId) as Array<{ text: string; reply_to_message_id: string | null }>;
    expect(returned.some((r) => r.text.includes("срок истёк"))).toBe(true);
    db.prepare("DELETE FROM role_message_waiting WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(chatId);
  });

  it("этап адресата: отказ перечисляет этапы роли", async () => {
    const { pickRecipientSlot } = await import("../src/runtime/roleMessageWait.js");
    expect(pickRecipientSlot("qa", undefined, ["qa-1"])).toEqual({ slot: "qa-1" });
    expect(pickRecipientSlot("qa", "qa-2", ["qa-1", "qa-2"])).toEqual({ slot: "qa-2" });
    expect((pickRecipientSlot("qa", undefined, ["qa-1", "qa-2"]) as { refusal: string }).refusal).toContain("qa-1, qa-2");
    expect((pickRecipientSlot("qa", "чужой", ["qa-1"]) as { refusal: string }).refusal).toContain("Этапы qa в этом плане: qa-1");
    expect((pickRecipientSlot("qa", undefined, []) as { refusal: string }).refusal).toContain("taskflow_chat_send");
  });

  it("быстрый отказ: закрытый шаг адресата недоступен", async () => {
    const { evaluateRecipientAvailability } = await import("../src/runtime/roleMessageWait.js");
    const missing = evaluateRecipientAvailability({ recipientSubtaskId: "нет-такого-шага" });
    expect(missing.ok).toBe(false);
    expect(missing).toMatchObject({ code: "recipient_unavailable" });
    expect((missing as { error: string }).error).toContain("taskflow_chat_send");
    expect(evaluateRecipientAvailability({ recipientSubtaskId: null, toUserId: ownerId }).ok).toBe(true);
  });

  it("dependency-блок шага снимается сам, когда зависимость готова", async () => {
    const { liftDependencyBlocks } = await import("../src/runtime/planSubtaskAdmission.js");
    const createdRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Плановый зависимый шаг" },
    });
    const taskId = createdRes.json().task.id as string;
    created.push(taskId);
    const planId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by) VALUES (?, ?, 1, 'approved', 'delivery', '', ?)",
    ).run(planId, taskId, ownerId);
    for (const [key, role] of [["b", "builder"], ["q", "qa"]] as const) {
      db.prepare(
        "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES (?, ?, ?, ?, '')",
      ).run(crypto.randomUUID(), planId, key, role);
    }
    db.prepare(
      "INSERT INTO task_collaboration_plan_edges (id, plan_id, from_slot_key, to_slot_key, start_condition) VALUES (?, ?, 'b', 'q', 'accepted')",
    ).run(crypto.randomUUID(), planId);
    const bId = crypto.randomUUID();
    const qId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position, done, collaboration_plan_id, plan_node_key, agent_state) VALUES (?, ?, 'B', 0, 1, ?, 'b', 'review')",
    ).run(bId, taskId, planId);
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, position, done, collaboration_plan_id, plan_node_key, agent_state, block_type, blocked_at) VALUES (?, ?, 'Q', 1, 0, ?, 'q', 'blocked', 'dependency', datetime('now'))",
    ).run(qId, taskId, planId);

    const lifted = liftDependencyBlocks(planId, taskId, ownerId);
    expect(lifted).toBe(1);
    const q = db
      .prepare("SELECT agent_state, block_type FROM subtasks WHERE id = ?")
      .get(qId) as { agent_state: string | null; block_type: string | null };
    expect(q.block_type).toBeNull();
    expect(q.agent_state).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'dependency_block_lifted'").get(taskId) as { n: number }).n,
    ).toBe(1);
  });
});
