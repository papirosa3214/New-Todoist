// Два канала чата (28.08.2026, карточка 41ed0019). Проверяется ровно то,
// что сервер обязан держать сам, без дисциплины на стороне агента: куда
// ложится сообщение, кому оно в итоге адресовано, кто какую ленту видит и
// что попадает в счётчик непрочитанного.
//
// Файл отдельный от chat.test.ts намеренно: здесь у пользователей роли
// (владелец, оркестратор, исполнитель), а там — обычные зарегистрированные
// участники, и смешивать их в одной базе значило бы менять условия соседним
// тестам на ходу. setupFiles даёт каждому файлу свою временную базу.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

describe("Два канала чата", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let orchToken: string;
  let orchId: string;
  let agentToken: string;
  let agentId: string;

  const register = async (name: string, email: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    return { token: res.json().token, id: res.json().user.id };
  };

  const send = (token: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const history = (token: string, qs = "") =>
    app.inject({
      method: "GET",
      url: `/api/chat${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    app = await buildApp();
    // Миграция 039_seed_owner заводит 'u1' как владельца. Без этого шага
    // ownerId() (SELECT ... ORDER BY created_at LIMIT 1) возвращает u1,
    // а не нашего Хозяина — routeMessage не видит fromUserId === owner,
    // и сообщения уходят не в те каналы. Понижаем u1 до agent, чтобы
    // единственным владельцем остался тот, кого заводит сам тест.
    demoteSeededOwner(db);

    // Роль раздаётся напрямую в базе: регистрация её выдать не может
    // (routes/auth.ts, любой зарегистрировавшийся — 'agent'), а роли здесь
    // и есть предмет проверки.
    const owner = await register("Хозяин", "owner@channels.test");
    ownerToken = owner.token;
    ownerId = owner.id;
    const orch = await register("Оркестратор", "orch@channels.test");
    orchToken = orch.token;
    orchId = orch.id;
    const agent = await register("Исполнитель", "agent@channels.test");
    agentToken = agent.token;
    agentId = agent.id;

    const setRole = db.prepare("UPDATE users SET role = ? WHERE id = ?");
    setRole.run("owner", ownerId);
    setRole.run("orchestrator", orchId);
  });

  afterAll(async () => {
    await app.close();
  });

  it("сообщение владельца ложится в его окно постановки и никому не адресуется", async () => {
    const res = await send(ownerToken, {
      text: "как там задача",
      to_user_id: "all",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe("owner");
    // 10.09.2026, карточка 4396f8c9: адресата у надиктовки нет. Раньше здесь
    // молча подставлялся оркестратор, и это делало сообщение поручением
    // живому агенту — ровно то, от чего окно постановки задач отделяется.
    expect(res.json().to_user_id).toBe(null);
  });

  it("ответ оркестратора владельцу ложится в тот же канал", async () => {
    const res = await send(orchToken, {
      text: "идёт, отчитаюсь",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe("owner");
  });

  it("исполнителю нельзя адресоваться владельцу — 400, и текст возвращается", async () => {
    const res = await send(agentToken, {
      text: "Максим, подскажи, какой вариант выбрать",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(400);
    // Написанное не пропадает: модель второй раз слово в слово не повторит.
    expect(res.json().ваш_текст).toBe(
      "Максим, подскажи, какой вариант выбрать",
    );
    expect(res.json().адресуй).toBeTruthy();
  });

  it("переписка исполнителей ложится в служебный канал", async () => {
    const toOrch = await send(agentToken, {
      text: "взял карточку",
      to_user_id: orchId,
    });
    expect(toOrch.statusCode).toBe(200);
    expect(toOrch.json().channel).toBe("agents");

    const toAll = await send(agentToken, {
      text: "всем к сведению",
      to_user_id: "all",
    });
    expect(toAll.json().channel).toBe("agents");
  });

  it("исполнитель не читает канал владельца: 403 на запрос и ни строки в общей выдаче", async () => {
    const forbidden = await history(agentToken, "?channel=owner");
    expect(forbidden.statusCode).toBe(403);

    const mine = await history(agentToken);
    expect(mine.statusCode).toBe(200);
    const channels = mine.json().messages.map((m: any) => m.channel);
    expect(channels.every((c: string) => c === "agents")).toBe(true);
    expect(
      mine.json().messages.some((m: any) => m.text === "как там задача"),
    ).toBe(false);
  });

  it("владелец и оркестратор видят обе ленты, а запрос без канала отдаёт всё видимое", async () => {
    const control = await history(ownerToken, "?channel=agents");
    expect(control.statusCode).toBe(200);
    expect(
      control.json().messages.some((m: any) => m.text === "взял карточку"),
    ).toBe(true);

    // Без параметра — обе ленты сразу. Это дефолт для резидента: он читает
    // канал инструментом без аргументов, и «по умолчанию только служебный»
    // ослепил бы его на сообщения владельца.
    const both = await history(orchToken);
    const seen = new Set(both.json().messages.map((m: any) => m.channel));
    expect(seen.has("owner")).toBe(true);
    expect(seen.has("agents")).toBe(true);
  });

  it("неизвестный канал — 400", async () => {
    const res = await history(ownerToken, "?channel=прочее");
    expect(res.statusCode).toBe(400);
  });

  it("непрочитанное владельца считает только его канал, у оркестратора — оба", async () => {
    // Отметку прочтения здесь НЕ ставим намеренно: last_read_at пишется с
    // точностью до секунды (datetime('now')), и сообщение, отправленное в
    // ту же секунду, в счётчик уже не попадёт — тест мерил бы разрешение
    // часов, а не правило. Без отметки отсчёт идёт от 1970 года, и считать
    // можно точно.
    const unread = async (token: string) =>
      (
        await app.inject({
          method: "GET",
          url: "/api/chat/unread",
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()["непрочитано"];

    // В канале владельца к этому моменту одно чужое сообщение — ответ
    // оркестратора. Служебной переписки к тому времени накопилось больше.
    expect(await unread(ownerToken)).toBe(1);

    await send(agentToken, { text: "служебное", to_user_id: "all" });
    expect(await unread(ownerToken)).toBe(1); // агенты переписываются — его это не дёргает

    // Оркестратор ведёт обе стороны, ему считается всё, что адресовано ему
    // или всем: и разговор с владельцем, и служебная лента.
    expect(await unread(orchToken)).toBeGreaterThan(1);

    // А своё владельцу считается.
    await send(orchToken, { text: "нужен твой ответ", to_user_id: ownerId });
    expect(await unread(ownerToken)).toBe(2);
  });

  it("владельцу служебная лента не запрещена — попросил, значит пишет", async () => {
    // Поправка оркестратора 28.08.2026: запреты ставим исполнителям, но не
    // хозяину. Строку ввода в контрольном виде не показываем — это разные
    // вещи, «не предлагаем» и «нельзя».
    const res = await send(ownerToken, {
      text: "вижу, продолжайте",
      to_user_id: agentId,
      channel: "agents",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe("agents");
    expect(res.json().to_user_id).toBe(agentId);
  });

  // ── Ответ владельцу: разрешён, когда он написал первым ───────────────
  // Карточка 4caa266f, владелец 28.08.2026: «если я пишу кому-то в общем
  // чате, то у этого типочка появляется возможность ответить мне в
  // обраточку». Запрет остаётся на ОБРАЩЕНИЕ по своей инициативе.

  const unreadOf = async (token: string) =>
    (
      await app.inject({
        method: "GET",
        url: "/api/chat/unread",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().непрочитано as number;

  it("владелец пишет исполнителю лично, и оркестратор получает уведомление", async () => {
    const res = await send(ownerToken, {
      text: "глянь, почему сборка красная",
      to_user_id: agentId,
      channel: "agents",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe("agents");
    expect(res.json().to_user_id).toBe(agentId);

    // «Видеть, а не вставать посередине»: сообщение ушло как есть, а
    // оркестратору отдельно сказали, что работа роздана мимо него.
    const notif = db
      .prepare(
        "SELECT text FROM notifications WHERE user_id = ? AND type = 'chat_direct'",
      )
      .get(orchId) as { text: string } | undefined;
    expect(notif?.text).toContain(agentId);
  });

  it("исполнитель отвечает владельцу в ту же ленту, и это видно в его непрочитанном", async () => {
    const before = await unreadOf(ownerToken);
    const res = await send(agentToken, {
      text: "упал тест миграций, чиню",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(200);
    // Отвечают там же, где спросили: служебная лента, а не личный канал.
    expect(res.json().channel).toBe("agents");
    expect(res.json().to_user_id).toBe(ownerId);

    // Без этого «ответ проходит» был бы формальным: владелец спросил и не
    // узнал бы, что ему ответили — его счётчик считает только свой канал.
    expect(await unreadOf(ownerToken)).toBe(before + 1);
  });

  it("исполнитель, которому владелец не писал, по-прежнему получает отказ", async () => {
    const other = await register("Второй", "agent2@channels.test");
    const res = await send(other.token, {
      text: "Максим, а можно я спрошу",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().ваш_текст).toBe("Максим, а можно я спрошу");
  });

  it("разговор закончился — право ответить гаснет", async () => {
    const old = await register("Третий", "agent3@channels.test");
    const opened = await send(ownerToken, {
      text: "посмотри логи",
      to_user_id: old.id,
      channel: "agents",
    });
    expect(opened.statusCode).toBe(200);

    // Позавчерашнее обращение: окно живёт сутки от последнего слова владельца.
    db.prepare(
      "UPDATE chat_messages SET created_at = datetime('now', '-2 days') WHERE id = ?",
    ).run(opened.json().id);

    const res = await send(old.token, {
      text: "досмотрел, всё чисто",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(400);
    // Текст отказа отличает «он тебе не писал» от «разговор кончился».
    expect(res.json().error).toContain("закончился");
  });

  it("сообщение «всем» от владельца права ответить не открывает", async () => {
    const crowd = await register("Четвёртый", "agent4@channels.test");
    await send(ownerToken, {
      text: "всем к сведению: вечером перезапуск",
      to_user_id: "all",
      channel: "agents",
    });
    const res = await send(crowd.token, {
      text: "а меня это касается?",
      to_user_id: ownerId,
    });
    expect(res.statusCode).toBe(400);
  });
});
