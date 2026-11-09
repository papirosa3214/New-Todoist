// Область поиска базы знаний: ищем только по датасетам, включённым в TaskFlow,
// а роль — только по выданным ей. Исключённая «Память — заметки» не должна
// подмешиваться никому, даже если клиент попросил её прямо.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEMORY = "aad90ec0901f11f1be69a9ef96f0a9d6";
const calls: Array<Record<string, any>> = [];

vi.mock("../src/lib/ragflowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    isConfigured: () => true,
    ragflowToken: () => "test-token",
    ragflowDataset: () => "ds-taskflow",
    // Тело запроса к RAGFlow ловим: по нему видно, какие датасеты попали в поиск.
    ragflow: async (_path: string, init?: any) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return { data: { chunks: [], doc_aggs: [] } };
    },
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { ensureDatasetRows, searchDatasetIds, setDatasetRoles } from "../src/lib/knowledgeRegistry.js";

let app: any;
let ownerToken = "";

async function makeUser(name: string, email: string, role?: string) {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name, email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const body = reg.json();
  if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
  return body.token as string;
}

const search = (token: string, url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_API = "http://ragflow.invalid";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  app = await buildApp();
  ownerToken = await makeUser("Владелец поиска", "owner@knowledge-scope.test", "owner");
});

beforeEach(() => {
  calls.length = 0;
  db.exec("DELETE FROM knowledge_dataset_roles");
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY}'`);
  db.exec(`UPDATE knowledge_datasets SET enabled = 0 WHERE dataset_id = '${MEMORY}'`);
  ensureDatasetRows(["ds-taskflow", "ds-other"]);
});

afterAll(() => {
  delete process.env.RAGFLOW_TASKFLOW_DATASET;
});

describe("владелец", () => {
  it("ищет по включённым датасетам и не трогает исключённую память", async () => {
    const res = await search(ownerToken, "/api/knowledge/search?q=как устроен синк");
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].dataset_ids.sort()).toEqual(["ds-other", "ds-taskflow"]);
  });

  it("не ищет по датасету, который исключил, даже когда его просят прямо", async () => {
    const res = await search(ownerToken, `/api/knowledge/search?q=память&dataset_id=${MEMORY}`);
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("область для роли", () => {
  it("без выданных датасетов — отказ, а не весь индекс", () => {
    const scope = searchDatasetIds({ type: "ai", role: "agent", role_key: "researcher" });
    expect(scope).toEqual({ ids: [], reason: "no-scope" });
  });

  it("ищет только по выданным ей и включённым датасетам", () => {
    setDatasetRoles("ds-other", ["researcher"]);
    setDatasetRoles(MEMORY, ["researcher"]);
    const scope = searchDatasetIds({ type: "ai", role: "agent", role_key: "researcher" });
    // Память выдана роли, но исключена владельцем — в поиск не попадает.
    expect(scope.ids).toEqual(["ds-other"]);
  });

  it("не видит датасет, который ей не выдан, даже по прямому указанию", () => {
    setDatasetRoles("ds-other", ["researcher"]);
    const scope = searchDatasetIds({ type: "ai", role: "agent", role_key: "researcher" }, [
      "ds-taskflow",
    ]);
    expect(scope).toEqual({ ids: [], reason: "no-scope" });
  });

  it("Помощник владельца ищет по всем включённым, как владелец", () => {
    const scope = searchDatasetIds({ type: "ai", role: "agent", role_key: "secretary" });
    expect(scope.ids.sort()).toEqual(["ds-other", "ds-taskflow"]);
  });
});
