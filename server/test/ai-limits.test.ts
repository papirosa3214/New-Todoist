import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/index.js");
const { extractTasksFromText } = await import("../src/routes/ai.js");

function localUserPrompt(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("invalid request body");
  const messages = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) throw new Error("missing messages");
  const userMessage = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      Reflect.get(message, "role") === "user",
  );
  if (!userMessage || typeof userMessage !== "object") {
    throw new Error("missing user message");
  }
  const content = Reflect.get(userMessage, "content");
  if (typeof content !== "string") throw new Error("invalid user prompt");
  return content;
}

function mockLocalAi(content: string, prompts: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("missing JSON body");
      prompts.push(localUserPrompt(JSON.parse(init.body)));
      return Response.json({ message: { content } });
    }),
  );
}

describe("лимиты текста AI", () => {
  let app: FastifyInstance;
  let authorization: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "AiLimits",
        email: `ai-limits-${Date.now()}@test`,
        password: "password123",
      },
    });
    expect(registration.statusCode).toBe(200);
    authorization = { authorization: `Bearer ${registration.json().token}` };
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("journal assist передаёт не больше 6000 символов", async () => {
    const prompts: string[] = [];
    mockLocalAi("Продолжение записи.", prompts);
    const text = ` \n${"ж".repeat(6001)}`;

    const response = await app.inject({
      method: "POST",
      url: "/api/ai/journal-assist",
      headers: authorization,
      payload: { text, action: "continue" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: "Продолжение записи." });
    expect(prompts).toEqual(["ж".repeat(6000)]);
    vi.unstubAllGlobals();
  });

  it("extract tasks использует переданный maxChars, а не лимит дневника", async () => {
    const prompts: string[] = [];
    mockLocalAi("[]", prompts);
    const text = "т".repeat(7001);

    await expect(
      extractTasksFromText(text, "local", undefined, undefined, undefined, 7000),
    ).resolves.toEqual([]);
    expect(prompts).toEqual(["т".repeat(7000)]);
    vi.unstubAllGlobals();
  });
});
