// Чат агентов (27.08.2026): точечная проверка GET/POST /api/chat + приход
// события chat:new по сокету. Не гоняем весь протокол «повод/закрытие» —
// это поведенческие правила для агента (AGENT-PROTOCOL.md), а не то, что
// сервер может отклонить кодом.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

describe("Чат агентов /api/chat", () => {
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
      payload: {
        name: "Alice",
        email: "alice@chat.test",
        password: "password123",
      },
    });
    aliceToken = alice.json().token;
    aliceId = alice.json().user.id;

    const bob = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Bob", email: "bob@chat.test", password: "password123" },
    });
    bobToken = bob.json().token;
    bobId = bob.json().user.id;

    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { title: "Задача для чата", assignee_id: aliceId },
    });
    taskId = task.json().task.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("/api/chat/participants видит всех, не только связанных общей задачей", async () => {
    // Bob не имеет общей задачи с Alice — /api/agents его бы не показал
    // Alice, а участники канала обязаны видеть друг друга все.
    const res = await app.inject({
      method: "GET",
      url: "/api/chat/participants",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((u: any) => u.name);
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");
  });

  it("отвергает пустой текст", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "   ", to_user_id: "all" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("отвергает неизвестный kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "привет", kind: "болтовня", to_user_id: "all" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("шлёт сообщение без задачи — ложится в ленту без task_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "просто заметка", to_user_id: "all" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task_id).toBeNull();
  });

  it("шлёт сообщение с задачей и kind, отдаёт его в истории", async () => {
    const send = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        text: "нужен ревью по задаче",
        task_id: taskId,
        kind: "совещание",
        to_user_id: bobId,
      },
    });
    expect(send.statusCode).toBe(200);
    const message = send.json();
    expect(message.task_id).toBe(taskId);
    expect(message.kind).toBe("совещание");
    expect(message.from_user_name).toBe("Alice");
    expect(message.to_user_name).toBe("Bob");
    expect(message.task_title).toBe("Задача для чата");

    const history = await app.inject({
      method: "GET",
      url: "/api/chat",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(history.statusCode).toBe(200);
    const { messages } = history.json();
    expect(messages.some((m: any) => m.id === message.id)).toBe(true);
    // Общий канал: сообщение видит и не-адресат тоже.
  });

  it("404 на несуществующую задачу", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {
        text: "куда-то не туда",
        task_id: "нет-такой-задачи",
        to_user_id: "all",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("считает непрочитанное и гасит его после /api/chat/read", async () => {
    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "сообщение для Боба", to_user_id: bobId },
    });

    const before = await app.inject({
      method: "GET",
      url: "/api/chat/unread",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(before.json().непрочитано).toBeGreaterThan(0);

    const read = await app.inject({
      method: "POST",
      url: "/api/chat/read",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(read.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/chat/unread",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(after.json().непрочитано).toBe(0);
  });

  it("принимает файл и отдаёт его в сообщении, а пустое сообщение с файлом — законно", async () => {
    // Заливка ДО отправки: файл лежит «ничьим», пока его не подберёт
    // сообщение — тот же приём, что у вложений комментария.
    const up = await app.inject({
      method: "POST",
      url: "/api/chat/attachments?name=%D0%BE%D0%BF%D0%B8%D1%81%D1%8C.txt",
      headers: {
        authorization: `Bearer ${aliceToken}`,
        "content-type": "text/plain",
      },
      payload: Buffer.from("содержимое"),
    });
    expect(up.statusCode).toBe(201);
    const attId = up.json().attachment.id;
    expect(up.json().attachment.file_name).toBe("опись.txt");

    // Текста нет вовсе — это не 400, раз приложен файл.
    const sent = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "", attachment_ids: [attId], to_user_id: "all" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().attachments).toHaveLength(1);
    expect(sent.json().attachments[0].file_name).toBe("опись.txt");

    // И в истории он приезжает вместе с сообщением, а не догружается отдельно.
    const hist = await app.inject({
      method: "GET",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const mine = hist.json().messages.find((m: any) => m.id === sent.json().id);
    expect(mine.attachments[0].id).toBe(attId);
  });

  it("не даёт подобрать чужой файл к своему сообщению", async () => {
    const up = await app.inject({
      method: "POST",
      url: "/api/chat/attachments?name=bob.txt",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "text/plain",
      },
      payload: Buffer.from("боб"),
    });
    const bobAtt = up.json().attachment.id;

    const stolen = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "чужое", attachment_ids: [bobAtt], to_user_id: "all" },
    });
    expect(stolen.statusCode).toBe(200);
    // Сообщение ушло, но файл к нему не прилип — он не Алисин.
    expect(stolen.json().attachments).toHaveLength(0);
  });

  // ═══ Адресат обязателен (28.08.2026) ═══
  // Владелец: «как я должен догадаться, что ты мне написал, не упомянув ни
  // слова обо мне». Раньше пропуск поля молча значил «всем» — теперь «всем»
  // это слово, а пропуск это ошибка.

  it("не принимает сообщение без адресата и объясняет, чем поле заполнить", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "кому-то" },
    });
    expect(res.statusCode).toBe(400);
    // Текст ошибки — единственное, что увидит агент со старой схемой
    // инструмента: по нему он должен сам понять, что писать.
    expect(res.json().error).toContain("адресат обязателен");
    expect(res.json().error).toContain("all");
  });

  it("пустая строка в адресате — тоже пропуск, а не «всем»", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "кому-то", to_user_id: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("«all» — законное «всем»: сообщение уходит в общую ленту", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "всем привет", to_user_id: "all" },
    });
    expect(res.statusCode).toBe(200);
    // В базе «всем» по-прежнему NULL — схему ради этого не меняли.
    expect(res.json().to_user_id).toBeNull();
    expect(res.json().to_user_name).toBeNull();
  });

  it("неизвестный адресат — 404, а не тихая рассылка всем", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { text: "мимо", to_user_id: "нет-такого" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("сводка считает, кого озадачивают чаще всего", async () => {
    const stats = await app.inject({
      method: "GET",
      url: "/api/chat/stats",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(stats.statusCode).toBe(200);
    const data = stats.json();
    expect(data.всего).toBeGreaterThan(0);

    // Бобу писали адресно — он должен быть в разрезе «кому».
    const toBob = data.кому.find((r: any) => r.id === bobId);
    expect(toBob?.сообщений).toBeGreaterThan(0);

    // «Всем» — отдельная строка с id = null, а не потерянные сообщения.
    const toAll = data.кому.find((r: any) => r.id === null);
    expect(toAll?.имя).toBe("Всем");

    // Пара «Alice → Bob» видна отдельно: по ней и понятно, кто кого грузит.
    const pair = data.пары.find(
      (r: any) => r.от === "Alice" && r.кому_id === bobId,
    );
    expect(pair?.сообщений).toBeGreaterThan(0);
  });

  it("требует авторизацию", async () => {
    const res = await app.inject({ method: "GET", url: "/api/chat" });
    expect(res.statusCode).toBe(401);
  });

  // Отметка «печатает» (28.08.2026). Проверяем ровно то, что может
  // подтвердить только сервер: отметка видна ДРУГОМУ участнику в снимке
  // (без него открывший экран посреди чужого ответа не увидел бы ничего) и
  // гаснет на отправленном сообщении, не дожидаясь своего срока.
  it("«печатает» видно в снимке и гаснет на отправке", async () => {
    const on = await app.inject({
      method: "POST",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${bobToken}` },
      payload: {},
    });
    expect(on.json()["печатает"]).toBe(true);
    expect(on.json()["гаснет_через_мс"]).toBeGreaterThan(0);

    const seen = await app.inject({
      method: "GET",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(seen.json().typing.map((t: any) => t.name)).toContain("Bob");

    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${bobToken}` },
      payload: { text: "дописал", to_user_id: "all" },
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(after.json().typing.map((t: any) => t.name)).not.toContain("Bob");
  });

  it("«печатает» снимается явным state=stop", async () => {
    await app.inject({
      method: "POST",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: {},
    });
    const off = await app.inject({
      method: "POST",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${aliceToken}` },
      payload: { state: "stop" },
    });
    expect(off.json()["печатает"]).toBe(false);

    const seen = await app.inject({
      method: "GET",
      url: "/api/chat/typing",
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(seen.json().typing.map((t: any) => t.name)).not.toContain("Alice");
  });
});
