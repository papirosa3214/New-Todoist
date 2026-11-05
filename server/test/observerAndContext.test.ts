import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../src/lib/runtimeAi.js", () => ({ callRuntimeModel: vi.fn() }));
vi.mock("../src/runtime/memoryObserverChatChip.js", () => ({ postMemoryUpdateChip: vi.fn() }));

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { callRuntimeModel } from "../src/lib/runtimeAi.js";
import { observeSlotMemory } from "../src/runtime/slotMemoryObserver.js";
import { shouldObserveSlot, type SlotSnapshotRow } from "../src/runtime/slotWorkSnapshot.js";
import { finishObservation, readTaskObservability, startObservation } from "../src/lib/contextObservability.js";
import { recall, remember } from "../src/lib/memory.js";

// Наблюдатель не записал ни одного урока: обычная сдача пишет снимок с пометкой «неполный»,
// а он ждал полного. Заодно контекст теперь показывает, что именно получила роль (05.11.2026).
let app: any;
let owner: string;

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: `obs-${Date.now()}@test`, password: "password123" } });
  owner = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), { status: 200 })));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

function snapshot(overrides: Partial<SlotSnapshotRow> = {}): SlotSnapshotRow {
  const id = `obs_${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES (?,'Задача наблюдателя',?)").run(id, owner);
  return {
    id, task_id: id, subtask_id: `${id}_s`, attempt_id: `${id}_a`, role_key: "builder", plan_node_key: "work", reason: "done",
    is_complete: 0, done_summary: "Поправил кэш: инвалидировать надо по версии", left_summary: null, blocker: null, next_step: null,
    last_action: null, artifacts_json: "[]", author_id: "role_builder", created_at: "2026-11-05", ...overrides,
  } as SlotSnapshotRow;
}
const events = (taskId: string) => db.prepare("SELECT outcome FROM memory_observer_events WHERE task_id=?").all(taskId) as Array<{ outcome: string }>;

it("наблюдатель запускается на обычной сдаче, а не только на «полном» снимке", () => {
  expect(shouldObserveSlot("done", "Сделано")).toBe(true);
  expect(shouldObserveSlot("done", null)).toBe(false);
  expect(shouldObserveSlot("failed", "Сделано")).toBe(false);
});

it("снимок сдачи с пометкой «неполный» доходит до модели и пишет урок в память роли", async () => {
  vi.mocked(callRuntimeModel).mockResolvedValue(JSON.stringify({ action: "remember", title: "Кэш по версии", text: "Кэш инвалидируется по версии записи.", kind: "lesson", confidence: 0.95 }));
  const row = snapshot();
  await expect(observeSlotMemory(row)).resolves.toEqual({ wrote: true });
  expect(events(row.task_id).map((e) => e.outcome)).toEqual(["wrote"]);
  const memory = db.prepare("SELECT scope,role_key,title FROM memories WHERE source_ref=?").get(`obs:${row.subtask_id}:${row.attempt_id}`) as any;
  expect(memory).toMatchObject({ scope: "role", role_key: "builder", title: "Кэш по версии" });
});

it("сдача без итога не дёргает модель и оставляет след в журнале", async () => {
  vi.mocked(callRuntimeModel).mockClear();
  const row = snapshot({ done_summary: null });
  await expect(observeSlotMemory(row)).resolves.toMatchObject({ wrote: false, reason: "not_done" });
  expect(callRuntimeModel).not.toHaveBeenCalled();
  expect(events(row.task_id).map((e) => e.outcome)).toEqual(["not_done"]);
});

it("сбой модели виден в журнале, а не теряется", async () => {
  vi.mocked(callRuntimeModel).mockRejectedValue(new Error("модель недоступна"));
  const row = snapshot();
  await expect(observeSlotMemory(row)).resolves.toMatchObject({ reason: "model" });
  expect(events(row.task_id).map((e) => e.outcome)).toEqual(["model"]);
});

it("в журнал попадает, что именно получила роль: запись, откуда она и её объём", async () => {
  const task = `ctx_${Date.now()}`;
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES (?,'Контекст',?)").run(task, owner);
  await remember({ scope: "role", role_key: "qa", kind: "lesson", title: "Урок лично для проверки сессий", text: "Личный урок про проверку сессий" }, { id: "role_qa", kind: "role" }, { skipWriteReview: true });
  await remember({ scope: "team", kind: "fact", title: "Общий факт про проверку сессий", text: "Общий факт про проверку сессий" }, { id: owner, kind: "owner" }, { skipWriteReview: true });
  await recall({ roleKey: "qa", query: "проверка сессий", limit: 8 });
  const op = db.prepare("SELECT items FROM context_operations WHERE scenario='teamMemory' ORDER BY rowid DESC LIMIT 1").get() as { items: string };
  const items = JSON.parse(op.items) as Array<{ title: string; source: string; chars: number; excerpt: string }>;
  const personal = items.find((i) => i.title === "Урок лично для проверки сессий");
  expect(personal).toMatchObject({ source: "role", chars: "Личный урок про проверку сессий".length });
  expect(personal?.excerpt).toContain("Личный урок");
  expect(items.find((i) => i.title === "Общий факт про проверку сессий")?.source).toBe("team");

  const id = startObservation("enricher", "kb", { taskId: task, subtaskId: "s1", role: "builder" });
  finishObservation(id, { status: "ok", outputCount: 1, items: [{ title: "Урок", source: "kb", chars: 900, excerpt: "текст" }] });
  const late = startObservation("enricher", "kb", { taskId: task, subtaskId: "s2", role: "qa" });
  finishObservation(late, { status: "ok", outputCount: 1, items: [{ title: "Другой", source: "kb", chars: 50, excerpt: "т" }] });
  const data = readTaskObservability(task);
  expect(data.stages.s1[0]).toMatchObject({ role: "builder", items: [{ title: "Урок", source: "kb", chars: 900, excerpt: "текст" }] });
  const roles = data.roles.map((r: any) => [r.role, r.scenario, r.chars]);
  expect(roles).toEqual(expect.arrayContaining([["builder", "kb", 900], ["qa", "kb", 50]]));
});
