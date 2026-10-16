// Оценщик JEV (владелец 16.10.2026): отдельная категория настроек и первый
// сценарий — выбор шаблона плана. Живой TypeSafe не зовём: fetch подменён,
// проверяется наш протокол, хранение ключа и главное правило — «JEV
// выключен, упал или не уверен → всё как было».
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import db from "../src/db.js";
import {
  evaluateJev,
  getJevSettings,
  jevPlanProfileConfig,
  resetJevSettings,
  saveJevSettings,
  testJevConnection,
} from "../src/lib/jev.js";
import { pickPlanProfileByJev } from "../src/lib/planProfileJev.js";
import { proposalFor } from "../src/routes/task-collaboration-plans.js";
import { buildApp } from "../src/index.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

const realFetch = globalThis.fetch;

function taskWith(title: string, description = ""): string {
  const owner = db
    .prepare("SELECT id FROM users WHERE role='owner' LIMIT 1")
    .get() as { id: string };
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO tasks (id, title, description, creator_id) VALUES (?, ?, ?, ?)",
  ).run(id, title, description, owner.id);
  return id;
}

function answerWith(choice: string, confidence: number) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            profile: {
              type: "choice",
              choice,
              confidence,
              probabilities: { [choice]: confidence },
            },
          },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

beforeEach(() => {
  resetJevSettings();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("настройки JEV", () => {
  it("по умолчанию выключено и без ключа — ни один сценарий не активен", () => {
    const s = getJevSettings();
    expect(s).toMatchObject({
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      timeoutMs: 10000,
      hasApiKey: false,
      planProfileEnabled: false,
    });
    expect(jevPlanProfileConfig()).toBeNull();
  });

  it("ключ хранится зашифрованным и наружу не отдаётся", () => {
    const s = saveJevSettings({ apiKey: "ts-secret-1234567890" });
    expect(s.hasApiKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain("ts-secret");
    const raw = db
      .prepare("SELECT api_key_enc FROM jev_settings WHERE id=1")
      .get() as { api_key_enc: Buffer };
    expect(raw.api_key_enc.toString("utf8")).not.toContain("ts-secret");
  });

  it("пустой ключ при сохранении остальных полей прежний ключ не стирает", () => {
    saveJevSettings({ apiKey: "ts-secret-1234567890" });
    const s = saveJevSettings({ apiKey: "", timeoutMs: 5000 });
    expect(s).toMatchObject({ hasApiKey: true, timeoutMs: 5000 });
  });

  it("адрес с /v1 и кривой тайм-аут отклоняются понятным текстом", () => {
    expect(() =>
      saveJevSettings({ baseUrl: "https://api.typesafe.ai/v1" }),
    ).toThrow(/без \/v1/);
    expect(() => saveJevSettings({ timeoutMs: 10 })).toThrow(/Тайм-аут/);
  });

  it("галочка без ключа сценарий не включает", () => {
    saveJevSettings({ planProfileEnabled: true });
    expect(jevPlanProfileConfig()).toBeNull();
  });
});

describe("протокол TypeSafe", () => {
  it("POST /v1/systemone с Bearer-ключом, моделью, state и questions", async () => {
    saveJevSettings({ apiKey: "ts-secret-1234567890" });
    const fetchMock = answerWith("delivery", 0.9);
    globalThis.fetch = fetchMock as any;
    const out = await evaluateJev("текст", {
      profile: { type: "choice", instructions: "?", criteria: { a: null } },
    });
    expect(out?.answers.profile).toMatchObject({
      type: "choice",
      choice: "delivery",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ts-secret-1234567890",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "jev-latest",
      state: "текст",
      questions: { profile: { type: "choice" } },
    });
  });

  it("ошибка провайдера — null, а не исключение", async () => {
    saveJevSettings({ apiKey: "ts-secret-1234567890" });
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":"bad key"}', { status: 401 }),
    ) as any;
    expect(
      await evaluateJev("x", { q: { type: "noul", instructions: "?" } }),
    ).toBeNull();
  });

  it("проверка подключения ходит в GET /v1/models", async () => {
    saveJevSettings({ apiKey: "ts-secret-1234567890" });
    const fetchMock = vi.fn(
      async () =>
        new Response('{"models":[{"name":"jev-latest"}]}', { status: 200 }),
    );
    globalThis.fetch = fetchMock as any;
    const res = await testJevConnection();
    expect(res).toMatchObject({ ok: true, models: ["jev-latest"] });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.typesafe.ai/v1/models",
    );
  });

  it("без ключа проверка честно говорит, что ключа нет", async () => {
    expect(await testJevConnection()).toEqual({
      ok: false,
      error: "Ключ API не задан",
    });
  });
});

describe("сценарий: выбор шаблона плана", () => {
  it("галочка выключена — JEV не зовётся, шаблон по словам", async () => {
    saveJevSettings({ apiKey: "ts-secret-1234567890" });
    const fetchMock = answerWith("full_cycle", 0.99);
    globalThis.fetch = fetchMock as any;
    const id = taskWith("Поправить текст на экране");
    expect(await pickPlanProfileByJev(id)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("включено и уверен — профиль берётся у JEV, в обосновании видно, кто выбрал", async () => {
    saveJevSettings({
      apiKey: "ts-secret-1234567890",
      planProfileEnabled: true,
    });
    globalThis.fetch = answerWith("single_executor", 0.91) as any;
    // По словам («экран», «исслед») регулярки дали бы полный цикл.
    const id = taskWith("Поправить текст на экране", "исследовать не нужно");
    const pick = await pickPlanProfileByJev(id);
    expect(pick).toEqual({ profile: "single_executor", confidence: 0.91 });
    const proposal = proposalFor(id, "auto", undefined, undefined, pick);
    expect(proposal.profile).toBe("single_executor");
    expect(proposal.rationale).toContain("JEV (уверенность 91%)");
  });

  it("ниже порога уверенности — выбор JEV не применяется", async () => {
    saveJevSettings({
      apiKey: "ts-secret-1234567890",
      planProfileEnabled: true,
      planProfileMinConfidence: 0.8,
    });
    globalThis.fetch = answerWith("research", 0.55) as any;
    expect(await pickPlanProfileByJev(taskWith("Что-то"))).toBeNull();
  });

  it("неизвестный ответ — отброшен", async () => {
    saveJevSettings({
      apiKey: "ts-secret-1234567890",
      planProfileEnabled: true,
    });
    globalThis.fetch = answerWith("orchestrated", 0.99) as any;
    expect(await pickPlanProfileByJev(taskWith("Что-то"))).toBeNull();
  });

  it("без выбора JEV proposalFor ведёт себя как раньше", () => {
    const id = taskWith("Поправить экран интерфейса", "исследовать варианты");
    expect(proposalFor(id, "auto").profile).toBe("full_cycle");
  });
});

describe("шлюз jevai.org", () => {
  it("адрес jevai.org — POST /api/v1/decisions, ответ разворачивается из data", async () => {
    saveJevSettings({ apiKey: "jev_secret-1234567890", baseUrl: "https://www.jevai.org", model: "typesafe-ai/jev" });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, message: "ok", data: { answers: { q: { type: "noul", noul: 0.9 } } } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as any;
    const out = await evaluateJev("x", { q: { type: "noul", instructions: "?" } });
    expect(out?.answers.q).toEqual({ type: "noul", noul: 0.9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.jevai.org/api/v1/decisions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "typesafe-ai/jev", state: "x" });
  });

  it("code≠0 у jevai — null, а проверка подключения показывает текст сервиса", async () => {
    saveJevSettings({ apiKey: "jev_secret-1234567890", baseUrl: "https://www.jevai.org" });
    globalThis.fetch = vi.fn(async () => new Response('{"code":-1,"message":"Quota exceeded","data":null}', { status: 200 })) as any;
    expect(await evaluateJev("x", { q: { type: "noul", instructions: "?" } })).toBeNull();
    expect(await testJevConnection()).toEqual({ ok: false, error: "Quota exceeded" });
  });

  it("502 от jevai — честная ошибка проверки, без исключения", async () => {
    saveJevSettings({ apiKey: "jev_secret-1234567890", baseUrl: "https://www.jevai.org" });
    globalThis.fetch = vi.fn(async () => new Response("error code: 502", { status: 502 })) as any;
    expect(await testJevConnection()).toEqual({ ok: false, error: "HTTP 502" });
  });
});
