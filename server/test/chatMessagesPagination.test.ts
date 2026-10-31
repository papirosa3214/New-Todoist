// Постраничная выдача сообщений и отпечаток списка чатов (31.10.2026,
// LOCK-LOCAL-DB-SYNC-20261031).
//
// Проверяем ровно то, на чём держится локальная база на телефоне:
//   1. `GET /api/chats` отвечает 304, когда список не менялся;
//   2. `GET /api/chats/:id/messages` умеет отдать только новое (`after`)
//      и только старое (`before`), и говорит, есть ли ещё;
//   3. старый вызов без параметров отдаёт всю историю — старые клиенты
//      ничего не теряют.
//
// Сообщения сеются прямо в базу: агентный ход роли тут ни при чём, а
// номера сообщений (`sequence` = rowid) должны быть известны заранее.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Синхронизация чатов: отпечаток и постраничная выдача", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;
  let chatId: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildApp();

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Владелец", email: `sync-${Date.now()}@chats.test`, password: "password123" },
    });
    token = registered.json().token;
    userId = registered.json().user.id;

    chatId = "chat-sync-test";
    db.prepare("INSERT INTO chats (id, title, kind, created_by) VALUES (?, ?, ?, ?)")
      .run(chatId, "Синхронизация", "group", userId);
    db.prepare("INSERT INTO chat_members (chat_id, member_id) VALUES (?, ?)")
      .run(chatId, userId);

    // 12 сообщений с известными номерами: created_at растёт вместе с rowid,
    // чтобы порядок выдачи совпадал с порядком вставки.
    for (let i = 1; i <= 12; i++) {
      db.prepare(
        `INSERT INTO chat_messages (id, chat_id, from_user_id, text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`m${i}`, chatId, userId, `Сообщение ${i}`, `2026-10-31 10:${String(i).padStart(2, "0")}:00`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Список чатов: отпечаток и 304 ────────────────────────────────────────

  it("список чатов отдаёт отпечаток", async () => {
    const res = await app.inject({ method: "GET", url: "/api/chats", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    expect(res.json().chats.length).toBeGreaterThan(0);
  });

  it("повторный запрос с тем же отпечатком отвечает 304 без тела", async () => {
    const first = await app.inject({ method: "GET", url: "/api/chats", headers: auth() });
    const second = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { ...auth(), "if-none-match": first.headers.etag as string },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("чуждой отпечаток даёт тело, а не 304", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { ...auth(), "if-none-match": 'W/"stale-1"' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chats).toBeTruthy();
  });

  it("отпечаток чужого пользователя не подходит: тело приходит целиком", async () => {
    // Соль по вызывающему: тело списка может совпасть, а отпечаток — нет.
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Другой", email: `sync-other-${Date.now()}@chats.test`, password: "password123" },
    });
    const otherToken = other.json().token;
    const first = await app.inject({ method: "GET", url: "/api/chats", headers: auth() });
    const res = await app.inject({
      method: "GET",
      url: "/api/chats",
      headers: { authorization: `Bearer ${otherToken}`, "if-none-match": first.headers.etag as string },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Сообщения: постраничная выдача ───────────────────────────────────────

  it("без параметров отдаёт всю историю — как раньше", async () => {
    const res = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages.length).toBe(12);
    expect(body.has_more).toBe(false);
  });

  it("after отдаёт только сообщения новее курсора", async () => {
    // Номера сообщений — глобальные (rowid таблицы), поэтому ожидание
    // считаем от фактического списка, а не от захардкоженных чисел.
    const all = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
    }).then((res) => res.json());
    const sequences = all.messages.map((m: any) => m.sequence) as number[];
    const cursor = sequences[4];

    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?after=${cursor}`,
      headers: auth(),
    }).then((res) => res.json());
    expect(body.messages.map((m: any) => m.sequence)).toEqual(
      sequences.filter((sequence) => sequence > cursor),
    );
    expect(body.has_more).toBe(false);
  });

  it("before отдаёт только сообщения старее курсора", async () => {
    const all = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
    }).then((res) => res.json());
    const sequences = all.messages.map((m: any) => m.sequence) as number[];
    const cursor = sequences[8];

    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?before=${cursor}`,
      headers: auth(),
    }).then((res) => res.json());
    expect(body.messages.map((m: any) => m.sequence)).toEqual(
      sequences.filter((sequence) => sequence < cursor),
    );
    expect(body.has_more).toBe(false);
  });

  it("limit ограничивает страницу, has_more говорит про остаток", async () => {
    const forward = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?after=0&limit=5`,
      headers: auth(),
    }).then((res) => res.json());
    expect(forward.messages.length).toBe(5);
    expect(forward.has_more).toBe(true);

    const backward = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?before=1000000&limit=5`,
      headers: auth(),
    }).then((res) => res.json());
    expect(backward.messages.length).toBe(5);
    expect(backward.has_more).toBe(true);
  });

  it("последняя страница даёт has_more = false", async () => {
    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?after=0&limit=50`,
      headers: auth(),
    }).then((res) => res.json());
    expect(body.messages.length).toBe(12);
    expect(body.has_more).toBe(false);
  });

  it("при прокрутке вверх страница содержит сообщения рядом с курсором, по возрастанию", async () => {
    const all = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
    }).then((res) => res.json());
    const cursor = all.messages[7].sequence;

    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?before=${cursor}&limit=3`,
      headers: auth(),
    }).then((res) => res.json());
    // Ближайшие к курсору: три сообщения прямо перед ним, по возрастанию.
    expect(body.messages.map((m: any) => m.sequence)).toEqual(
      all.messages.slice(4, 7).map((m: any) => m.sequence),
    );
    expect(body.has_more).toBe(true);
  });

  it("порядок сообщений не изменился: по возрастанию", async () => {
    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
    }).then((res) => res.json());
    const sequences = body.messages.map((m: any) => m.sequence);
    expect(sequences).toEqual([...sequences].sort((a: number, b: number) => a - b));
  });

  it("без курсора, но с limit — окно последних N сообщений", async () => {
    const all = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages`,
      headers: auth(),
    }).then((res) => res.json());
    const sequences = all.messages.map((m: any) => m.sequence) as number[];

    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?limit=3`,
      headers: auth(),
    }).then((res) => res.json());
    // Последние три, по возрастанию — не первые три.
    expect(body.messages.map((m: any) => m.sequence)).toEqual(sequences.slice(-3));
    // Старше окна ещё есть — их заберут курсором `before`.
    expect(body.has_more).toBe(true);
  });

  it("ответ несёт cursor — до последнего сообщения страницы", async () => {
    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?after=0&limit=5`,
      headers: auth(),
    }).then((res) => res.json());
    const last = body.messages[body.messages.length - 1].sequence;
    expect(body.cursor).toBe(last);
  });

  it("история приходит без тела шагов: только счётчик", async () => {
    // 31.10.2026 (владелец): «в прошлых сообщениях никаких шагов не
    // отображается, только в живом ходе». Тело шага в истории — это 45 КБ
    // на сообщение, телефон их не рисует.
    db.prepare(
      `INSERT INTO chat_messages (id, chat_id, from_user_id, text, created_at, steps)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "m-with-steps",
      chatId,
      userId,
      "Сообщение со шагами",
      "2026-10-31 10:30:00",
      JSON.stringify({ items: [{ kind: "step", tool: "taskflow", output: "большой вывод", args: { a: 1 } }] }),
    );

    const body = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?limit=1`,
      headers: auth(),
    }).then((res) => res.json());
    const message = body.messages[0];
    expect(message.steps.items).toEqual([]);
    expect(message.steps.steps_total).toBe(1);
  });

  it("after и before вместе дают 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?after=1&before=5`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("некорректный limit и курсор дают 400", async () => {
    for (const query of ["limit=0", "limit=201", "limit=abc", "after=abc", "before=-1"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/chats/${chatId}/messages?${query}`,
        headers: auth(),
      });
      expect(res.statusCode, `запрос ${query}`).toBe(400);
    }
  });

  it("чужой чат по-прежнему отдаёт 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/chats/chat-not-mine/messages`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
