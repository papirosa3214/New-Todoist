import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

// Карточка cd10bf34: перед blocked агент обязан проверить, может ли помочь
// другая роль/модель, и позвать — либо объяснить, почему никто не решит.
// Гейт живёт в lib/blockedHelp.ts и подключён к /state, /stop и /work.
describe("перед blocked — проверь и позови помощь", () => {
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
      payload: { name: "OwnerHelpGate", email: "owner-help-gate@test", password: "password123" },
    });
    ownerId = owner.json().user.id;
    ownerToken = owner.json().token;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const agent = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentHelpGate", email: "agent-help-gate@test", password: "password123" },
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
    for (const id of created) {
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM comments WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM attempts WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(id);
      db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(ownerId, agentId);
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
      payload: { session_id: `help-gate-${id}` },
    });
    expect(claim.statusCode).toBe(200);
    return id;
  }

  const stateOf = (id: string) =>
    (db.prepare("SELECT agent_state FROM tasks WHERE id = ?").get(id) as { agent_state: string | null }).agent_state;

  const eventsOf = (id: string) =>
    db.prepare("SELECT kind, to_value FROM task_events WHERE task_id = ?").all(id) as Array<{ kind: string; to_value: string | null }>;

  it("blocked по решаемой причине без отметки о помощи → 409, состояние не меняется", async () => {
    const id = await claimedTask("Решаемая причина без помощи");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", comment: "не понимаю, как двигаться дальше" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/позови/i);
    expect(res.json().candidates).toContain("architect");
    expect(stateOf(id)).toBe("in_progress");
    expect(
      eventsOf(id).some((e) => e.kind === "state_changed" && e.to_value === "blocked"),
    ).toBe(false);
  });

  it("blocked с help_attempt («кого звал, что ответили») проходит и виден в ленте", async () => {
    const id = await claimedTask("Звал помощь");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        state: "blocked",
        block_type: "needs_input",
        comment: "после совещания всё равно не сходится",
        help_attempt: "спросил architect в теме, ответ: нужен доступ к внешнему сервису",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(stateOf(id)).toBe("blocked");
    const help = eventsOf(id).find((e) => e.kind === "help_requested");
    expect(help).toBeTruthy();
    expect(help!.to_value).toContain("architect");
  });

  it("blocked с help_skip_reason («почему никто не решит») проходит как «без вызова помощи»", async () => {
    const id = await claimedTask("Никто не решит");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        state: "blocked",
        block_type: "needs_input",
        comment: "тупик",
        help_skip_reason: "ни одна роль это не снимет, вопрос к владельцу по существу",
      },
    });
    expect(res.statusCode).toBe(200);
    const evt = eventsOf(id).find((e) => e.kind === "blocked_without_help_call");
    expect(evt).toBeTruthy();
  });

  it("blocked «нужен доступ» проходит без нового поля, как раньше", async () => {
    const id = await claimedTask("Нужен доступ");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/state`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { state: "blocked", block_type: "needs_input", comment: "нужен доступ к внешнему API" },
    });
    expect(res.statusCode).toBe(200);
    expect(stateOf(id)).toBe("blocked");
    expect(eventsOf(id).some((e) => e.kind === "blocked_without_help_call")).toBe(true);
  });

  it("/stop с different_competence без помощи → 409, с help_attempt → blocked", async () => {
    const id = await claimedTask("Другая компетенция");
    const attemptId = (
      db.prepare("SELECT current_attempt_id FROM tasks WHERE id = ?").get(id) as { current_attempt_id: string }
    ).current_attempt_id;
    const denied = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/stop`,
      headers: { authorization: `Bearer ${agentToken}`, "x-agent-attempt-id": attemptId },
      payload: { reason_code: "different_competence", comment: "нужна другая роль" },
    });
    expect(denied.statusCode).toBe(409);

    const allowed = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/stop`,
      headers: { authorization: `Bearer ${agentToken}`, "x-agent-attempt-id": attemptId },
      payload: {
        reason_code: "different_competence",
        comment: "нужна другая роль",
        help_attempt: "позвал designer, ответ: это не дизайн, а серверная логика",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(stateOf(id)).toBe("blocked");
    expect(eventsOf(id).some((e) => e.kind === "help_requested")).toBe(true);
  });

  it("blocked шага без помощи → 409, с help_attempt → blocked", async () => {
    const taskId = await claimedTask("Шаг без помощи");
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
      payload: { state: "blocked", result: "не получается" },
    });
    expect(denied.statusCode).toBe(409);

    const allowed = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        state: "blocked",
        block_type: "capability",
        result: "не получается",
        help_attempt: "consult дал совет, но он не подошёл",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(
      (db.prepare("SELECT agent_state FROM subtasks WHERE id = ?").get(subtaskId) as { agent_state: string })
        .agent_state,
    ).toBe("blocked");
    expect(eventsOf(taskId).some((e) => e.kind === "help_requested")).toBe(true);
  });

  it("общая инструкция ролей содержит порядок «перед blocked»", async () => {
    // Источник правды изменился (20.10.2026): промпты ролей из
    // `server/scripts/role-prompts/*.md` убраны в Корзину, инструкции ролей
    // живут в общем каноне и в instructionDefaults.ts. Тест прежде стоял на
    // удалённой папке и падал с ENOENT (24.10.2026, аудит качества тестов).
    //
    // Проверяем то, что реально уходит в модель: блок «УПЁРСЯ» в общих
    // инструкциях требует help_attempt (кого звал, что ответили) либо
    // help_skip_reason (почему никто не решит) — это и есть смысл гейта.
    const { INSTRUCTION_DEFAULTS } = await import("../src/runtime/instructionDefaults.js");
    const общие = Object.values(INSTRUCTION_DEFAULTS).join("\n");
    expect(общие).toMatch(/help_attempt/);
    expect(общие).toMatch(/help_skip_reason/);
    // Порядок именно такой: сначала попытка снять препятствие, потом
    // блокировка — иначе роль объявит blocked, не спросив никого.
    const упёрся = общие.slice(общие.indexOf("УПЁРСЯ"));
    const проба = упёрся.indexOf("Сначала попробуй снять препятствие");
    const блок = упёрся.indexOf("state=blocked");
    expect(проба, "нет «сначала попробуй снять препятствие»").toBeGreaterThanOrEqual(0);
    expect(блок, "нет «state=blocked»").toBeGreaterThanOrEqual(0);
    expect(проба, "блокировка идёт ДО попытки позвать помощь").toBeLessThan(блок);
  });

  it("unit: маркеры и решение гейта", async () => {
    const { evaluateBlockedHelp, isOwnerOrEnvBlock } = await import("../src/lib/blockedHelp.js");
    expect(isOwnerOrEnvBlock(null, "нужен доступ к базе")).toBe(true);
    expect(isOwnerOrEnvBlock(null, "задача непонятна")).toBe(false);
    expect(isOwnerOrEnvBlock("permission_or_owner", "что угодно")).toBe(true);
    expect(evaluateBlockedHelp({ text: "тупик" }).ok).toBe(false);
    expect(evaluateBlockedHelp({ text: "тупик", helpAttempt: "звал qa" })).toMatchObject({
      ok: true,
      kind: "help_requested",
    });
    expect(evaluateBlockedHelp({ text: "тупик", helpSkipReason: "никто" })).toMatchObject({
      ok: true,
      kind: "blocked_without_help_call",
    });
  });
});
