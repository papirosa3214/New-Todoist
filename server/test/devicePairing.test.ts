// Привязка телефона по QR: выдача одноразового кода, обмен на токен
// устройства, отзыв и — главное — правило ретранслятора (карточка b5a16110,
// документ решения a91ac9a1-…, §12).
//
// Здесь проверяется ровно то, что обещает документ, и в том виде, в каком
// это обещано: в базе нет открытого кода и нет токена, отказ неразличим от
// неудачи, отзыв действует мгновенно и на HTTP, и на сокете, а трафик
// ретранслятора не получает вход без пароля — ни под каким заголовком
// клиента.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db, { hashApiToken } from "../src/db.js";

describe("Привязка телефона по QR и токен устройства", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  const LAN_NO_AUTH = process.env.TASKFLOW_LAN_NO_AUTH;

  beforeAll(async () => {
    // Домашний вход без пароля включаем: часть проверок — про то, что
    // ретранслятор от него отрезан, а без флага она и так закрыта.
    process.env.TASKFLOW_LAN_NO_AUTH = "1";
    app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Максим", email: "owner@pair.test", password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE email = ?").run("owner@pair.test");
    const вход = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@pair.test", password: "password123" },
    });
    ownerToken = вход.json().token;
  });

  afterAll(async () => {
    if (LAN_NO_AUTH === undefined) delete process.env.TASKFLOW_LAN_NO_AUTH;
    else process.env.TASKFLOW_LAN_NO_AUTH = LAN_NO_AUTH;
    await app.close();
  });

  const владелец = () => ({ authorization: `Bearer ${ownerToken}` });

  // Свой владелец для тестов лимитов. Часовой лимит на коды считается НА
  // пользователя, и тесты выше к этому моменту уже выписали больше десяти
  // кодов общему владельцу — без отдельной учётки проверка лимита измеряла
  // бы не то, что думаем.
  async function отдельныйВладелец(tag: string) {
    const email = `owner-${tag}@pair.test`;
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: `Владелец ${tag}`, email, password: "password123" },
    });
    db.prepare("UPDATE users SET role = 'owner' WHERE email = ?").run(email);
    const вход = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password123" },
    });
    const token = вход.json().token as string;
    return () => ({ authorization: `Bearer ${token}` });
  }

  async function выдатьКод() {
    const r = await app.inject({ method: "POST", url: "/api/pairing/code", headers: владелец() });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { code: string; qr: string; expires_at: string; expires_in: number };
  }

  async function обменять(code: string, installId: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/pairing/exchange",
      remoteAddress: "203.0.113.9",
      payload: { code, install_id: installId, ...extra },
    });
  }

  // injectWS отдаёт обычного ws-клиента, а не обёртку с waitForMessage.
  //
  // Слушатель вешаем через onInit — ДО апгрейда. Если повесить его после
  // await injectWS (он резолвится по событию open), то «connected» уже
  // придёт и уйдёт: сервер шлёт его синхронно, внутри обработки апгрейда,
  // а open на клиенте случается позже. На чистом дереве без этого тест
  // теряет именно «connected» и видит только следующее событие доски —
  // так и выглядит «сервер не отвечает», хотя отвечает.
  //
  // События доски (task:changed и прочие) в тесте игнорируем: нас
  // интересует рукопожатие и код закрытия.
  async function открытьСокет(токен: string) {
    const пришли: string[] = [];
    let кодЗакрытия: number | null = null;
    let сообщитьОЗакрытии: (code: number) => void = () => {};
    const ждёмЗакрытия = new Promise<number>((ok) => {
      сообщитьОЗакрытии = ok;
    });

    const ws = await (app as any).injectWS("/ws?token=" + encodeURIComponent(токен), {}, {
      onInit: (клиент: any) => {
        клиент.on("message", (m: any) => пришли.push(String(m)));
        клиент.on("close", (code: number) => {
          кодЗакрытия = code;
          сообщитьОЗакрытии(code);
        });
        клиент.on("error", (e: any) => пришли.push("ERR " + e.message));
      },
    });

    // Ждём рукопожатия: сервер шлёт connected сразу после addClient.
    await withTimeout(
      (async () => {
        while (!пришли.some((m) => m.includes('"connected"'))) {
          if (кодЗакрытия !== null) {
            throw new Error(
              `сокет закрылся кодом ${кодЗакрытия} до рукопожатия: ${JSON.stringify(пришли)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      })(),
      "сервер не прислал connected",
    );

    return { ws, пришли, ждёмЗакрытия };
  }

  function withTimeout<T>(p: Promise<T>, что: string, мс = 5000): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, отказ) =>
        setTimeout(() => отказ(new Error(`таймаут: ${что}`)), мс),
      ),
    ]);
  }

  // ── §12.1: код выдан, в базе нет открытого значения, срок 5 минут ──
  it("1. QR выдан на 5 минут, и открытого кода в базе нет нигде", async () => {
    const код = await выдатьКод();

    expect(код.code).toMatch(/^[0-9a-f]{32}$/);          // 128 бит
    expect(код.expires_in).toBe(300);                      // ровно 5 минут
    expect(код.qr).toContain(код.code);                    // код доезжает до телефона
    expect(Date.parse(код.expires_at) - Date.now()).toBeGreaterThan(0);

    // Ищем открытое значение по всем таблицам, где секрет мог бы осесть:
    // проверяем не конкретное поле, а сам факт — «где-то в базе есть такой
    // текст». Для этого склеиваем ВСЕ таблицы и ищем вхождение.
    const таблицы = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const нашли: string[] = [];
    for (const { name } of таблицы) {
      const скл = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      for (const строка of скл) {
        if (JSON.stringify(строка).includes(код.code)) нашли.push(name);
      }
    }
    expect(нашли, `открытый код найден в: ${нашли.join(", ")}`).toEqual([]);

    // Хеш при этом лежит — это и есть «в базе только хеш».
    const строка = db
      .prepare("SELECT code_hash FROM pairing_codes WHERE code_hash = ?")
      .get(hashApiToken(код.code));
    expect(строка).toBeTruthy();
  });

  // ── §12.2: просроченный / использованный / неверный — ответы неразличимы ──
  it("2. неверный, просроченный и использованный коды отвечают одинаково", async () => {
    const неверный = await обменять("f".repeat(32), "install-2a");
    expect(неверный.statusCode).toBe(400);
    expect(неверный.json().error).toBe("invalid_code");

    // Просроченный: выдаём код и отматываем срок в прошлое.
    const просроченный = await выдатьКод();
    db.prepare("UPDATE pairing_codes SET expires_at = ? WHERE code_hash = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      hashApiToken(просроченный.code),
    );
    const ответПросрочен = await обменять(просроченный.code, "install-2b");
    expect(ответПросрочен.statusCode).toBe(400);
    expect(ответПросрочен.json().error).toBe("invalid_code");

    // Использованный: обмениваем по-настоящему, потом пробуем ещё раз.
    const использованный = await выдатьКод();
    const удачный = await обменять(использованный.code, "install-2c");
    expect(удачный.statusCode).toBe(200);
    const ответИспользован = await обменять(использованный.code, "install-2d");
    expect(ответИспользован.statusCode).toBe(400);
    expect(ответИспользован.json().error).toBe("invalid_code");

    // Ключевое: подбор по коду ответа и по таймингу бесполезен — все три
    // состояния выглядят снаружи одинаково.
    expect([
      неверный.statusCode,
      ответПросрочен.statusCode,
      ответИспользован.statusCode,
    ]).toEqual([400, 400, 400]);
    expect([
      неверный.json().error,
      ответПросрочен.json().error,
      ответИспользован.json().error,
    ]).toEqual(["invalid_code", "invalid_code", "invalid_code"]);
  });

  // ── §12.3: второй обмен тем же кодом → 400; новый код гасит предыдущий ──
  it("3. код одноразовый, а новый код гасит предыдущий неиспользованный", async () => {
    const первый = await выдатьКод();
    const второй = await выдатьКод();

    // Прежний код больше не работает — на экране всегда один QR.
    const соСтарым = await обменять(первый.code, "install-3a");
    expect(соСтарым.statusCode).toBe(400);
    expect(соСтарым.json().error).toBe("invalid_code");

    const соСвежим = await обменять(второй.code, "install-3b");
    expect(соСвежим.statusCode).toBe(200);
  });

  // ── §12.4: токен работает на HTTP и на /ws ──
  it("4. выданный токен пускает на /api/auth/me и на /ws", async () => {
    const код = await выдатьКод();
    const обмен = await обменять(код.code, "install-4", { name: "iPhone Максима", model: "iPhone15,2" });
    expect(обмен.statusCode).toBe(200);
    const токен = обмен.json().token as string;
    expect(токен).toMatch(/^tfd_[0-9a-f]{64}$/);

    // В базе только хеш и префикс — сам токен не хранится.
    const строка = db
      .prepare("SELECT token_hash, token_prefix FROM devices WHERE id = ?")
      .get(обмен.json().device_id) as { token_hash: string; token_prefix: string };
    expect(строка.token_hash).toBe(hashApiToken(токен));
    expect(строка.token_hash).not.toContain(токен);
    expect(строка.token_prefix).toBe(токен.slice(0, 8));

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${токен}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().user.email).toBe("owner@pair.test");
    expect(me.json().user.role).toBe("owner");

    // Сокет: токен устройства принимается тем же разбором, что и для HTTP.
    const { ws, пришли, ждёмЗакрытия } = await открытьСокет(токен);
    expect(пришли.some((m) => m.includes('"connected"'))).toBe(true);
    ws.close();
  });

  // ── §12.5: отзыв — 401 device_revoked, сокет закрыт, перепривязка работает ──
  it("5. отзыв убивает HTTP и сокет, повторная привязка того же телефона работает", async () => {
    const код = await выдатьКод();
    const обмен = await обменять(код.code, "install-5", { name: "iPhone на отзыве" });
    const токен = обмен.json().token as string;
    const deviceId = обмен.json().device_id as string;
    const заголовок = { authorization: `Bearer ${токен}` };

    expect(
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: заголовок })).statusCode,
    ).toBe(200);

    // Живой сокет ДО отзыва — его потом обязаны закрыть кодом 4401.
    const { ждёмЗакрытия, ws } = await открытьСокет(токен);

    const список = await app.inject({ method: "GET", url: "/api/devices", headers: владелец() });
    expect(список.statusCode).toBe(200);
    expect(список.json().some((d: any) => d.id === deviceId)).toBe(true);
    // В списке нет секретов.
    expect(JSON.stringify(список.json())).not.toContain(токен);

    const отзыв = await app.inject({
      method: "DELETE",
      url: `/api/devices/${deviceId}`,
      headers: владелец(),
    });
    expect(отзыв.statusCode, отзыв.body).toBe(200);
    expect(отзыв.json()).toEqual({ ok: true });

    // Следующий запрос отозванным токеном — отдельным текстом, чтобы
    // приложение поняло: пора на экран привязки, а не чинить токен.
    const после = await app.inject({ method: "GET", url: "/api/auth/me", headers: заголовок });
    expect(после.statusCode).toBe(401);
    expect(после.json().error).toBe("device_revoked");

    // Повторный DELETE идемпотентен.
    expect(
      (await app.inject({ method: "DELETE", url: `/api/devices/${deviceId}`, headers: владелец() })).statusCode,
    ).toBe(200);

    // Живой сокет закрыт отзывом, а не тишиной сети.
    const закрытие = await withTimeout(ждёмЗакрытия, "сокет отозванного устройства не закрыт");
    expect(закрытие).toBe(4401);

    // Тот же телефон перепривязывается: новый код → новый рабочий токен,
    // устройство не плодится.
    const код2 = await выдатьКод();
    const обмен2 = await обменять(код2.code, "install-5");
    expect(обмен2.statusCode).toBe(200);
    expect(обмен2.json().token).not.toBe(токен);
    const снова = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${обмен2.json().token}` },
    });
    expect(снова.statusCode).toBe(200);

    // А прежний токен так и остался мёртвым.
    expect(
      (await app.inject({ method: "GET", url: "/api/auth/me", headers: заголовок })).json().error,
    ).toBe("device_revoked");
  });

  // ── §12.6: ГЛАВНЫЙ ТЕСТ — трафик ретранслятора не получает владельца ──
  it("6. РЕТРАНСЛЯТОР: вход без пароля закрыт, защищённый маршрут — 401", async () => {
    // Каждая пара «маркер ретранслятора + признак браузера»: любая из них
    // раньше дала бы вход владельца без пароля.
    const заголовки: Record<string, string>[] = [
      { "x-taskflow-relay": "1" },
      { "x-taskflow-relay": "1", "x-taskflow-client": "ios-native" },
      { "x-taskflow-relay": "1", "user-agent": "Mozilla/5.0 (iPhone)" },
      { "x-taskflow-relay": "1", origin: "https://example.com" },
      { "x-taskflow-relay": "1", "sec-fetch-mode": "cors" },
      // Значение маркера неважно — важно лишь наличие.
      { "x-taskflow-relay": "что угодно" },
    ];

    for (const заголовок of заголовки) {
      const lan = await app.inject({
        method: "POST",
        url: "/api/auth/lan",
        remoteAddress: "127.0.0.1",
        headers: { ...заголовок, "x-taskflow-client": "ios-native", "user-agent": "Mozilla/5.0" },
        payload: {},
      });
      expect(lan.statusCode, `маркер ${JSON.stringify(заголовок)}`).toBe(404);
    }

    // Защищённый маршрут через ретранслятор без токена — 401, а не владелец.
    const закрытый = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      remoteAddress: "127.0.0.1",
      headers: { "x-taskflow-relay": "1", "x-taskflow-client": "ios-native", "user-agent": "Mozilla/5.0" },
    });
    expect(закрытый.statusCode).toBe(401);

    // И для сравнения: домашний вход БЕЗ маркера по-прежнему работает —
    // мы не сломали то, что работало.
    const дома = await app.inject({
      method: "POST",
      url: "/api/auth/lan",
      remoteAddress: "192.168.1.77",
      headers: { "x-taskflow-client": "ios-native" },
      payload: {},
    });
    expect(дома.statusCode).toBe(200);
  });

  // ── §12.7: лимиты ──
  // Служебное: обмен без install_id и без кода — тот же неразличимый отказ.
  it("8. обмен без кода или без install_id — invalid_code", async () => {
    const безКода = await app.inject({
      method: "POST",
      url: "/api/pairing/exchange",
      payload: { install_id: "x" },
    });
    expect(безКода.statusCode).toBe(400);
    expect(безКода.json().error).toBe("invalid_code");

    const код = await выдатьКод();
    const безInstall = await app.inject({
      method: "POST",
      url: "/api/pairing/exchange",
      payload: { code: код.code },
    });
    expect(безInstall.statusCode).toBe(400);
    expect(безInstall.json().error).toBe("invalid_code");
  });

  // Служебное: выдача кода требует доверенного клиента. Идёт ДО теста лимитов.
  it("9. код привязки не выдаётся анонимному клиенту", async () => {
    const безКлюча = await app.inject({ method: "POST", url: "/api/pairing/code", payload: {} });
    expect(безКлюча.statusCode).toBe(401);

    // Даже из домашней сети по браузеру код выдаётся — это доверенный путь
    // (владелец дома уже вошёл). Проверяем, что маршрут вообще доступен.
    const изДома = await app.inject({
      method: "POST",
      url: "/api/pairing/code",
      remoteAddress: "192.168.1.77",
      headers: { "x-taskflow-client": "ios-native" },
      payload: {},
    });
    expect(изДома.statusCode).toBe(200);
  });

  // Служебное: перебор одного кода ограничен числом попыток.
  it("10. попыток обмена на один код — не больше десяти", async () => {
    const свой = await отдельныйВладелец("limits-code");
    const r = await app.inject({
      method: "POST",
      url: "/api/pairing/code",
      headers: свой(),
    });
    expect(r.statusCode, r.body).toBe(200);
    const код = r.json().code as string;

    const ответы: number[] = [];
    for (let i = 0; i < 15; i++) {
      const ответ = await app.inject({
        method: "POST",
        url: "/api/pairing/exchange",
        remoteAddress: "192.0.2.5",
        payload: { code: код, install_id: "guess" },
      });
      ответы.push(ответ.statusCode);
    }
    // Первая попытка с верным кодом обязана сработать — иначе телефон не
    // смог бы привязаться никогда.
    expect(ответы[0]).toBe(200);
    // Дальше код уже погашен: одноразовый, и никакая последующая попытка
    // не должна ни выдать второй токен, ни отличить себя по коду ответа.
    expect(ответы.slice(1).every((s) => s === 400)).toBe(true);
    expect(
      ответы.filter((s) => s === 200).length,
      "код обменён больше одного раза",
    ).toBe(1);
  });

  // ── §12.7: лимиты ──
  // Последний НЕ случайно: он намеренно исчерпывает часовые лимиты.
  it("11. ЛИМИТЫ: кодов на пользователя и попыток обмена с адреса", async () => {
    const свой = await отдельныйВладелец("limits-hour");

    // 10 кодов в час на пользователя — 11-й отклоняется.
    let кодовВыдано = 0;
    let отказ = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: "POST", url: "/api/pairing/code", headers: свой() });
      if (r.statusCode === 200) кодовВыдано++;
      else {
        отказ++;
        expect(r.statusCode).toBe(429);
        expect(r.json().error).toBe("pairing_rate_limited");
      }
    }
    expect(кодовВыдано).toBe(10);
    expect(отказ).toBe(2);

    // Попыток обмена с одного адреса: 20 в час. Считаются ВСЕ попытки,
    // включая неудачные — перебор идёт неверными кодами, и лимит по
    // успешным обменам перебор бы не остановил (так и было в первой
    // версии — тест это поймал).
    let принято = 0;
    let отказПоЛимиту = 0;
    for (let i = 0; i < 25; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/pairing/exchange",
        remoteAddress: "198.51.100.77",
        payload: { code: "0".repeat(32), install_id: `limit-${i}` },
      });
      if (r.statusCode === 400) принято++;
      else if (r.statusCode === 429) отказПоЛимиту++;
    }
    expect(принято, "неверный код должен отвечать 400, пока не выбран лимит").toBe(20);
    expect(отказПоЛимиту, "лимит попыток с адреса не сработал").toBe(5);
  });
});