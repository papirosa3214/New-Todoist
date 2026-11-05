import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { finishObservation, readTaskObservability, startObservation, withObservationContext } from "../src/lib/contextObservability.js";
import { getEmbeddings } from "../src/lib/embeddingClient.js";

// Владелец 05.11.2026: участвовали ли энричеры и эмбеддинги в работе, на каких моделях и как часто.
let app: any;
let auth: { authorization: string };
let owner: string;

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: `ctx-${Date.now()}@test`, password: "password123" } });
  owner = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  auth = { authorization: `Bearer ${reg.json().token}` };
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

async function task() {
  const t = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Контекст" } });
  return t.json().task.id as string;
}

function op(kind: string, scenario: string, taskId: string, subtaskId: string | undefined, status: string, reason?: string, details: string[] = []) {
  const id = startObservation(kind, scenario, { taskId, subtaskId, role: "builder" });
  finishObservation(id, { status, reason, details, inputCount: 5, outputCount: 2 });
}

it("по задаче видно каждый источник, а по этапу что сработало, что пропущено и что упало", async () => {
  const id = await task();
  const child = id + "_c";
  db.prepare("INSERT INTO tasks(id,title,creator_id,parent_id) VALUES (?,'Дочерняя',?,?)").run(child, owner, id);
  op("enricher", "kb", id, "s1", "ok", undefined, ["Урок про кэш"]);
  op("enricher", "kb", id, "s2", "ok");
  op("enricher", "mnemosyne", id, "s1", "error", "source_unavailable");
  op("enricher", "dependencies", id, "s1", "skipped", "empty");
  op("jev", "skills", child, "s9", "ok");

  const data = readTaskObservability(id);
  const kb = data.summary.find((row: any) => row.scenario === "kb")!;
  expect(kb).toMatchObject({ kind: "enricher", calls: 2, succeeded: 2, failed: 0 });
  expect(data.summary.find((row: any) => row.scenario === "mnemosyne")).toMatchObject({ failed: 1, skipped: 0, lastReason: "source_unavailable" });
  expect(data.summary.find((row: any) => row.scenario === "skills")).toMatchObject({ calls: 1 });

  const first = data.stages.s1;
  expect(first.map((row: any) => row.scenario).sort()).toEqual(["dependencies", "kb", "mnemosyne"]);
  expect(first.find((row: any) => row.scenario === "kb")).toMatchObject({ status: "ok", details: ["Урок про кэш"], inputCount: 5, outputCount: 2 });
  expect(first.find((row: any) => row.scenario === "dependencies")).toMatchObject({ status: "skipped", reason: "empty" });
});

it("чужая задача в сводку не попадает", async () => {
  const mine = await task();
  const other = await task();
  op("enricher", "kb", other, "x", "ok");
  expect(readTaskObservability(mine).summary).toEqual([]);
});

it("модели названы, и маршрут отдаёт только владельцу", async () => {
  const id = await task();
  op("enricher", "kb", id, "s1", "ok");
  const data = await app.inject({ method: "GET", url: `/api/coordination/tasks/${id}/context-observability`, headers: auth });
  expect(data.statusCode, data.body).toBe(200);
  expect(data.json().models.embedding).toBeTruthy();
  expect(Object.keys(data.json().models)).toEqual(expect.arrayContaining(["embedding", "jev", "observer"]));
  expect(data.json().stages.s1).toHaveLength(1);
  const role = await app.inject({ method: "GET", url: `/api/coordination/tasks/${id}/context-observability`, headers: { authorization: `Bearer ${app.jwt.sign({ id: "role_builder" })}` } });
  expect(role.statusCode).toBe(403);
  const global = await app.inject({ method: "GET", url: "/api/coordination/context-observability?window=24h", headers: auth });
  expect(global.json().models.embedding).toBeTruthy();
});

it("вызов эмбеддинговой модели записывается с моделью и этапом", async () => {
  const id = await task();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })));
  await withObservationContext({ taskId: id, subtaskId: "emb1" }, () => getEmbeddings("текст", { model: "bge-test", purpose: "memory" }));
  const row = db.prepare("SELECT kind,scenario,status,subtask_id,details FROM context_operations WHERE task_id=? AND kind='embedding'").get(id) as any;
  expect(row).toMatchObject({ kind: "embedding", scenario: "memory", status: "ok", subtask_id: "emb1" });
  expect(JSON.parse(row.details)).toEqual(["bge-test"]);
});

it("сбой эмбеддинга виден как сбой", async () => {
  const id = await task();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("нет модели", { status: 500 })));
  await expect(withObservationContext({ taskId: id }, () => getEmbeddings("текст", { model: "bge-test", purpose: "memory" }))).rejects.toThrow();
  const row = db.prepare("SELECT status FROM context_operations WHERE task_id=? AND kind='embedding'").get(id) as { status: string };
  expect(row.status).toBe("error");
});
