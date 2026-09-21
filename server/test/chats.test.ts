// Чаты с ролями-агентами, этап 1 (миграция 053): создание, участники, история,
// сообщение. Идём через app.inject — контракт наружу, тот же, что у клиентов.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Чаты (этап 1, миграция 053)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("ChatOwner", "owner");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
    const other = await reg("ChatOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function createChat(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/chats", headers: ownerAuth, payload });
  }

  it("создаёт групповой чат и включает создателя в участники", async () => {
    const res = await createChat({ title: "Совет", kind: "group", member_ids: [otherId] });
    expect(res.statusCode).toBe(200);
    const chat = res.json().chat;
    expect(chat.kind).toBe("group");
    expect(chat.title).toBe("Совет");
    const ids = chat.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(ownerId);
    expect(ids).toContain(otherId);
  });

  it("персональный чат требует ровно одного участника", async () => {
    const bad = await createChat({ kind: "direct", member_ids: [otherId, ownerId] });
    expect(bad.statusCode).toBe(400);
    const ok = await createChat({ kind: "direct", member_ids: [otherId] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().chat.members).toHaveLength(2);
  });

  it("персональный чат с самим собой → 400 (B1)", async () => {
    const res = await createChat({ kind: "direct", member_ids: [ownerId] });
    expect(res.statusCode).toBe(400);
  });

  it("несуществующий участник → 400", async () => {
    const res = await createChat({ member_ids: ["no-such-user"] });
    expect(res.statusCode).toBe(400);
  });

  it("список чатов показывает чат участнику", async () => {
    const created = await createChat({ title: "Видно", member_ids: [otherId] });
    const id = created.json().chat.id;
    const mine = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    expect(mine.json().chats.map((c: { id: string }) => c.id)).toContain(id);
  });

  it("чужой чат недоступен → 404", async () => {
    const created = await createChat({ title: "Только моё", member_ids: [] });
    // member_ids пуст → 400; создаём корректно с другим участником
    const created2 = await createChat({ title: "Закрытый", member_ids: [ownerId] });
    const id = created2.json().chat.id;
    // otherId не участник
    const peek = await app.inject({
      method: "GET",
      url: `/api/chats/${id}`,
      headers: otherAuth,
    });
    expect(peek.statusCode).toBe(404);
    expect(created.statusCode).toBe(400);
  });

  it("сообщение ложится в чат и возвращается в истории", async () => {
    const created = await createChat({ title: "Переписка", member_ids: [otherId] });
    const id = created.json().chat.id;
    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "привет" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.text).toBe("привет");
    const hist = await app.inject({
      method: "GET",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
    });
    expect(hist.json().messages.map((m: { text: string }) => m.text)).toEqual(["привет"]);
  });

  it("пустое сообщение → 400", async () => {
    const created = await createChat({ member_ids: [otherId] });
    const id = created.json().chat.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("себя из чата убрать нельзя → 400; чужой не удаляет чат → 403; создатель удаляет → 200", async () => {
    const created = await createChat({ member_ids: [otherId] });
    const id = created.json().chat.id;
    const selfRemove = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}/members/${ownerId}`,
      headers: ownerAuth,
    });
    expect(selfRemove.statusCode).toBe(400);
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}`,
      headers: otherAuth,
    });
    expect(foreignDelete.statusCode).toBe(403);
    const ownDelete = await app.inject({
      method: "DELETE",
      url: `/api/chats/${id}`,
      headers: ownerAuth,
    });
    expect(ownDelete.statusCode).toBe(200);
  });

  it("участников меняет только создатель", async () => {
    const created = await createChat({ title: "Состав", member_ids: [otherId] });
    const id = created.json().chat.id;
    const denied = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/members`,
      headers: otherAuth,
      payload: { member_id: otherId },
    });
    expect(denied.statusCode).toBe(403);
    const added = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/members`,
      headers: ownerAuth,
      payload: { member_id: ownerId },
    });
    expect(added.statusCode).toBe(200);
  });

  // ── Вложения в чат (этап 3, голосовые .m4a) ───────────────────────
  //
  // Голосовое — это будущий клиентский сценарий: человек пишет «» с
  // единственным вложением. Поэтому здесь три независимых проверки:
  // (1) загрузка создаёт «ничье» вложение, (2) сообщение с
  // attachment_ids подбирает его и возвращает в ответе и в истории,
  // (3) чужое вложение к своему сообщению не привязывается.

  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  /** Загрузить файл в новый чат тем же способом, что сделает клиент
   *  голосового сообщения перед отправкой. */
  async function uploadChatAttachment(name = "файл.png") {
    return app.inject({
      method: "POST",
      url: `/api/chats/attachments?name=${encodeURIComponent(name)}`,
      headers: { ...ownerAuth, "content-type": "image/png" },
      payload: PNG,
    });
  }

  it("загрузка создаёт «ничье» вложение (task/comment/chat_message — все NULL)", async () => {
    const res = await uploadChatAttachment("голос.png");
    expect(res.statusCode).toBe(201);
    const a = res.json().attachment;
    expect(a.file_name).toBe("голос.png");
    expect(a.mime).toBe("image/png");
    expect(a.size).toBe(PNG.length);
    // Это не файл задачи и не файл комментария: висит в ожидании
    // сообщения, которое его подберёт. attachmentRow не выдаёт task_id
    // / comment_id / chat_message_id, но они NULL — проверим по базе.
    const row = db
      .prepare(
        "SELECT task_id, comment_id, chat_message_id FROM attachments WHERE id = ?",
      )
      .get(a.id) as { task_id: string | null; comment_id: string | null; chat_message_id: string | null };
    expect(row.task_id).toBeNull();
    expect(row.comment_id).toBeNull();
    expect(row.chat_message_id).toBeNull();
  });

  it("сообщение с attachment_ids подбирает вложение и возвращает его в ответе и в истории", async () => {
    const chat = await createChat({ title: "Скрепка", member_ids: [otherId] });
    const chatId = chat.json().chat.id;
    const up = await uploadChatAttachment("скрин.png");
    const attId = up.json().attachment.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "смотри", attachment_ids: [attId] },
    });
    expect(sent.statusCode).toBe(200);
    const sentMessage = sent.json().message;
    expect(sentMessage.text).toBe("смотри");
    expect(sentMessage.attachments).toHaveLength(1);
    expect(sentMessage.attachments[0].id).toBe(attId);
    expect(sentMessage.attachments[0].file_name).toBe("скрин.png");

    // В базе вложение больше не висит «ничьим».
    const row = db
      .prepare("SELECT chat_message_id FROM attachments WHERE id = ?")
      .get(attId) as { chat_message_id: string | null };
    expect(row.chat_message_id).toBe(sentMessage.id);

    // История тоже возвращает вложение.
    const hist = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
    });
    const msgs = hist.json().messages;
    const last = msgs[msgs.length - 1];
    expect(last.attachments).toHaveLength(1);
    expect(last.attachments[0].id).toBe(attId);

    // У сообщения без вложений поле тоже есть, просто пустое — клиенту
    // удобнее не делать «attachments ? ... : []» на каждое чтение.
    const otherMsg = msgs.find((m: { text: string }) => m.text !== "смотри");
    if (otherMsg) expect(otherMsg.attachments).toEqual([]);
  });

  it("голосовое без текста: только attachment_ids — это валидное сообщение", async () => {
    const chat = await createChat({ member_ids: [otherId] });
    const chatId = chat.json().chat.id;
    const up = await uploadChatAttachment("голос.m4a");
    const attId = up.json().attachment.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { attachment_ids: [attId] },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message.text).toBe("");
    expect(sent.json().message.attachments).toHaveLength(1);
  });

  it("пустое сообщение без текста и без вложений → 400", async () => {
    const chat = await createChat({ member_ids: [otherId] });
    const chatId = chat.json().chat.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("чужое вложение к своему сообщению не привязывается", async () => {
    // Создаём чат, в котором оба участника. Друг заливает файл, владелец
    // пытается подобрать его в СВОЁ сообщение — не должен сработать.
    const chat = await createChat({ title: "Чужие руки", member_ids: [otherId] });
    const chatId = chat.json().chat.id;

    const up = await app.inject({
      method: "POST",
      url: `/api/chats/attachments?name=${encodeURIComponent("чужой.png")}`,
      headers: { ...otherAuth, "content-type": "image/png" },
      payload: PNG,
    });
    expect(up.statusCode).toBe(201);
    const foreignAttId = up.json().attachment.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "пытаюсь утащить", attachment_ids: [foreignAttId] },
    });
    expect(sent.statusCode).toBe(200);
    // Сообщение ушло, но без вложения — UPDATE не нашёл ни одной строки
    // с подходящими условиями (user_id чужой).
    expect(sent.json().message.attachments).toEqual([]);

    // Вложение по-прежнему «ничье».
    const row = db
      .prepare("SELECT chat_message_id FROM attachments WHERE id = ?")
      .get(foreignAttId) as { chat_message_id: string | null };
    expect(row.chat_message_id).toBeNull();

    // Зато сам владелец файла в своём же чате своё вложение подбирает.
    const ownUp = await uploadChatAttachment("свой.png");
    const ownAttId = ownUp.json().attachment.id as string;
    const ownSent = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: ownerAuth,
      payload: { text: "своё", attachment_ids: [ownAttId] },
    });
    expect(ownSent.json().message.attachments).toHaveLength(1);
  });
});

// Миграция 055 + поля списка чатов (LOCK-195, 21.09.2026): превью строки
// списка несёт имя отправителя, а бейдж непрочитанных считается по отметке
// прочтения НА УЧАСТНИКЕ чата (а не на пользователе, как chat_reads у
// старых каналов).
describe("Чаты: непрочитанные и превью списка (миграция 055)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("UnreadOwner", "owner");
    ownerAuth = bearer(owner.jwt);
    const other = await reg("UnreadOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function createChat(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/api/chats", headers: ownerAuth, payload });
  }

  async function send(auth: Record<string, string>, chatId: string, text: string) {
    return app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
      payload: { text },
    });
  }

  async function listFor(auth: Record<string, string>) {
    const res = await app.inject({ method: "GET", url: "/api/chats", headers: auth });
    expect(res.statusCode).toBe(200);
    return res.json().chats as Array<{
      id: string;
      unread_count: number;
      last_message: { text: string; from_user_name: string | null; from_user_id: string } | null;
    }>;
  }

  it("колонка last_read_at появилась на chat_members", () => {
    const cols = (
      db.prepare("PRAGMA table_info(chat_members)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("last_read_at");
  });

  it("в новом чате непрочитанных нет, у отправителя — тоже", async () => {
    const chat = await createChat({ title: "Тишина", member_ids: [otherId] });
    const id = chat.json().chat.id;
    expect((await listFor(ownerAuth)).find((c) => c.id === id)?.unread_count).toBe(0);
    await send(ownerAuth, id, "первое слово");
    expect((await listFor(ownerAuth)).find((c) => c.id === id)?.unread_count).toBe(0);
    expect((await listFor(otherAuth)).find((c) => c.id === id)?.unread_count).toBe(1);
  });

  it("превью последнего сообщения несёт имя отправителя", async () => {
    const chat = await createChat({ title: "Превью", member_ids: [otherId] });
    const id = chat.json().chat.id;
    await send(ownerAuth, id, "старое");
    await send(otherAuth, id, "свежее");
    const mine = (await listFor(ownerAuth)).find((c) => c.id === id);
    expect(mine?.last_message?.text).toBe("свежее");
    expect(mine?.last_message?.from_user_id).toBe(otherId);
    expect(mine?.last_message?.from_user_name).toBe("UnreadOther");
  });

  it("отметка прочтения сбрасывает бейдж только у того, кто прочитал", async () => {
    const chat = await createChat({ title: "Прочитано", member_ids: [otherId] });
    const id = chat.json().chat.id;
    await send(otherAuth, id, "тебе сообщение");
    expect((await listFor(ownerAuth)).find((c) => c.id === id)?.unread_count).toBe(1);

    const read = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/read`,
      headers: ownerAuth,
    });
    expect(read.statusCode).toBe(200);
    expect((await listFor(ownerAuth)).find((c) => c.id === id)?.unread_count).toBe(0);
    // У второго участника своя отметка — его бейдж не изменился.
    expect((await listFor(otherAuth)).find((c) => c.id === id)?.unread_count).toBe(0);

    // Новое сообщение снова поднимает бейдж. Пауза нужна из-за точности
    // колонки `chat_messages.created_at` — это `datetime('now')`, то есть
    // ЦЕЛЫЕ секунды: сообщение, созданное в ту же секунду, что и отметка
    // прочтения, от неё неотличимо. В живом разговоре ход Пи занимает
    // секунды, так что окно в одну секунду практического значения не имеет;
    // расширять `created_at` до миллисекунд пришлось бы пересборкой
    // chat_messages (миграция 053) — не стоит того ради бейджа.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await send(otherAuth, id, "и ещё одно");
    expect((await listFor(ownerAuth)).find((c) => c.id === id)?.unread_count).toBe(1);
  });

  it("добавленному участнику не отдают историю как непрочитанное", async () => {
    const guest = await reg("UnreadGuest");
    const guestAuth = bearer(guest.jwt);
    const chat = await createChat({ title: "Новичок", member_ids: [otherId] });
    const id = chat.json().chat.id;
    await send(ownerAuth, id, "это было до тебя");
    await send(otherAuth, id, "и это тоже");

    const added = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/members`,
      headers: ownerAuth,
      payload: { member_id: guest.id },
    });
    expect(added.statusCode).toBe(200);
    expect((await listFor(guestAuth)).find((c) => c.id === id)?.unread_count).toBe(0);
  });

  it("отметка прочтения чужого чата → 404", async () => {
    const chat = await createChat({ title: "Не твоё", member_ids: [otherId] });
    const id = chat.json().chat.id;
    const guest = await reg("UnreadStranger");
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/read`,
      headers: bearer(guest.jwt),
    });
    expect(res.statusCode).toBe(404);
  });
});


// Удаление сообщений (LOCK-195, 21.09.2026): в комнате чата не было способа
// убрать сообщения — ни в UI, ни на сервере. Владелец: «нажать троеточие и
// либо удалить все, либо выбрать отдельные сообщения и потом удалить их».
// Ключ `ids` — выборка, без него очистка всего чата (только создатель).
describe("Чаты: удаление сообщений", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("DelOwner", "owner");
    ownerAuth = bearer(owner.jwt);
    const other = await reg("DelOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function chat() {
    const res = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { title: "Удаление", member_ids: [otherId] },
    });
    return res.json().chat.id as string;
  }

  async function send(auth: Record<string, string>, chatId: string, text: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
      payload: { text },
    });
    return res.json().message.id as string;
  }

  async function history(auth: Record<string, string>, chatId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
    });
    return res.json().messages as Array<{ id: string; text: string }>;
  }

  function del(auth: Record<string, string>, chatId: string, ids?: string[]) {
    const url = ids?.length
      ? `/api/chats/${chatId}/messages?ids=${ids.join(",")}`
      : `/api/chats/${chatId}/messages`;
    return app.inject({ method: "DELETE", url, headers: auth });
  }

  it("выборка: выбранные удаляются, остальные остаются", async () => {
    const id = await chat();
    await send(ownerAuth, id, "первое");
    const a = await send(ownerAuth, id, "второе");
    const b = await send(ownerAuth, id, "третье");
    await send(otherAuth, id, "четвёртое");

    const res = await del(ownerAuth, id, [a, b]);
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(2);
    expect((await history(ownerAuth, id)).map((m) => m.text)).toEqual([
      "первое",
      "четвёртое",
    ]);
  });

  it("участник не может удалить чужое: 403 и ничего не удалено", async () => {
    const id = await chat();
    const foreign = await send(ownerAuth, id, "владельца");
    const mine = await send(otherAuth, id, "моё");

    const res = await del(otherAuth, id, [foreign, mine]);
    expect(res.statusCode).toBe(403);
    // Отказ атомарный: даже своё сообщение из той же выборки остаётся.
    expect((await history(ownerAuth, id)).map((m) => m.text)).toEqual([
      "владельца",
      "моё",
    ]);
  });

  it("создатель удаляет по выборке и чужие сообщения", async () => {
    const id = await chat();
    const foreign = await send(otherAuth, id, "уйдёт");
    await send(otherAuth, id, "останется");

    const res = await del(ownerAuth, id, [foreign]);
    expect(res.statusCode).toBe(200);
    expect((await history(ownerAuth, id)).map((m) => m.text)).toEqual(["останется"]);
  });

  it("очистка чата без ids — только создатель", async () => {
    const id = await chat();
    await send(ownerAuth, id, "раз");
    await send(otherAuth, id, "два");

    const refused = await del(otherAuth, id);
    expect(refused.statusCode).toBe(403);
    expect((await history(ownerAuth, id)).length).toBe(2);

    const cleared = await del(ownerAuth, id);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().deleted).toBe(2);
    expect(await history(ownerAuth, id)).toEqual([]);
  });

  it("несуществующее сообщение и чужой чат → 404", async () => {
    const id = await chat();
    const missing = await del(ownerAuth, id, ["no-such-message"]);
    expect(missing.statusCode).toBe(404);

    const guest = await reg("DelGuest");
    const stranger = await del(bearer(guest.jwt), id);
    expect(stranger.statusCode).toBe(404);
  });

  it("удаление последнего сообщения обновляет превью в списке", async () => {
    const id = await chat();
    await send(ownerAuth, id, "останется");
    const last = await send(ownerAuth, id, "исчезнет");

    await del(ownerAuth, id, [last]);

    const list = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    const row = list.json().chats.find((c: { id: string }) => c.id === id);
    expect(row.last_message.text).toBe("останется");
  });

  it("после очистки чата превью пустое, а не призрак удалённого", async () => {
    const id = await chat();
    await send(ownerAuth, id, "было");

    await del(ownerAuth, id);

    const list = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    const row = list.json().chats.find((c: { id: string }) => c.id === id);
    expect(row.last_message).toBeNull();
  });

  it("вложения удалённых сообщений отвязываются, файлы на месте", async () => {
    const id = await chat();
    const up = await app.inject({
      method: "POST",
      url: `/api/chats/attachments?name=${encodeURIComponent("файл.txt")}`,
      headers: { ...ownerAuth, "content-type": "text/plain" },
      payload: Buffer.from("привет"),
    });
    expect(up.statusCode).toBe(201);
    const attId = up.json().attachment.id as string;

    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${id}/messages`,
      headers: ownerAuth,
      payload: { text: "", attachment_ids: [attId] },
    });
    const messageId = sent.json().message.id as string;
    expect(sent.json().message.attachments).toHaveLength(1);

    await del(ownerAuth, id, [messageId]);

    const row = db
      .prepare("SELECT chat_message_id FROM attachments WHERE id = ?")
      .get(attId) as { chat_message_id: string | null };
    expect(row.chat_message_id).toBeNull();
  });
});

// Привязка чата и сообщений к задаче (владелец 21.09.2026): «чтобы не
// комментарии они там писать в самой задаче, а в чате переписываться». Чат
// привязывается к задаче при создании, его сообщения наследуют эту задачу;
// явный `task_id` в теле сообщения перекрывает её (привязка отдельного
// сообщения). Лента задачи отдаёт такие сообщения в общем списке `comments`
// с пометкой `source: "chat"`.
describe("Чаты: привязка к задаче", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("BindOwner", "owner");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
    const other = await reg("BindOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function task(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    expect(res.statusCode).toBe(200);
    return res.json().task.id as string;
  }

  async function chat(taskId?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: {
        title: "Чат по задаче",
        member_ids: [otherId],
        ...(taskId ? { task_id: taskId } : {}),
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json().chat.id as string;
  }

  async function send(
    auth: Record<string, string>,
    chatId: string,
    text: string,
    taskId?: string,
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
      payload: { text, ...(taskId ? { task_id: taskId } : {}) },
    });
    expect(res.statusCode).toBe(200);
    return res.json().message.id as string;
  }

  function messageTaskId(messageId: string) {
    return (
      db.prepare("SELECT task_id FROM chat_messages WHERE id = ?").get(messageId) as {
        task_id: string | null;
      }
    ).task_id;
  }

  it("сообщение наследует задачу своего чата", async () => {
    const taskId = await task("Наследование задачи");
    const chatId = await chat(taskId);
    const messageId = await send(ownerAuth, chatId, "по задаче");
    expect(messageTaskId(messageId)).toBe(taskId);
  });

  it("сообщение чата без привязки задачи не имеет", async () => {
    const chatId = await chat();
    const messageId = await send(ownerAuth, chatId, "просто разговор");
    expect(messageTaskId(messageId)).toBeNull();
  });

  it("явный task_id в теле перекрывает задачу чата", async () => {
    const chatTask = await task("Задача чата");
    const otherTask = await task("Другая задача");
    const chatId = await chat(chatTask);
    const messageId = await send(ownerAuth, chatId, "в другую задачу", otherTask);
    expect(messageTaskId(messageId)).toBe(otherTask);
  });

  it("лента задачи отдаёт сообщения чата с пометкой source=chat", async () => {
    const taskId = await task("Лента показывает чат");
    await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: ownerAuth,
      payload: { text: "обычный комментарий" },
    });
    const chatId = await chat(taskId);
    await send(otherAuth, chatId, "сообщение из чата");

    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
    });
    expect(card.statusCode).toBe(200);
    const comments = card.json().comments as Array<{
      text: string;
      source?: string;
      chat_id?: string;
      user_name?: string;
    }>;
    const fromChat = comments.find((c) => c.text === "сообщение из чата");
    expect(fromChat?.source).toBe("chat");
    expect(fromChat?.chat_id).toBe(chatId);
    expect(fromChat?.user_name).toBe("BindOther");
    // Обычный комментарий остался и не помечен как чатовый.
    const plain = comments.find((c) => c.text === "обычный комментарий");
    expect(plain?.source).toBeUndefined();
  });

  it("чат без привязки в ленту задачи не подмешивается", async () => {
    const taskId = await task("Чистая лента");
    const chatId = await chat();
    await send(ownerAuth, chatId, "не должно попасть");

    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
    });
    const comments = card.json().comments as Array<{ text: string }>;
    expect(comments.map((c) => c.text)).not.toContain("не должно попасть");
  });
});

// Перепривязка и отвязка чата (PATCH /api/chats/:id, LOCK-195): привязать чат
// к задаче можно и ПОСЛЕ переписки — тогда лента задачи должна показать и уже
// написанное, иначе разговор до привязки остаётся невидимым.
// Переименование чата (владелец 21.09.2026: «переименовывать почему-то я не
// умею этот чат»). Меняет создатель; пустое название — это NULL, тогда список
// и шапка показывают состав участников, как у группы без названия.
describe("Чаты: переименование", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let otherAuth: string;
  let otherId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "RenameOwner", email: `rn-${Date.now()}@test`, password: "password123" },
    });
    const body = owner.json();
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run("owner", body.user.id);
    ownerAuth = { authorization: `Bearer ${body.token}` };
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "RenameOther", email: `rno-${Date.now()}@test`, password: "password123" },
    });
    otherId = other.json().user.id;
    otherAuth = { authorization: `Bearer ${other.json().token}` };
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function create(title?: string) {
    return app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { member_ids: [otherId], ...(title ? { title } : {}) },
    });
  }

  function rename(auth: Record<string, string>, id: string, title: unknown) {
    return app.inject({
      method: "PATCH",
      url: `/api/chats/${id}`,
      headers: auth,
      payload: { title },
    });
  }

  it("создатель переименовывает чат", async () => {
    const id = (await create("Старое имя")).json().chat.id;
    const res = await rename(ownerAuth, id, "Новое имя");
    expect(res.statusCode).toBe(200);
    expect(res.json().chat.title).toBe("Новое имя");
  });

  it("пустое название снимает его: остаётся состав участников", async () => {
    const id = (await create("Снимем имя")).json().chat.id;
    expect((await rename(ownerAuth, id, "   ")).json().chat.title).toBeNull();
  });

  it("переименование не трогает привязку к задаче", async () => {
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Задача при переименовании" },
    });
    const taskId = task.json().task.id;
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { title: "С задачей", member_ids: [otherId], task_id: taskId },
    });
    const id = created.json().chat.id;

    const res = await rename(ownerAuth, id, "Переименован с задачей");
    expect(res.json().chat.title).toBe("Переименован с задачей");
    expect(res.json().chat.task_id).toBe(taskId);
  });

  it("чужой участник переименовать не может → 403, пустой запрос → 400", async () => {
    const id = (await create("Не твоё")).json().chat.id;
    expect((await rename(otherAuth, id, "Взлом")).statusCode).toBe(403);
    expect((await rename(ownerAuth, id, undefined)).statusCode).toBe(400);
  });
});

describe("Чаты: пометка задачи в списке", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let otherId: string;

  beforeAll(async () => {
    app = await buildApp();
    const owner = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "MarkOwner", email: `mark-${Date.now()}@test`, password: "password123" },
    });
    const body = owner.json();
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run("owner", body.user.id);
    ownerAuth = { authorization: `Bearer ${body.token}` };
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "MarkOther", email: `marko-${Date.now()}@test`, password: "password123" },
    });
    otherId = other.json().user.id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("список отдаёт название задачи у привязанного чата и null у свободного", async () => {
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Задача с чатом" },
    });
    const taskId = task.json().task.id;

    const bound = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { member_ids: [otherId], task_id: taskId },
    });
    const free = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { member_ids: [otherId] },
    });

    const list = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    const rows = list.json().chats as Array<{ id: string; task_id: string | null; task_title: string | null }>;
    expect(rows.find((c) => c.id === bound.json().chat.id)?.task_title).toBe("Задача с чатом");
    expect(rows.find((c) => c.id === free.json().chat.id)?.task_title).toBeNull();
  });

  it("карточка задачи отдаёт привязанные чаты", async () => {
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Задача с двумя чатами" },
    });
    const taskId = task.json().task.id;
    const first = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { title: "Первый", member_ids: [otherId], task_id: taskId },
    });
    await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { title: "Второй", member_ids: [otherId], task_id: taskId },
    });

    const card = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: ownerAuth });
    const chats = card.json().chats as Array<{ id: string; title: string | null; members_count: number }>;
    expect(chats.map((c) => c.title).sort()).toEqual(["Второй", "Первый"]);
    expect(chats.every((c) => c.members_count >= 2)).toBe(true);

    // Свободная задача — пустой список, а не отсутствие поля.
    const clean = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Без чатов" },
    });
    const cleanCard = await app.inject({
      method: "GET",
      url: `/api/tasks/${clean.json().task.id}`,
      headers: ownerAuth,
    });
    expect(cleanCard.json().chats).toEqual([]);
  });
});

describe("Чаты: перепривязка к задаче", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let otherAuth: string;
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    const owner = await reg("PatchOwner", "owner");
    ownerAuth = bearer(owner.jwt);
    const other = await reg("PatchOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function task(title: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    return res.json().task.id as string;
  }

  async function chat(taskId?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: ownerAuth,
      payload: { member_ids: [otherId], ...(taskId ? { task_id: taskId } : {}) },
    });
    return res.json().chat.id as string;
  }

  async function send(auth: Record<string, string>, chatId: string, text: string, taskId?: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      headers: auth,
      payload: { text, ...(taskId ? { task_id: taskId } : {}) },
    });
    return res.json().message.id as string;
  }

  function bind(auth: Record<string, string>, chatId: string, taskId: string | null) {
    return app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}`,
      headers: auth,
      payload: { task_id: taskId },
    });
  }

  async function journal(taskId: string) {
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers: ownerAuth });
    return (res.json().comments as Array<{ text: string; source?: string }>);
  }

  it("перепривязка переносит уже написанные сообщения в ленту задачи", async () => {
    const taskId = await task("Привязка после переписки");
    const chatId = await chat();
    await send(ownerAuth, chatId, "письмо до привязки");

    const res = await bind(ownerAuth, chatId, taskId);
    expect(res.statusCode).toBe(200);

    const texts = (await journal(taskId)).map((c) => c.text);
    expect(texts).toContain("письмо до привязки");
  });

  it("отвязка убирает сообщения из ленты задачи", async () => {
    const taskId = await task("Отвязка");
    const chatId = await chat(taskId);
    await send(ownerAuth, chatId, "было привязано");

    const res = await bind(ownerAuth, chatId, null);
    expect(res.statusCode).toBe(200);
    expect((await journal(taskId)).map((c) => c.text)).not.toContain("было привязано");
  });

  it("сообщение, привязанное к другой задаче явно, перепривязкой не перебивается", async () => {
    const chatTask = await task("Задача чата 2");
    const explicit = await task("Явная задача");
    const chatId = await chat(chatTask);
    const messageId = await send(ownerAuth, chatId, "строго в явную", explicit);

    // Перепривязываем чат на третью задачу.
    const third = await task("Третья задача");
    await bind(ownerAuth, chatId, third);

    const row = db
      .prepare("SELECT task_id FROM chat_messages WHERE id = ?")
      .get(messageId) as { task_id: string | null };
    expect(row.task_id).toBe(explicit);
  });

  it("привязать чужой чат или несуществующую задачу нельзя", async () => {
    const taskId = await task("Права");
    const chatId = await chat();

    const foreign = await bind(otherAuth, chatId, taskId);
    expect(foreign.statusCode).toBe(403);

    const bad = await bind(ownerAuth, chatId, "no-such-task");
    expect(bad.statusCode).toBe(400);
  });
});
