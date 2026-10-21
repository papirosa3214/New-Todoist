// Сторож локальной модели (lib/ollamaHealthWatcher.ts): проба не должна
// поднимать тревогу там, где приборы TaskFlow ещё работают.
//
// Прецедент 21.10.2026: выгруженная модель эмбеддинга грузится около
// минуты; проба сторожа шла с окном 15 с и сдавалась на 15-й секунде,
// поднимая тревогу «Ollama не ответила за 15000 мс» — при том, что в логах
// сервера ни одного 502 от /api/embeddings не было, то есть тревога была
// ложной. Проверка здесь: на выгруженной модели тревоги нет, а на ответе
// «503 server busy» (очередь исчерпана) тревога остаётся.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/migrations.js";
import db, { migrate } from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { getSetting, resetSetting, setSetting } from "../src/lib/serverSettings.js";
import * as watcher from "../src/lib/ollamaHealthWatcher.js";

const MODEL = "bge-m3-embed:latest";

/** Ответ Ollama в виде, как его ждёт код (ok/status/text/json). */
function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

/** Запрос, который не отвечает никогда: Ollama грузит модель. */
function hangingRequest() {
  return (_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        const err: any = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort);
    });
}

type Handler = (url: string, init: any) => Promise<any> | any;

/** Подмена fetch: раскладка ответов Ollama по маршрутам. */
function mockOllama(routes: {
  embeddings: Handler;
  tags?: Handler;
  ps?: Handler;
}): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: any, init: any) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/api/embeddings")) return routes.embeddings(url, init);
    if (url.endsWith("/api/tags")) {
      return routes.tags
        ? routes.tags(url, init)
        : jsonResponse(200, { models: [{ name: MODEL }] });
    }
    if (url.endsWith("/api/ps")) {
      return routes.ps ? routes.ps(url, init) : jsonResponse(200, { models: [] });
    }
    throw new Error(`незапланированный запрос: ${url}`);
  });
  return seen;
}

const incidentRows = () =>
  db
    .prepare("SELECT id, title FROM tasks WHERE incident_key = 'ollama-health'")
    .all() as Array<{ id: string; title: string }>;

const incidentDescription = (id: string) =>
  (db.prepare("SELECT description FROM tasks WHERE id = ?").get(id) as {
    description: string;
  }).description;

describe("сторож локальной модели (Ollama)", () => {
  beforeAll(() => {
    migrate();
    runMigrations();
  });

  beforeEach(() => {
    watcher.__resetWatchState();
    // Боевое окно пробы — 90 с; в тесте ждать столько нельзя.
    watcher.__setProbeWindow(80);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    watcher.__setProbeWindow(null);
    watcher.__resetWatchState();
    resetSetting("embedding_timeout_ms", null, "тест: возврат окна приборов");
    purgeTasks(incidentRows().map((r) => r.id));
  });

  it("окно пробы не меньше окна приборов и с запасом на холодный старт", () => {
    watcher.__setProbeWindow(null); // боевое окно, не тестовое
    const instrument = getSetting("embedding_timeout_ms");
    const window = watcher.probeWindowMs();
    expect(window, "проба обязана ждать не меньше, чем приборы").toBeGreaterThanOrEqual(
      instrument,
    );
    expect(window, "окно приборов по умолчанию — 30 с").toBeGreaterThanOrEqual(30_000);
    expect(
      window,
      "с запасом на холодный старт модели (около минуты)",
    ).toBeGreaterThanOrEqual(instrument + 60_000);
  });

  it("окно пробы не строже прибора даже при максимальном окне приборов", () => {
    watcher.__setProbeWindow(null);
    // 10 минут — максимум, который допускает реестр настроек для
    // embedding_timeout_ms. Жёсткий потолок пробы (5 мин) был ниже него,
    // и при таком таймауте проба снова становилась строже прибора.
    setSetting(
      "embedding_timeout_ms",
      10 * 60_000,
      null,
      "тест: максимум окна приборов",
    );
    const instrument = getSetting("embedding_timeout_ms");
    expect(instrument, "реестр должен принять максимум окна").toBe(10 * 60_000);
    const window = watcher.probeWindowMs();
    expect(
      window,
      "проба обязана ждать не меньше прибора при любом его окне",
    ).toBeGreaterThanOrEqual(instrument);
    expect(window, "и ещё запас на холодный старт").toBeGreaterThanOrEqual(
      instrument + 60_000,
    );
  });

  it("на выгруженной модели (холодный старт) тревогу не поднимает", async () => {
    // Модель выкачана, но в памяти её нет — Ollama грузит и не отвечает.
    mockOllama({
      embeddings: hangingRequest(),
      tags: async () => jsonResponse(200, { models: [{ name: MODEL }] }),
      ps: async () => jsonResponse(200, { models: [] }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state, "холодный старт — не поломка").toBe("loading");
    expect(result.reason).toContain("грузится");
    expect(raised, "тревогу поднимать не на что").toBe(false);
    expect(
      incidentRows().length,
      "карточка с incident_key=ollama-health не должна появляться",
    ).toBe(0);
  });

  it("ответ 503 «server busy» тревогу по-прежнему поднимает", async () => {
    mockOllama({
      embeddings: async () =>
        jsonResponse(503, { error: "server busy: maximum pending requests exceeded" }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("busy");
    expect(result.reason).toContain("перебита");
    expect(raised, "перебитая очередь — поломка, тревога нужна").toBe(true);
    const rows = incidentRows();
    expect(rows.length, "карточка починки должна появиться").toBe(1);
    expect(rows[0].title).toContain("Ollama");
    expect(
      incidentDescription(rows[0].id),
      "подсказка должна говорить про очередь",
    ).toContain("очередь запросов исчерпана");
  });

  it("503 «не хватает памяти под модель» — это не очередь", async () => {
    // Ollama отвечает 503 и на исчерпанную очередь, и на нехватку памяти
    // под модель. Считать все 503 «очередью» — уводить разбор не туда.
    mockOllama({
      embeddings: async () =>
        jsonResponse(503, {
          error: "model requires more system memory than is available",
        }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("memory");
    expect(result.reason).toContain("памят");
    expect(result.reason).not.toContain("очередь");
    expect(raised, "без памяти приборы тоже будут падать — тревога нужна").toBe(true);
    const rows = incidentRows();
    expect(rows.length).toBe(1);
    expect(rows[0].title).toContain("память");
    const description = incidentDescription(rows[0].id);
    expect(description, "подсказка должна говорить про память").toContain("памяти");
    expect(
      description,
      "разбор не должен уводить в исчерпанную очередь",
    ).not.toContain("очередь запросов исчерпана");
  });

  it("503 без известной причины не выдаётся за исчерпанную очередь", async () => {
    mockOllama({
      embeddings: async () => jsonResponse(503, { error: "upstream connect error" }),
    });

    const { result } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("unavailable");
    expect(result.reason).toContain("503");
    expect(result.reason).not.toContain("очередь");
  });

  it("Ollama недоступна (не отвечает даже на /api/tags) — тревога поднимается", async () => {
    mockOllama({
      embeddings: hangingRequest(),
      tags: async () => {
        throw new Error("connect ECONNREFUSED 192.168.1.110:11434");
      },
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("unavailable");
    expect(raised).toBe(true);
    expect(incidentRows().length).toBe(1);
  });

  it("модель не выкачена — тревога поднимается (приборы не получат эмбеддинг)", async () => {
    mockOllama({
      embeddings: hangingRequest(),
      tags: async () => jsonResponse(200, { models: [{ name: "llama3:8b" }] }),
      ps: async () => jsonResponse(200, { models: [] }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("unavailable");
    expect(result.reason).toContain("не выкачена");
    expect(raised).toBe(true);
    expect(incidentRows().length).toBe(1);
  });

  it("модель в памяти, но эмбеддинг не пришёл — тревога поднимается", async () => {
    mockOllama({
      embeddings: hangingRequest(),
      tags: async () => jsonResponse(200, { models: [{ name: MODEL }] }),
      ps: async () => jsonResponse(200, { models: [{ name: MODEL }] }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.state).toBe("slow");
    expect(raised).toBe(true);
    expect(incidentRows().length).toBe(1);
  });

  it("модель не грузится несколько проб подряд — тогда тревога поднимается", async () => {
    mockOllama({
      embeddings: hangingRequest(),
      tags: async () => jsonResponse(200, { models: [{ name: MODEL }] }),
      ps: async () => jsonResponse(200, { models: [] }),
    });

    for (let i = 0; i < 2; i += 1) {
      const attempt = await watcher.runOllamaHealthCheck();
      expect(attempt.raised, `проба ${i + 1}: две попытки — ещё не поломка`).toBe(false);
    }
    expect(incidentRows().length).toBe(0);

    const third = await watcher.runOllamaHealthCheck();
    expect(third.raised, "третья проба подряд — модель не грузится, тревога нужна").toBe(true);
    expect(incidentRows().length).toBe(1);
  });

  it("живая модель отвечает — тревоги нет", async () => {
    mockOllama({
      embeddings: async () => jsonResponse(200, { embedding: [0.1, 0.2, 0.3] }),
    });

    const { result, raised } = await watcher.runOllamaHealthCheck();

    expect(result.ok).toBe(true);
    expect(result.state).toBe("ok");
    expect(raised).toBe(false);
    expect(incidentRows().length).toBe(0);
  });
});
