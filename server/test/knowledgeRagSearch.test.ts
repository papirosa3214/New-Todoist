// Поиск роли по базе знаний: только выданные ей и включённые датасеты.
// RAGFlow подменён — проверяем решение «куда идти и что отдавать».
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEMORY = "aad90ec0901f11f1be69a9ef96f0a9d6";
const calls: any[] = [];
let chunks: any[] = [];
let configured = true;

vi.mock("../src/lib/ragflowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    isConfigured: () => configured,
    retrieval: async (body: any) => {
      calls.push(body);
      return { chunks, docAggs: [] };
    },
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ragSearchForRole } from "../src/lib/roleRagSearch.js";
import { ensureDatasetRows, setDatasetRoles } from "../src/lib/knowledgeRegistry.js";

beforeAll(async () => {
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  // Схема реестра создаётся миграциями в buildApp, не при импорте db.
  await buildApp();
});

beforeEach(() => {
  calls.length = 0;
  configured = true;
  chunks = [
    { content: "Документация проекта описана в docs.", similarity: 0.71, document_name: "taskflow-n1.md", document_id: "d1", dataset_id: "ds-taskflow" },
  ];
  db.exec(`DELETE FROM knowledge_dataset_roles`);
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY}'`);
  db.exec(`UPDATE knowledge_datasets SET enabled = 0 WHERE dataset_id = '${MEMORY}'`);
  ensureDatasetRows(["ds-taskflow", "ds-other"]);
});

describe("поиск роли по базе знаний", () => {
  it("идёт только по выданным и включённым датасетам", async () => {
    setDatasetRoles("ds-taskflow", ["builder"]);
    setDatasetRoles("ds-other", ["critic_verifier"]);
    const res = await ragSearchForRole("builder", "документация проекта");
    expect(calls).toHaveLength(1);
    expect(calls[0].dataset_ids).toEqual(["ds-taskflow"]);
    expect(res.куски[0]).toMatchObject({ оценка: 0.71, название: "taskflow-n1.md" });
  });

  it("исключённый владельцем датасет не ищется даже при выдаче", async () => {
    setDatasetRoles("ds-taskflow", ["builder"]);
    db.prepare("UPDATE knowledge_datasets SET enabled = 0 WHERE dataset_id = 'ds-taskflow'").run();
    const res = await ragSearchForRole("builder", "что угодно");
    expect(calls).toHaveLength(0);
    expect(res.куски).toEqual([]);
    expect(res.подсказка).toContain("не выдан");
  });

  it("без выдачи честно говорит, что доступа нет", async () => {
    const res = await ragSearchForRole("qa", "документация");
    expect(calls).toHaveLength(0);
    expect(res.подсказка).toContain("не выдан");
  });

  it("пустой запрос не ходит в базу", async () => {
    setDatasetRoles("ds-taskflow", ["builder"]);
    const res = await ragSearchForRole("builder", "   ");
    expect(calls).toHaveLength(0);
    expect(res.подсказка).toContain("пустой");
  });

  it("держит потолок top_k и не выходит за границы", async () => {
    setDatasetRoles("ds-taskflow", ["builder"]);
    await ragSearchForRole("builder", "много", 500);
    expect(calls[0].page_size).toBe(20);
    await ragSearchForRole("builder", "мало", 0);
    expect(calls[1].page_size).toBe(5);
  });

  it("без доступа к RAGFlow не выдаёт пустоту за ответ", async () => {
    setDatasetRoles("ds-taskflow", ["builder"]);
    configured = false;
    const res = await ragSearchForRole("builder", "документация");
    expect(calls).toHaveLength(0);
    expect(res.подсказка).toContain("не настроена");
  });
});
