// Карточка 5f292e87 (MVP надёжной доставки поручений) — реальный поток.
// Через HTTP (app.inject): назначение задачи, сообщение в чат по задаче,
// чтение pending, mark, возврат review→in_progress, безопасность адресата.
// Одноразовая база (test/setup.ts), живой сервер не трогаем.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

describe("agent inbox: реальный поток (5f292e87)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentAToken: string;
  let agentAId: string;
  let agentBToken: string;
  let agentBId: string;
  let taskId: string;

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await buildApp();

    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Owner",
        email: "owner@e2e-flow.test",
        password: "password123",
      },
    });
    ownerToken = owner.json().token;
    ownerId = owner.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    const a = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentA",
        email: "a@e2e-flow.test",
        password: "password123",
      },
    });
    agentAId = a.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentAId);
    const at = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: auth(a.json().token),
    });
    agentAToken = at.json().api_token;

    const b = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AgentB",
        email: "b@e2e-flow.test",
        password: "password123",
      },
    });
    agentBId = b.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentBId);
    const bt = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: auth(b.json().token),
    });
    agentBToken = bt.json().api_token;

    // Задача через API (теперь parent_id в схеме есть).
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(ownerToken),
      payload: { title: "Доставка поручений", assignee_id: agentAId },
    });
    expect(task.statusCode).toBe(200);
    taskId = task.json().task.id;
    markReadyForPickup(taskId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("назначение задачи создаёт inbox-событие event_type=assignment", async () => {
    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending`,
      headers: auth(agentAToken),
    });
    const items = pending.json().items as any[];
    const asg = items.find(
      (i) => i.event_type === "assignment" && i.task_id === taskId,
    );
    expect(asg).toBeTruthy();
    expect(asg.to_user_id).toBe(agentAId);
  });

  it("сообщение в чат по задаче с адресатом создаёт event_type=chat", async () => {
    // channel: "agents" здесь ОБЯЗАТЕЛЕН с 10.09.2026 (карточка 4396f8c9):
    // сообщение владельца без явной ленты ложится в его окно постановки
    // задач, а оно поручений не порождает вовсе — там владелец наговаривает
    // новую работу, а не раздаёт существующую. Озадачить исполнителя лично
    // он по-прежнему может, но в рабочей ленте, где адресат это увидит: до
    // правки поручение уходило агенту по сообщению, которое лежало в
    // невидимом ему канале.
    const chat = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(ownerToken),
      payload: {
        text: "сделай это",
        task_id: taskId,
        to_user_id: agentAId,
        channel: "agents",
      },
    });
    expect(chat.statusCode).toBe(200);
    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending`,
      headers: auth(agentAToken),
    });
    const items = pending.json().items as any[];
    const chatItem = items.find(
      (i) => i.event_type === "chat" && i.chat_message_id === chat.json().id,
    );
    expect(chatItem).toBeTruthy();
  });

  it("повторная доставка ТОГО ЖЕ сообщения не плодит второй запуск (дедуп)", async () => {
    // Review 07.09.2026: прежний тест посылал второй раз другое сообщение
    // (новый chat_message_id) и ничего не проверял. Здесь одно и то же
    // сообщение доставляется второй раз — как это сделал бы голосовой
    // конвейер, переобработав ту же запись: enqueue с тем же
    // chat_message_id обязан вернуть dedup, а в inbox остаться ровно одна
    // запись по этому сообщению.
    const first = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(ownerToken),
      payload: {
        text: "повторная доставка",
        task_id: taskId,
        to_user_id: agentAId,
        // Та же причина, что абзацем выше: поручение родит только рабочая
        // лента, окно постановки задач — нет.
        channel: "agents",
      },
    });
    expect(first.statusCode).toBe(200);
    const mid = first.json().id as string;

    const again = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: auth(ownerToken),
      payload: {
        chat_message_id: mid,
        to_user_id: agentAId,
        body_text: "повторная доставка",
        task_id: taskId,
        event_type: "chat",
        kind: "text",
      },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().dedup).toBe(true);
    expect(again.json().inbox_id).toBeNull();

    const rows = db
      .prepare(
        "SELECT count(*) as c FROM agent_inbox WHERE chat_message_id = ?",
      )
      .get(mid) as any;
    expect(rows.c).toBe(1);

    // И в pending адресата — ровно одно событие по этому сообщению.
    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending`,
      headers: auth(agentAToken),
    });
    const items = (pending.json().items as any[]).filter(
      (i) => i.chat_message_id === mid,
    );
    expect(items.length).toBe(1);
  });

  it("агент не читает и не трогает чужой inbox (безопасность адресата)", async () => {
    // У AgentB нет своих pending, но попытка прочитать inbox AgentA через
    // to_user_id должна отбиться 403.
    const peek = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending?to_user_id=${agentAId}`,
      headers: auth(agentBToken),
    });
    expect(peek.statusCode).toBe(403);

    // Отметить чужое поручение — 403.
    const anAsg = db
      .prepare(
        "SELECT id FROM agent_inbox WHERE to_user_id = ? AND event_type = 'assignment' LIMIT 1",
      )
      .get(agentAId) as any;
    const mark = await app.inject({
      method: "POST",
      url: `/api/agent-inbox/${anAsg.id}/mark`,
      headers: auth(agentBToken),
      payload: { status: "received" },
    });
    expect(mark.statusCode).toBe(403);
  });

  it("возврат review→in_progress создаёт inbox-событие event_type=review_return", async () => {
    // Берём задачу в работу, сдаём в review, владелец возвращает на доработку.
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/claim`,
      headers: auth(agentAToken),
      payload: {},
    });
    const toReview = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: auth(agentAToken),
      payload: { state: "review", comment: "готово" },
    });
    expect(toReview.statusCode).toBe(200);

    const back = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/state`,
      headers: auth(ownerToken),
      payload: { state: "in_progress", comment: "доделай X" },
    });
    expect(back.statusCode).toBe(200);

    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending`,
      headers: auth(agentAToken),
    });
    const items = pending.json().items as any[];
    const ret = items.find(
      (i) => i.event_type === "review_return" && i.task_id === taskId,
    );
    expect(ret).toBeTruthy();
    expect(ret.body_text).toBe("доделай X");
  });

  it("старое событие с устаревшей версией тихо отбрасывается в blocked", async () => {
    // Создаём запись со старой версией, потом «карточка меняется» (версия 3).
    const taskCur = db
      .prepare("SELECT current_revision FROM tasks WHERE id = ?")
      .get(taskId) as any;
    const enq = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: auth(ownerToken),
      payload: {
        chat_message_id: `stale-e2e-${Date.now()}`,
        to_user_id: agentAId,
        body_text: "устаревшее",
        task_id: taskId,
        task_version: Math.max(0, (taskCur?.current_revision ?? 1) - 1),
        event_type: "chat",
        kind: "text",
      },
    });
    const inboxId = enq.json().inbox_id;
    db.prepare(
      "UPDATE tasks SET current_revision = current_revision + 2 WHERE id = ?",
    ).run(taskId);

    const mark = await app.inject({
      method: "POST",
      url: `/api/agent-inbox/${inboxId}/mark`,
      headers: auth(agentAToken),
      payload: { status: "received" },
    });
    expect(mark.json().dropped).toBe(true);
    expect(mark.json().status).toBe("blocked");
  });
});
