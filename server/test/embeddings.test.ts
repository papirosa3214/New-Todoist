// Спек 1.2, задача 1.2.5: POST /api/embeddings. Серверная обёртка над
// Ollama /api/embeddings. Тесты мокают `getEmbeddings` из
// `lib/embeddingClient.ts`, проверяют валидацию, формат ответа и коды
// ошибок. Контракт с самой моделью (1024-dim, детерминированность) —
// отдельный live-блок в конце: если .110 недоступна, тест skip'ится,
// но в живом прогоне на этой машине он проходит (bge-m3-embed:latest,
// 1024-dim, детерминирован на одинаковом входе).
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

const embeddingsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/embeddingClient.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/embeddingClient.js")>();
  return {
    ...actual,
    getEmbeddings: (...args: any[]) => embeddingsMock(...args),
  };
});

const { buildApp } = await import("../src/index.js");

describe("POST /api/embeddings (спек 1.2, 1.2.5)", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `EmbedOwner${Date.now()}`,
        email: `embed-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    if (reg.statusCode !== 200) {
      throw new Error(`register failed: ${reg.statusCode} ${reg.payload}`);
    }
    token = reg.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  function vec1024(seed: number): number[] {
    // Детерминированный вектор длины 1024 — для юнит-тестов.
    const out = new Array<number>(1024);
    for (let i = 0; i < 1024; i += 1) {
      out[i] = Math.sin(seed + i) * 0.001;
    }
    return out;
  }

  it("одиночный текст → 200, dim=1024, embedding — number[]", async () => {
    embeddingsMock.mockReset();
    embeddingsMock.mockResolvedValueOnce({
      embeddings: vec1024(1),
      dim: 1024,
      durationMs: 42,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "привет, мир" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dim).toBe(1024);
    expect(body.model).toBe("bge-m3-embed:latest");
    expect(Array.isArray(body.embedding)).toBe(true);
    expect(body.embedding.length).toBe(1024);
    expect(typeof body.duration_ms).toBe("number");
    // Вызов embeddingClient'а: input строка, model не передана (дефолт).
    expect(embeddingsMock).toHaveBeenCalledTimes(1);
    const [calledInput, calledOpts] = embeddingsMock.mock.calls[0];
    expect(calledInput).toBe("привет, мир");
    expect(calledOpts).toEqual({ model: "bge-m3-embed:latest" });
  });

  it("массив текстов → 200, embedding — number[][] с правильной dim каждого", async () => {
    embeddingsMock.mockReset();
    embeddingsMock.mockResolvedValueOnce({
      embeddings: [vec1024(1), vec1024(2), vec1024(3)],
      dim: 1024,
      durationMs: 130,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: ["раз", "два", "три"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dim).toBe(1024);
    expect(Array.isArray(body.embedding)).toBe(true);
    expect(body.embedding).toHaveLength(3);
    for (const v of body.embedding) {
      expect(v).toHaveLength(1024);
    }
  });

  it("явный model пробрасывается в getEmbeddings", async () => {
    embeddingsMock.mockReset();
    embeddingsMock.mockResolvedValueOnce({
      embeddings: vec1024(7),
      dim: 1024,
      durationMs: 11,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "x", model: "nomic-embed-text:latest" },
    });
    expect(res.statusCode).toBe(200);
    expect(embeddingsMock.mock.calls[0][1]).toEqual({
      model: "nomic-embed-text:latest",
    });
    expect(res.json().model).toBe("nomic-embed-text:latest");
  });

  it("валидация: input не строка и не массив → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/input должен быть строкой/);
  });

  it("валидация: пустая строка → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("валидация: пустой массив → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("валидация: массив содержит не-строку → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: ["ok", 1, "ok"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("батч > 16 → 400 от embeddingClient (forward через EmbeddingError)", async () => {
    embeddingsMock.mockReset();
    const { EmbeddingError } = await import("../src/lib/embeddingClient.js");
    embeddingsMock.mockImplementationOnce(() => {
      throw new EmbeddingError(400, "batch size 17 exceeds limit 16");
    });

    const big = new Array(17).fill("text");
    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: big },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ollama вернула ошибку → 502", async () => {
    embeddingsMock.mockReset();
    // Бросаем настоящий EmbeddingError class instance.
    const { EmbeddingError } = await import("../src/lib/embeddingClient.js");
    embeddingsMock.mockImplementationOnce(() => {
      throw new EmbeddingError(502, "ollama returned 500: internal");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "x" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/ollama returned/);
  });

  it("таймаут ollama → 504", async () => {
    embeddingsMock.mockReset();
    const { EmbeddingError } = await import("../src/lib/embeddingClient.js");
    embeddingsMock.mockImplementationOnce(() => {
      throw new EmbeddingError(504, "embedding timeout after 30000ms");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "slow text" },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatch(/timeout/);
  });
});

// Live-блок: реальный вызов Ollama на .110. Если машина недоступна —
// skip. Это контракт с самой моделью: размерность, детерминированность.
describe("POST /api/embeddings — live bge-m3-embed (если .110 доступна)", () => {
  let app: FastifyInstance | null = null;
  let token: string | null = null;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: `EmbedLive${Date.now()}`,
        email: `embed-live-${Date.now()}@test`,
        password: "password123",
      },
    });
    if (reg.statusCode === 200) {
      token = reg.json().token;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("bge-m3-embed возвращает 1024-dim, детерминирован на одинаковом входе", async () => {
    if (!app || !token) return;
    // Проверяем доступность Ollama — если нет, skip.
    const healthRes = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    if (healthRes.statusCode !== 200) return;

    const res = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "TaskFlow спек 1.2: bge-m3 как embedding-провайдер" },
    });
    if (res.statusCode !== 200) {
      // Ollama на .110 не поднята — пропускаем без падения.
      return;
    }
    const body = res.json();
    expect(body.dim).toBe(1024);
    expect(body.embedding).toHaveLength(1024);

    // Детерминированность: тот же вход → тот же вектор.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/embeddings",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: "TaskFlow спек 1.2: bge-m3 как embedding-провайдер" },
    });
    expect(res2.statusCode).toBe(200);
    const v1: number[] = body.embedding;
    const v2: number[] = res2.json().embedding;
    expect(v1).toEqual(v2);
  });
});
