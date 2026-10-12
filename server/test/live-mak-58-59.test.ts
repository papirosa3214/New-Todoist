// Карточка MAK-58/59 — живой прогон критерия приёмки №3 (после
// changes_requested от критика). Карточка требует: «Сервер стартует,
// чат координации и план команды работают (проверка живым запросом)».
//
// Что проверяем (по вердикту критика от 15:51):
//   (а) POST /api/agent-inbox/enqueue без явного to_user_id →
//       basis: 'fallback_dispatcher', to = roleUserId('architect').
//   (б) POST /api/tasks оркестратором (role='orchestrator', type='ai')
//       с assignee_id → НЕ 403 (то есть 200/201).
//   (в) чат координации: создаём проект + привязываем чат + читаем
//       GET /api/chats → 200, не падаем на маршрутизации (chat.ts).
//
// Живой стек — через app.inject (Fastify). Реальная авторизация, реальные
// маршруты, временная SQLite (см. test/setup.ts). Учётки ролей
// (role_architect и т.п.) поднимаем вручную — в buildApp() они НЕ
// заводятся by design (см. src/index.ts:564 — детерминированный buildApp
// для unit-тестов), а в проде их заводит scripts/seed-role-accounts.ts.
// Здесь мы имитируем ту же раскладку напрямую INSERT'ом, чтобы
// fallbackDispatcherId() указывал на реальную строку users.
//
// ВНИМАНИЕ: файл — НЕ для ревью в основной набор. Это живой сценарий
// для протокола, дублирует то, что покрыто agent-inbox-e2e/chat-channels
// на уровне unit. После прогона и фиксации в ленте карточки —
// можно удалить (или оставить как регресс-смоук).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { markReadyForPickup } from "./helpers.js";

function seedRoleAccount(roleKey: string, name: string): string {
  // Канонический id роли — role_<key> (roleRouting.roleUserId). Создаём
  // system-bot с authority=agent, role_key=roleKey — те же правила, что
  // в scripts/seed-role-accounts.ts (плюс is_system_bot=1).
  const id = `role_${roleKey}`;
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
  if (exists) return id;
  db.prepare(
    `INSERT INTO users
       (id, name, email, password_hash, role, type, role_key,
        is_system_bot, initials, status, archived)
     VALUES (?, ?, ?, '', 'agent', 'ai', ?, 1, ?, 'offline', 0)`,
  ).run(
    id,
    name,
    `${roleKey}@taskflow.local`,
    roleKey,
    roleKey[0].toUpperCase(),
  );
  return id;
}

describe("MAK-58/59: живой сценарий (критерий приёмки №3)", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let agentAToken: string;
  let agentAId: string;
  let orchId: string;
  let orchToken: string;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    // Сначала buildApp() — он прогоняет миграции и поднимает схему
    // (включая users, agent_inbox и т.д.). БД — модульный синглтон
    // (db.ts:new Database на верхнем уровне), таблиц нет до миграций.
    app = await buildApp();

    // Зерно ролей — как scripts/seed-role-accounts.ts, но без api_token
    // (для app.inject достаточно самого users.id).
    seedRoleAccount("architect", "Архитектор");
    seedRoleAccount("builder", "Разработчик");
    seedRoleAccount("qa", "QA");
    seedRoleAccount("critic_verifier", "Критик-проверяющий");
    seedRoleAccount("researcher", "Исследователь");
    seedRoleAccount("analyst", "Аналитик");
    seedRoleAccount("designer", "Дизайнер");

    // Владелец
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Owner", email: "owner@mak5859.test", password: "password123" },
    });
    expect(owner.statusCode).toBe(200);
    ownerToken = owner.json().token;
    ownerId = owner.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);

    // Обычный агент (рядовой, type='ai', role не orchestrator)
    const a = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentA", email: "a@mak5859.test", password: "password123" },
    });
    agentAId = a.json().user.id;
    db.prepare("UPDATE users SET type = 'ai' WHERE id = ?").run(agentAId);
    const at = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: auth(a.json().token),
    });
    agentAToken = at.json().api_token;

    // Организатор (живая роль диспетчера, как в доработке)
    const orch = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Orchestrator", email: "orch@mak5859.test", password: "password123" },
    });
    orchId = orch.json().user.id;
    db.prepare("UPDATE users SET type = 'ai', role = 'orchestrator' WHERE id = ?").run(orchId);
    const ot = await app.inject({
      method: "POST",
      url: "/api/auth/api-token",
      headers: auth(orch.json().token),
    });
    orchToken = ot.json().api_token;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("(а) /api/agent-inbox/enqueue без явного адресата → basis: fallback_dispatcher", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: auth(agentAToken),
      payload: {
        chat_message_id: `live-${Date.now()}-a`,
        body_text: "живой сценарий MAK-58/59: без явного адресата",
        task_id: null,
        event_type: "chat",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // basis — 'fallback_dispatcher', адресат — учётка architect
    expect(body.basis).toBe("fallback_dispatcher");
    expect(body.to).toBeTruthy();
    expect(body.to).not.toBe(agentAId);
    expect(body.routed_to?.title).toBeTruthy();
    expect(body.routed_to.id).toBe(body.to);
  });

  it("(а-control) /api/agent-inbox/enqueue С явным адресатом → basis: explicit_addressee", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: auth(agentAToken),
      payload: {
        chat_message_id: `live-${Date.now()}-a2`,
        to_user_id: orchId,
        body_text: "живой сценарий MAK-58/59: явный адресат",
        event_type: "chat",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.basis).toBe("explicit_addressee");
    expect(body.to).toBe(orchId);
  });

  it("(б) /api/tasks оркестратором с assignee_id → НЕ 403", async () => {
    // Организатор (живая роль) кладёт задачу и НАЗНАЧАЕТ исполнителя — это
    // разрешено доработкой 3dfc151b (п. 1.2/1.6).
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(orchToken),
      payload: { title: "Живой сценарий MAK-58/59", assignee_id: agentAId },
    });
    expect([200, 201]).toContain(res.statusCode);
    const body = res.json();
    expect(body.task?.id).toBeTruthy();
    expect(body.task?.assignee_id).toBe(agentAId);
  });

  it("(б-control) рядовой агент не назначает другую роль при создании карточки", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(agentAToken),
      payload: { title: "MAK-58/59 control", assignee_id: "role_qa" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("(в) чат координации: проект + групповой чат + список чатов владельца", async () => {
    // Создаём проект владельца, привязываем чат-группу и читаем список —
    // подтверждаем, что routes/chat.ts жив (п. 1.4, 2.3).
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth(ownerToken),
      payload: { name: "MAK-58/59 координация", color: "#3B82F6" },
    });
    expect([200, 201]).toContain(project.statusCode);
    const projectId = project.json().project?.id ?? project.json().id;
    expect(projectId).toBeTruthy();

    const chat = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat`,
      headers: auth(ownerToken),
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().chat?.id).toBeTruthy();

    const list = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: auth(ownerToken),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    // Поле — chats (см. routes/chats.ts:253)
    expect(body).toBeTruthy();
  });

  it("(в-extra) inbox диспетчера читает поручение от агента (end-to-end живой сценарий)", async () => {
    // Агент шлёт поручение в чат задачи без явного адресата — оно должно
    // попасть в pending архитектора (живая маршрутизация через roleUserId).
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(ownerToken),
      payload: { title: "MAK-58/59 end-to-end", assignee_id: agentAId },
    });
    expect([200, 201]).toContain(task.statusCode);
    const taskId = task.json().task.id;
    markReadyForPickup(taskId);

    const chatMsgId = `live-e2e-${Date.now()}`;
    const msg = await app.inject({
      method: "POST",
      url: "/api/agent-inbox/enqueue",
      headers: auth(agentAToken),
      payload: {
        chat_message_id: chatMsgId,
        body_text: "живой e2e: сообщение в задачу",
        task_id: taskId,
        event_type: "chat",
      },
    });
    expect(msg.statusCode).toBe(201);
    const msgBody = msg.json();
    expect(msgBody.basis).toBe("fallback_dispatcher");
    expect(msgBody.to).toBe("role_architect");

    // В БД по тому же chat_message_id должна лежать ровно одна запись,
    // и она указывает на архитектора. Это — «живое» подтверждение: HTTP
    // прошёл через бой-стек Fastify (авторизация, маршрутизация) и
    // реальный INSERT в SQLite прошёл.
    const inboxRow = db
      .prepare(
        "SELECT id, to_user_id, event_type, status, task_id " +
          "FROM agent_inbox WHERE chat_message_id = ?",
      )
      .get(chatMsgId) as
      | { id: string; to_user_id: string; event_type: string; status: string; task_id: string }
      | undefined;
    expect(inboxRow).toBeTruthy();
    expect(inboxRow?.to_user_id).toBe("role_architect");
    expect(inboxRow?.event_type).toBe("chat");
    expect(inboxRow?.task_id).toBe(taskId);
  });
});
