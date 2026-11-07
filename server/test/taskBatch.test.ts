// Батч карточек по id — `POST /api/tasks/batch` (заметка «Кэш и синхронизация
// в мобильных клиентах», п.3 плана: батч вместо N × GET /tasks/:id).
//
// Что проверяем:
//   1. Форма ответа батча СОВПАДАЕТ с формой списка (`projection=list`): клиент
//      кладёт в локальную базу ответ сервера как есть, и две формы одной
//      карточки в одной базе — это рассинхрон полей.
//   2. Закрытая (выполненная) карточка в батч ВХОДИТ, хотя в списке её нет:
//      клиент должен убрать её из живых списков и положить в архив.
//   3. Пустой список id → пустой ответ, без ошибки.
//   4. Неизвестный id просто не попадает в ответ.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let owner: string;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp();
  owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
  token = app.jwt.sign({ id: owner });
  db.prepare("INSERT INTO tasks (id,title,creator_id,status) VALUES (?,?,?,?)").run(
    "batch-live",
    "Живая карточка",
    owner,
    "active",
  );
  db.prepare("INSERT INTO tasks (id,title,creator_id,status,completed_at) VALUES (?,?,?,?,datetime('now'))").run(
    "batch-closed",
    "Закрытая карточка",
    owner,
    "completed",
  );
});

afterAll(async () => {
  await app?.close();
});

describe("батч карточек по id", () => {
  it("форма батча совпадает с формой списка", async () => {
    const list = (await app.inject({
      method: "GET",
      url: "/api/tasks?include_children=true&projection=list",
      headers: auth(),
    })).json() as any[];
    const listItem = list.find((t) => t.id === "batch-live");
    expect(listItem).toBeTruthy();

    const batch = (await app.inject({
      method: "POST",
      url: "/api/tasks/batch",
      headers: auth(),
      payload: { ids: ["batch-live"] },
    })).json() as { tasks: any[] };
    expect(batch.tasks.length).toBe(1);
    const batchItem = batch.tasks[0];

    // Ключи те же и в том же наборе — клиент не разбирает формы.
    expect(Object.keys(batchItem).sort()).toEqual(Object.keys(listItem).sort());
    expect(batchItem.id).toBe("batch-live");
    expect(batchItem.title).toBe(listItem.title);
    // Лёгкая форма списка: подзадачи — числами, не массивом.
    expect(batchItem.subtask_total).toBe(0);
    expect(batchItem.subtasks).toBeUndefined();
    expect(batchItem.children_total).toBe(0);
    expect(Array.isArray(batchItem.labels)).toBe(true);
  });

  it("закрытая карточка в батче есть — клиент переносит её в архив", async () => {
    const list = (await app.inject({
      method: "GET",
      url: "/api/tasks?include_children=true&projection=list",
      headers: auth(),
    })).json() as any[];
    expect(list.find((t) => t.id === "batch-closed")).toBeUndefined();

    const batch = (await app.inject({
      method: "POST",
      url: "/api/tasks/batch",
      headers: auth(),
      payload: { ids: ["batch-closed"] },
    })).json() as { tasks: any[] };
    expect(batch.tasks.length).toBe(1);
    expect(batch.tasks[0].id).toBe("batch-closed");
    expect(batch.tasks[0].status).toBe("completed");
  });

  it("несколько id одним запросом; неизвестный просто не попадает в ответ", async () => {
    const batch = (await app.inject({
      method: "POST",
      url: "/api/tasks/batch",
      headers: auth(),
      payload: { ids: ["batch-live", "batch-closed", "нет-такой-карточки"] },
    })).json() as { tasks: any[] };
    expect(batch.tasks.map((t) => t.id).sort()).toEqual(["batch-closed", "batch-live"]);
  });

  it("пустой список id — пустой ответ, без ошибки", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/batch",
      headers: auth(),
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tasks: any[] }).tasks).toEqual([]);
  });
});

it("single task GET returns server-prepared reading and editor documents", async () => {
  const response = await app.inject({ method: "GET", url: "/api/tasks/batch-live", headers: auth() });
  expect(response.statusCode).toBe(200);
  const task = response.json();
  expect(task.title_document?.type).toBe("doc");
  expect(task.description_document?.type).toBe("doc");
  expect(task.description_blocks).toEqual([]);
});
