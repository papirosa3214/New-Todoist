// Управление датасетами из приложения: что включено в TaskFlow, по каким
// разделам разложено и каким ролям выдано. Список датасетов приходит из RAGFlow
// и в тесте подменён — здесь проверяются решения владельца, а не чужой индекс.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MEMORY = "aad90ec0901f11f1be69a9ef96f0a9d6";

vi.mock("../src/lib/ragflowClient.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    isConfigured: () => true,
    listDatasets: async () => [
      { id: "ds-taskflow", name: "TaskFlow — документация", document_count: 3, chunk_count: 9 },
      { id: "ds-other", name: "Ресёрч и документация", document_count: 1, chunk_count: 2 },
      { id: MEMORY, name: "Память — заметки", document_count: 5, chunk_count: 40 },
    ],
  };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";

let app: any;
let ownerToken = "";
let memberToken = "";

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

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  // Ключ нужен ручкам, чтобы не ответить «не настроено»; сети не будет.
  process.env.RAGFLOW_TOKEN = "test-token";
  process.env.RAGFLOW_API = "http://ragflow.invalid";
  process.env.RAGFLOW_TASKFLOW_DATASET = "ds-taskflow";
  app = await buildApp();
  ownerToken = await makeUser("Владелец базы", "owner@knowledge-admin.test", "owner");
  memberToken = await makeUser("Участник базы", "member@knowledge-admin.test");
});

beforeEach(() => {
  db.exec("DELETE FROM knowledge_dataset_roles");
  db.exec(`DELETE FROM knowledge_datasets WHERE dataset_id <> '${MEMORY}'`);
  db.exec("UPDATE knowledge_datasets SET enabled = 0, section_id = NULL WHERE dataset_id = '" + MEMORY + "'");
  db.exec("DELETE FROM knowledge_dataset_sections");
});

afterAll(() => {
  delete process.env.RAGFLOW_TASKFLOW_DATASET;
});

describe("список датасетов", () => {
  it("не показывает исключённую память и называет наши датасеты своими", async () => {
    const res = await get("/api/knowledge/datasets", ownerToken);
    expect(res.statusCode).toBe(200);
    const ids = res.json().datasets.map((d: any) => d.id);
    expect(ids).toEqual(["ds-taskflow", "ds-other"]);
    const byId = new Map(res.json().datasets.map((d: any) => [d.id, d]));
    expect((byId.get("ds-taskflow") as any).owner).toBe("taskflow");
    // «Ресёрч и документация» звучит похоже на наш, но это чужой синк.
    expect((byId.get("ds-other") as any).owner).toBe("other");
  });

  it("отдаёт исключённый датасет, когда явно просят все", async () => {
    const res = await get("/api/knowledge/datasets?include_disabled=1", ownerToken);
    const memory = res.json().datasets.find((d: any) => d.id === MEMORY);
    expect(memory).toBeTruthy();
    expect(memory.enabled).toBe(false);
  });
});

describe("настройка владельца", () => {
  it("включает исключённый датасет и кладёт его в раздел", async () => {
    const sec = await app.inject({
      method: "POST",
      url: "/api/knowledge/sections",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Ресёрч" },
    });
    expect(sec.statusCode).toBe(200);
    const sectionId = sec.json().section.id as number;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/knowledge/datasets/${MEMORY}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { enabled: true, section_id: sectionId },
    });
    expect(patched.statusCode).toBe(200);

    const res = await get("/api/knowledge/datasets", ownerToken);
    const memory = res.json().datasets.find((d: any) => d.id === MEMORY);
    expect(memory.enabled).toBe(true);
    expect(memory.section).toEqual({ id: sectionId, title: "Ресёрч" });
  });

  it("выдаёт доступ роли и возвращает выданное", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/knowledge/datasets/ds-taskflow/roles",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { role_keys: ["researcher", "выдуманная-роль"] },
    });
    expect(res.statusCode).toBe(200);
    // Роль отдаётся с названием: приложению нужен человеческий вид чипса.
    expect(res.json().roles.map((r: any) => r.key)).toEqual(["researcher"]);
    expect(res.json().roles[0].title).toBe("Исследователь");
  });

  it("отказывает участнику и в датасетах, и в разделах", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/knowledge/datasets/ds-taskflow",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(403);

    const section = await app.inject({
      method: "POST",
      url: "/api/knowledge/sections",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { title: "Чужой раздел" },
    });
    expect(section.statusCode).toBe(403);

    const roles = await app.inject({
      method: "PUT",
      url: "/api/knowledge/datasets/ds-taskflow/roles",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { role_keys: ["researcher"] },
    });
    expect(roles.statusCode).toBe(403);
  });

  it("переставляет разделы, когда владелец меняет порядок", async () => {
    const first = (await app.inject({
      method: "POST",
      url: "/api/knowledge/sections",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Первый" },
    })).json().section;
    const second = (await app.inject({
      method: "POST",
      url: "/api/knowledge/sections",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Второй" },
    })).json().section;

    await app.inject({
      method: "PATCH",
      url: `/api/knowledge/sections/${second.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { position: 0 },
    });

    const res = await get("/api/knowledge/sections", ownerToken);
    expect(res.json().sections.map((s: any) => s.id)).toEqual([second.id, first.id]);
  });
});
