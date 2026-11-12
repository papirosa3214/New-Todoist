// Локальные модели .110: дефолт — deepseek-v4.1-flash-1017:9b (контекст 80k), к постоянной паре запросы идут с keep_alive=-1.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { callUnifiedAi } from "../src/lib/aiClient.js";
import { getEmbeddings } from "../src/lib/embeddingClient.js";
import { LOCAL_DEFAULT_MODEL, keepAliveFor, isResidentModel } from "../src/lib/localModels.js";

const saved = process.env.OLLAMA_MODEL;
beforeEach(() => { delete process.env.OLLAMA_MODEL; });
afterEach(() => { vi.restoreAllMocks(); if (saved === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = saved; });

it("дефолт локальной модели — deepseek-v4.1-flash-1017:9b, контекст 80k, без keep_alive у чужих", async () => {
  expect(LOCAL_DEFAULT_MODEL).toBe("eriktonon/deepseek-v4.1-flash-1017:9b");
  const bodies: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  }) as any);
  expect(await callUnifiedAi({ systemPrompt: "s", userPrompt: "u", provider: "local" })).toBe("ok");
  expect(bodies[0]).toMatchObject({ model: "eriktonon/deepseek-v4.1-flash-1017:9b", keep_alive: -1 });
  expect(bodies[0].options.num_ctx).toBe(81920);
  await callUnifiedAi({ systemPrompt: "s", userPrompt: "u", provider: "local", localModel: "qwen3.6-27b-iq4-16k" });
  expect(bodies[1].model).toBe("qwen3.6-27b-iq4-16k");
  expect(bodies[1]).not.toHaveProperty("keep_alive");
});
it("эмбеддинг bge-m3-embed идёт с keep_alive=-1", async () => {
  const bodies: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 });
  }) as any);
  await getEmbeddings("текст", { model: "bge-m3-embed:latest" });
  expect(bodies[0]).toMatchObject({ model: "bge-m3-embed:latest", keep_alive: -1 });
});
it("постоянная пара распознаётся с тегом и без", () => {
  expect(isResidentModel("bge-m3-embed")).toBe(true);
  expect(isResidentModel("eriktonon/deepseek-v4.1-flash-1017:9b")).toBe(true);
  expect(keepAliveFor("qwen3.6-27b-iq4-16k:latest")).toEqual({});
});
