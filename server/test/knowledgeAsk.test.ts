// «Спросить базу» (09.11.2026): ответ формулирует модель сервера по найденным
// кускам, а не RAGFlow-ассистент. Проверяются область поиска, промпт из кусков
// и поведение без модели. RAGFlow и модель подменены.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEMORY = "aad90ec0901f11f1be69a9ef96f0a9d6";
const retrievalCalls: any[] = [];
const aiCalls: Array<Record<string, any>> = [];
let aiFails = false;
let chunks: any[] = [];

vi.mock("../src/lib/ragflowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    isConfigured: () => true,
    ragflowToken: () => "test-token",
    ragflowDataset: () => "ds-taskflow",
    retrieval: async (body: any) => {
      retrievalCalls.push(body);
      return { chunks, docAggs: [] };
    },
  };
});

vi.mock("../src/lib/aiClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    callUnifiedAi: async (opts: any) => {
      aiCalls.push(opts);
      if (aiFails) throw new Error("модель недоступна");
      return "Синк ходит в RAGFlow раз в сутки [1].";
    },
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureDatasetRows } from "../src/lib/knowledgeRegistry.js";

let app: any;
let token = "";

beforeAll(async () => {
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  process.env.RAGFLOW_API = "http://ragflow.invalid";
  app = await buildApp();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Спрашивающий", email: "owner@kb-ask.test", password: "password123" },
  });
  token = reg.json().token;
  db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
});

beforeEach(() => {
  retrievalCalls.length = 0;
  aiCalls.length = 0;
  aiFails = false;
  chunks = [
    { content: "Синк заметок в RAGFlow идёт раз в сутки.", similarity: 0.82, document_name: "taskflow-n1.md" },
    { content: "Второй кусок про документацию проекта.", similarity: 0.51, document_name: "taskflow-n2.md" },
  ];
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY}'`);
  db.exec(`UPDATE knowledge_datasets SET enabled = 0 WHERE dataset_id = '${MEMORY}'`);
  ensureDatasetRows(["ds-taskflow", "ds-other"]);
});

afterAll(() => {
  delete process.env.RAGFLOW_TASKFLOW_DATASET;
});

const ask = (body: any) =>
  app.inject({
    method: "POST",
    url: "/api/knowledge/ask",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

describe("спросить базу", () => {
  it("отвечает по найденным кускам и показывает источники", async () => {
    const res = await ask({ question: "как ходит синк", dataset_ids: ["ds-taskflow"] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toContain("RAGFlow");
    expect(body.chunks).toHaveLength(2);
    expect(body.chunks[0]).toMatchObject({ score: 0.82, document_name: "taskflow-n1.md" });
    // Промпт собран из кусков с номерами — на них модель ссылается [1], [2].
    expect(aiCalls[0].userPrompt).toContain("[1]");
    expect(aiCalls[0].userPrompt).toContain("Синк заметок в RAGFlow идёт раз в сутки.");
    expect(retrievalCalls[0].dataset_ids).toEqual(["ds-taskflow"]);
  });

  it("не ищет без датасета и не трогает исключённый", async () => {
    expect((await ask({ question: "что-нибудь" })).statusCode).toBe(400);
    expect(
      (await ask({ question: "память", dataset_ids: [MEMORY] })).statusCode,
    ).toBe(400);
    expect(retrievalCalls).toHaveLength(0);
  });

  it("без вопроса не отвечает", async () => {
    expect((await ask({ dataset_ids: ["ds-taskflow"] })).statusCode).toBe(400);
  });

  it("если модель упала — отдаёт куски без ответа, а не ошибку", async () => {
    aiFails = true;
    const res = await ask({ question: "как ходит синк", dataset_ids: ["ds-taskflow"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeNull();
    expect(res.json().chunks).toHaveLength(2);
  });

  it("держит потолок выдачи: не больше восьми кусков", async () => {
    chunks = Array.from({ length: 12 }, (_, i) => ({
      content: `кусок ${i}`,
      similarity: 0.9 - i * 0.01,
      document_name: `taskflow-n${i}.md`,
    }));
    const res = await ask({ question: "много кусков", dataset_ids: ["ds-taskflow"] });
    expect(res.json().chunks).toHaveLength(8);
    expect(res.json().chunks.map((c: any) => c.text)).not.toContain("кусок 9");
  });

  it("пустая выдача — честное «не нашлось», модель не зовём", async () => {
    chunks = [];
    const res = await ask({ question: "чего нет", dataset_ids: ["ds-taskflow"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeNull();
    expect(res.json().chunks).toEqual([]);
    expect(res.json().hint).toContain("не нашлось");
    expect(aiCalls).toHaveLength(0);
  });
});
