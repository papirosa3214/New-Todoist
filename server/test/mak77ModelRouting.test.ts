// MAK-77: запись модели «провайдер/модель» и модель конкретного шага плана.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { parseModelRef } from "../src/lib/attemptModel.js";

describe("MAK-77: parseModelRef", () => {
  it("разбирает провайдера из префикса", () => {
    expect(parseModelRef("opencode-go/qwen3.8-flash")).toEqual({ provider: "opencode-go", id: "qwen3.8-flash" });
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
    expect(parseModelRef("xai/grok-4.7")).toEqual({ provider: "xai", id: "grok-4.7" });
    expect(parseModelRef("anthropic/claude-sonnet-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });
  });

  it("запись без префикса работает по-старому", () => {
    expect(parseModelRef("MiniMax-M3")).toEqual({ provider: "minimax", id: "MiniMax-M3" });
    expect(parseModelRef("claude-opus-5")).toEqual({ provider: "anthropic", id: "claude-opus-5" });
    expect(parseModelRef("gpt-5.6-sol")).toEqual({ provider: "openai", id: "gpt-5.6-sol" });
  });

  it("неизвестный префикс не режет запись", () => {
    expect(parseModelRef("somevendor/model-x")).toEqual({ provider: "minimax", id: "somevendor/model-x" });
  });
});

describe("MAK-77: модель шага плана", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentToken: string;
  let taskId: string;
  let subtaskId: string;

  beforeAll(async () => {
    app = await buildApp();
    const ownerReg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: "owner@mak77r.test", password: "password123" } });
    ownerToken = ownerReg.json().token;
    ownerId = ownerReg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);

    const agentReg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Agent", email: "agent@mak77r.test", password: "password123" } });
    db.prepare("UPDATE users SET type='ai' WHERE id=?").run(agentReg.json().user.id);
    const api = await app.inject({ method: "POST", url: "/api/auth/api-token", headers: { authorization: `Bearer ${agentReg.json().token}` } });
    agentToken = api.json().api_token;

    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: `Bearer ${ownerToken}` }, payload: { title: "MAK-77 routing" } });
    taskId = task.json().task.id;
    subtaskId = crypto.randomUUID();
    db.prepare("INSERT INTO subtasks (id, task_id, title, done, position) VALUES (?, ?, 'шаг', 0, 0)").run(subtaskId, taskId);
  });

  afterAll(async () => {
    await app.close();
  });

  const put = (token: string, id: string, body: unknown) =>
    app.inject({ method: "PUT", url: `/api/subtasks/${id}/model`, headers: { authorization: `Bearer ${token}` }, payload: body as object });

  it("колонка subtasks.model есть и по умолчанию пустая", () => {
    const row = db.prepare("SELECT model FROM subtasks WHERE id = ?").get(subtaskId) as { model: string | null };
    expect(row.model).toBeNull();
  });

  it("владелец задаёт модель шага, событие пишется", async () => {
    const res = await put(ownerToken, subtaskId, { model: "opencode-go/qwen3.8-flash" });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe("opencode-go/qwen3.8-flash");
    const row = db.prepare("SELECT model FROM subtasks WHERE id = ?").get(subtaskId) as { model: string };
    expect(row.model).toBe("opencode-go/qwen3.8-flash");
    const ev = db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND kind = 'subtask_model_set'").get(taskId) as { n: number };
    expect(ev.n).toBe(1);
  });

  it("null возвращает шаг на настройки роли", async () => {
    const res = await put(ownerToken, subtaskId, { model: null });
    expect(res.statusCode).toBe(200);
    expect((db.prepare("SELECT model FROM subtasks WHERE id = ?").get(subtaskId) as { model: string | null }).model).toBeNull();
  });

  it("роль (агент) задать модель шага не может", async () => {
    const res = await put(agentToken, subtaskId, { model: "opencode-go/qwen3.8-flash" });
    expect(res.statusCode).toBe(403);
  });

  it("неизвестный провайдер и пустая строка отклоняются", async () => {
    expect((await put(ownerToken, subtaskId, { model: "ghost/model-x" })).statusCode).toBe(400);
    expect((await put(ownerToken, subtaskId, { model: "  " })).statusCode).toBe(400);
  });

  it("идущий и сданный шаг не меняется", async () => {
    db.prepare("UPDATE subtasks SET agent_state='in_progress' WHERE id = ?").run(subtaskId);
    expect((await put(ownerToken, subtaskId, { model: "opencode-go/qwen3.8-flash" })).statusCode).toBe(409);
    db.prepare("UPDATE subtasks SET agent_state=NULL, done=1 WHERE id = ?").run(subtaskId);
    expect((await put(ownerToken, subtaskId, { model: "opencode-go/qwen3.8-flash" })).statusCode).toBe(409);
  });
});
