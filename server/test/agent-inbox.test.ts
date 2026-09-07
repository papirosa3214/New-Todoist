// Карточка 5f292e87 (MVP надёжной доставки поручений). Проверка реального
// маршрута agent_inbox: enqueue → pending → mark (received/acting/done),
// запрет обратного перехода, защита от устаревших событий (версия карточки)
// и читаемый реестр диспетчеризации. Задачу вставляем напрямую в БД — POST
// /api/tasks сейчас падает на чужой дыре (test-схема без parent_id), а здесь
// проверяется не создание задачи, а доставка.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("agent inbox /api/agent-inbox", () => {
  let app: FastifyInstance;
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;
  let bobId: string;
  let taskId: string;

  beforeAll(async () => {
    app = await buildApp();

    const alice = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Alice", email: "alice@inbox.test", password: "password123" },
    });
    aliceToken = alice.json().token;
    aliceId = alice.json().user.id;

    const bob = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Bob", email: "bob@inbox.test", password: "password123" },
    });
    bobToken = bob.json().token;
    bobId = bob.json().user.id;

    // Задача напрямую в БД (см. комментарий в шапке).
    const t = db
      .prepare(
        "INSERT INTO tasks (id, title, assignee_id, creator_id, current_revision) VALUES (?, ?, ?, ?, ?)",
      )
      .run("t_inbox", "задача для доставки", bobId, aliceId, 1);
    taskId = "t_inbox";
    expect(t.changes).toBe(1);

    // Пользователь-диспетчер (id из team_catalog.json), на которого падает
    // fallback-маршрутизация — иначе FK на to_user_id в agent_inbox упадёт.
    db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'orchestrator', 'ai')",
    ).run("6848a89b-04fe-4015-bb1c-61b03782c378", "Технический диспетчер", "orch@inbox.test", "x");
  });

  afterAll(async () => {
    await app.close();
  });

  it("адресное сообщение создаёт одно inbox-событие и получает received", async () => {
    const enq = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        chat_message_id: "msg-1",
        to_user_id: bobId,
        body_text: "возьми в работу",
        task_id: taskId,
        event_type: "chat",
        kind: "text",
      },
    });
    expect(enq.statusCode).toBe(201);
    const inboxId = enq.json().inbox_id;
    expect(enq.json().to).toBe(bobId);

    const pending = await app.inject({
      method: "GET",
      url: `/api/agent-inbox/pending?to_user_id=${bobId}`,
      headers: { authorization: `Bearer ${bobToken}` },
    });
    const items = pending.json().items;
    expect(items.length).toBe(1);
    expect(items[0].body_text).toBe("возьми в работу");

    const mark = await app.inject({
      method: "POST",
      url: `/api/agent-inbox/${inboxId}/mark`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { status: "received" },
    });
    expect(mark.json().status).toBe("received");
  });

  it("повторная доставка не создаёт второй запуск (дедуп по chat_message_id)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { chat_message_id: "msg-2", to_user_id: bobId, body_text: "дубль", kind: "text" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { chat_message_id: "msg-2", to_user_id: bobId, body_text: "дубль", kind: "text" },
    });
    expect(dup.json().dedup).toBe(true);
  });

  it("только соседние переходы: перескоки и шаг назад — 409", async () => {
    // Review 07.09.2026: mark разрешал sent → acting/done. Теперь успех
    // идёт строго sent → received → acting → done, blocked — аварийная
    // остановка из неконечного статуса.
    const enq = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { chat_message_id: "msg-3", to_user_id: bobId, body_text: "x", kind: "text" },
    });
    const inboxId = enq.json().inbox_id;
    const mark = (status: string) =>
      app.inject({
        method: "POST",
        url: `/api/agent-inbox/${inboxId}/mark`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { status },
      });

    // Перескоки через шаг запрещены.
    expect((await mark("acting")).statusCode).toBe(409);
    expect((await mark("done")).statusCode).toBe(409);

    // Цепочка по одному шагу проходит.
    expect((await mark("received")).statusCode).toBe(200);
    // received → done — перескок acting.
    expect((await mark("done")).statusCode).toBe(409);
    expect((await mark("acting")).statusCode).toBe(200);
    expect((await mark("done")).statusCode).toBe(200);

    // Из done выхода нет.
    const back = await mark("received");
    expect(back.statusCode).toBe(409);
    expect(back.json().error).toContain("назад");
  });

  it("blocked доступен из неконечного статуса, но не из done", async () => {
    const mk = async (mid: string) => {
      const enq = await app.inject({
        method: "POST",
        url: "/api/agent-inbox/enqueue",
        headers: { authorization: `Bearer ${aliceToken}` },
        payload: { chat_message_id: mid, to_user_id: bobId, body_text: mid, kind: "text" },
      });
      return enq.json().inbox_id as string;
    };
    const mark = (id: string, status: string) =>
      app.inject({
        method: "POST",
        url: `/api/agent-inbox/${id}/mark`,
        headers: { authorization: `Bearer ${bobToken}` },
        payload: { status, blocked_reason: "не смог" },
      });

    const a = await mk("msg-3b");
    expect((await mark(a, "received")).statusCode).toBe(200);
    const blocked = await mark(a, "blocked");
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().status).toBe("blocked");

    // Из done blocked уже недоступен.
    const b = await mk("msg-3c");
    await mark(b, "received");
    await mark(b, "acting");
    expect((await mark(b, "done")).statusCode).toBe(200);
    expect((await mark(b, "blocked")).statusCode).toBe(409);
  });

  it("устаревшее событие после возврата из review тихо отбрасывается (blocked + dropped)", async () => {
    // Запись со старой версией карточки (1), потом карточка «изменилась» — версия стала 3.
    const enq = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        chat_message_id: "msg-4",
        to_user_id: bobId,
        body_text: "устаревшее",
        task_id: taskId,
        task_version: 1,
        event_type: "review_return",
        kind: "text",
      },
    });
    const inboxId = enq.json().inbox_id;
    db.prepare("UPDATE tasks SET current_revision = 3 WHERE id = ?").run(taskId);

    const mark = await app.inject({
      method: "POST",
      url: `/api/agent-inbox/${inboxId}/mark`,
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { status: "received" },
    });
    expect(mark.json().status).toBe("blocked");
    expect(mark.json().dropped).toBe(true);
  });

  it("каталог: явный адресат приоритетен, иначе fallback в диспетчера", async () => {
    const explicit = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { chat_message_id: "msg-5", to_user_id: bobId, body_text: "явный", kind: "text" },
    });
    expect(explicit.json().to).toBe(bobId);
    expect(explicit.json().basis).toBe("explicit_addressee");

    const fallback = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { chat_message_id: "msg-6", body_text: "без адресата", kind: "text" },
    });
    expect(fallback.json().basis).toBe("fallback_orchestrator");
    expect(fallback.json().to).not.toBe(aliceId);
  });

  it("реестр диспетчеризации фиксирует события доставки (read-only)", async () => {
    const reg = await app.inject({
      method: "GET",
      url: "/api/agent-inbox/registry?limit=50",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(reg.statusCode).toBe(200);
    const items = reg.json().items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    const rec = items.find((r: any) => r.source === "agent_inbox");
    expect(rec).toBeTruthy();
    expect(rec.result).toBeTruthy();
  });
});
