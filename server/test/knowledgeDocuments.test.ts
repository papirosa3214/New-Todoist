// Документы датасета (09.11.2026): владелец сам загружает файлы в базу знаний,
// смотрит ход разбора, удаляет свои и просит переразобрать. RAGFlow подменён —
// проверяются правила, а не чужой индекс.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEMORY = "aad90ec0901f11f1be69a9ef96f0a9d6";

const ragflowCalls: Array<{ fn: string; args: any[] }> = [];
const docs: Record<string, Array<any>> = {};

vi.mock("../src/lib/ragflowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    isConfigured: () => true,
    ragflowToken: () => "test-token",
    ragflowDataset: () => "ds-taskflow",
    listDocuments: async (datasetId: string, page = 1, pageSize = 50) => {
      ragflowCalls.push({ fn: "listDocuments", args: [datasetId, page, pageSize] });
      const all = docs[datasetId] ?? [];
      return { docs: all.slice((page - 1) * pageSize, page * pageSize), total: all.length };
    },
    uploadDocument: async (datasetId: string, name: string, bytes: Uint8Array) => {
      ragflowCalls.push({ fn: "uploadDocument", args: [datasetId, name, bytes.length] });
      const doc = { id: `rag-${docs[datasetId]?.length ?? 0}-${name}`, name, run: "UNSTART", chunk_count: 0 };
      (docs[datasetId] ??= []).push(doc);
      return { id: doc.id, name };
    },
    parseDocuments: async (datasetId: string, ids: string[]) => {
      ragflowCalls.push({ fn: "parseDocuments", args: [datasetId, ids] });
    },
    deleteDocuments: async (datasetId: string, ids: string[]) => {
      ragflowCalls.push({ fn: "deleteDocuments", args: [datasetId, ids] });
      docs[datasetId] = (docs[datasetId] ?? []).filter((d) => !ids.includes(d.id));
    },
    documentStatus: async (datasetId: string, id: string) => {
      ragflowCalls.push({ fn: "documentStatus", args: [datasetId, id] });
      return { id, name: "taskflow-n1.md", run: "RUNNING", progress: 0.4, message: "разбирается", chunk_count: 3 };
    },
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureDatasetRows } from "../src/lib/knowledgeRegistry.js";

let app: any;
let ownerToken = "";
let otherToken = "";

async function makeUser(name: string, email: string, role?: string) {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, reg.json().user.id);
  return { token: reg.json().token as string, id: reg.json().user.id as string };
}

beforeAll(async () => {
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  process.env.RAGFLOW_API = "http://ragflow.invalid";
  app = await buildApp();
  ownerToken = (await makeUser("Владелец документов", "owner@kb-docs.test", "owner")).token;
  otherToken = (await makeUser("Гость документов", "member@kb-docs.test")).token;
});

beforeEach(() => {
  ragflowCalls.length = 0;
  for (const key of Object.keys(docs)) delete docs[key];
  db.exec("DELETE FROM knowledge_uploads");
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY}'`);
  db.exec(`UPDATE knowledge_datasets SET enabled = 0 WHERE dataset_id = '${MEMORY}'`);
  ensureDatasetRows(["ds-taskflow", "ds-other"]);
  // Дневник уже проиндексировал заметку — имя показываем по-человечески.
  db.exec("DELETE FROM user_notes");
  db.prepare(
    `INSERT INTO user_notes (id, title, content, search_text) VALUES ('n1', 'Заметка про синк', '{}', 'синк')`,
  ).run();
});

afterAll(() => {
  delete process.env.RAGFLOW_TASKFLOW_DATASET;
});

describe("документы датасета", () => {
  it("показывает документы и подставляет заголовок заметки вместо имени файла", async () => {
    docs["ds-taskflow"] = [
      { id: "rag-1", name: "taskflow-n1.md", run: "DONE", chunk_count: 7, size: 120, update_date: "2026-11-09" },
    ];
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/datasets/ds-taskflow/documents",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const [doc] = res.json().documents;
    expect(doc.title).toBe("Заметка про синк");
    expect(doc.ragflow_id).toBe("rag-1");
    expect(doc.indexed).toBe(true);
  });

  it("принимает файл сырыми байтами, сразу ставит его на разбор и помнит, кто залил", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/datasets/ds-other/documents?name=отчёт%20по%20рынку.md",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "text/markdown" },
      payload: Buffer.from("# Отчёт\n\nтекст отчёта") as any,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("отчёт по рынку.md");
    const upload = ragflowCalls.find((c) => c.fn === "uploadDocument")!;
    expect(upload.args[0]).toBe("ds-other");
    expect(upload.args[1]).toBe("отчёт по рынку.md");
    expect(ragflowCalls.some((c) => c.fn === "parseDocuments")).toBe(true);
    const row = db.prepare("SELECT uploaded_by, name FROM knowledge_uploads WHERE ragflow_doc_id = ?").get(
      res.json().ragflow_id,
    ) as any;
    expect(row.name).toBe("отчёт по рынку.md");
  });

  it("не принимает файл без имени", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/datasets/ds-other/documents",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/markdown" },
      payload: Buffer.from("текст") as any,
    });
    expect(res.statusCode).toBe(400);
  });

  it("не принимает загрузку в исключённый датасет", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/knowledge/datasets/${MEMORY}/documents?name=вредный.md`,
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "text/markdown" },
      payload: Buffer.from("текст") as any,
    });
    expect(res.statusCode).toBe(400);
  });

  it("отдаёт ход разбора", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/knowledge/documents/rag-1/status?dataset_id=ds-taskflow",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ run: "RUNNING", chunk_count: 3 });
  });

  it("удаляет только своё: чужой файл — 403, свой — удалён", async () => {
    // Файл залил гость.
    const up = await app.inject({
      method: "POST",
      url: "/api/knowledge/datasets/ds-other/documents?name=черновик.md",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "text/markdown" },
      payload: Buffer.from("черновик") as any,
    });
    const id = up.json().ragflow_id as string;

    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/knowledge/documents/${id}?dataset_id=ds-other`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    // Владелец — карт-бланш: он удаляет что угодно.
    expect(foreign.statusCode).toBe(200);

    const up2 = await app.inject({
      method: "POST",
      url: "/api/knowledge/datasets/ds-other/documents?name=черновик2.md",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "text/markdown" },
      payload: Buffer.from("черновик два") as any,
    });
    const id2 = up2.json().ragflow_id as string;
    const outsider = await app.inject({
      method: "DELETE",
      url: `/api/knowledge/documents/${id2}?dataset_id=ds-other`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(outsider.statusCode).toBe(200); // свой — можно
  });

  it("переразбор требует прав на документ", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/knowledge/datasets/ds-other/documents/reparse",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { document_ids: ["rag-9"] },
    });
    expect(res.statusCode).toBe(200);
    expect(ragflowCalls.some((c) => c.fn === "parseDocuments")).toBe(true);
  });
});
