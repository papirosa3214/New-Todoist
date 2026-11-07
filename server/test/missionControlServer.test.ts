import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  return { ...actual, runRoleInProcess: async () => ({ runId: "mc-run", completion: new Promise(() => {}) }) };
});

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { startPlanSubtaskRun } from "../src/runtime/planSubtaskAdmission.js";
import { recordModelUsage } from "../src/lib/modelUsage.js";
import { missionTime } from "../src/lib/missionTime.js";
import { missionLog } from "../src/lib/missionContract.js";

// Данные шапки Mission Control (владелец 05.11.2026): настоящая пауза, расход по задаче, журнал.
let app: any;
let auth: { authorization: string };
let owner: string;

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Owner", email: `mc-${Date.now()}@test`, password: "password123" } });
  owner = reg.json().user.id;
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner);
  auth = { authorization: `Bearer ${reg.json().token}` };
});
afterAll(async () => app.close());

async function twoSteps() {
  const t = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Пауза" } });
  const taskId = t.json().task.id as string;
  const p = await app.inject({
    method: "POST", url: `/api/tasks/${taskId}/collaboration-plans`, headers: auth,
    payload: { profile: "manual", nodes: [{ slot_key: "first", role_key: "builder", expected_result: "Первый" }, { slot_key: "second", role_key: "qa", expected_result: "Второй" }], edges: [{ from_slot_key: "first", to_slot_key: "second" }] },
  });
  expect(p.statusCode, p.body).toBe(201);
  const planId = p.json().plan.id as string;
  const a = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`, headers: auth });
  expect(a.statusCode, a.body).toBe(200);
  return { taskId, planId };
}
const step = (planId: string, slot: string) => db.prepare("SELECT id,agent_state,done FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key=?").get(planId, slot) as { id: string; agent_state: string | null; done: number };

it("пауза останавливает идущий шаг и не даёт стартовать новым", async () => {
  const { taskId, planId } = await twoSteps();
  expect(step(planId, "first").agent_state).toBe("in_progress");
  const paused = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/pause`, headers: auth });
  expect(paused.statusCode, paused.body).toBe(200);
  expect(paused.json().plan.paused_at).toBeTruthy();
  expect(step(planId, "first").agent_state).toBeNull();
  const refused = await startPlanSubtaskRun(step(planId, "first").id, owner);
  expect(refused).toEqual({ ok: false, error: expect.stringContaining("пауз") });
});

it("снятие с паузы запускает то, что готово", async () => {
  const { taskId, planId } = await twoSteps();
  await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/pause`, headers: auth });
  const resumed = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/resume`, headers: auth });
  expect(resumed.statusCode, resumed.body).toBe(200);
  expect(resumed.json().plan.paused_at).toBeNull();
  expect(step(planId, "first").agent_state).toBe("in_progress");
  expect(step(planId, "second").agent_state).toBeNull();
  const kinds = (db.prepare("SELECT kind FROM mission_events WHERE task_id=? ORDER BY rowid").all(taskId) as Array<{ kind: string }>).map((e) => e.kind);
  expect(kinds).toEqual(["mission_paused", "mission_resumed"]);
});

it("паузу ставит владелец или оркестратор", async () => {
  const { taskId, planId } = await twoSteps();
  const role = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/pause`, headers: { authorization: `Bearer ${app.jwt.sign({ id: "role_builder" })}` } });
  expect(role.statusCode).toBe(403);
});

it("расход считается по задаче вместе с дочерними карточками", async () => {
  const parent = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Расход" } });
  const id = parent.json().task.id as string;
  db.prepare("INSERT INTO tasks(id,title,creator_id,parent_id) VALUES (?,'Дочерняя',?,?)").run(id + "_c", owner, id);
  const message = (at: number, input: number, output: number) => ({ role: "assistant", timestamp: at, provider: "p", model: "m", content: [{ text: `${at}` }], usage: { input, output, cacheRead: 500 } });
  expect(recordModelUsage(message(Date.now(), 100, 20), "task", id)).toBe(true);
  expect(recordModelUsage(message(Date.now() + 1, 30, 5), "task", id + "_c")).toBe(true);
  expect(recordModelUsage(message(Date.now() + 2, 999, 999), "chat")).toBe(true);
  expect(missionTime(id).tokens).toBe(155);
});

it("журнал показывает обычные события работы, новые сверху", async () => {
  const { taskId, planId } = await twoSteps();
  await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${planId}/pause`, headers: auth });
  const log = missionLog(taskId);
  const kinds = log.map((e) => e.kind);
  expect(kinds).toContain("mission_paused");
  expect(kinds).toContain("plan_subtask_started");
  expect(kinds.some((kind) => kind === "review_recorded" || kind === "chat_session_bump")).toBe(false);
  const http = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-events`, headers: auth });
  expect(http.json().events.map((e: { kind: string }) => e.kind)).toContain("plan_subtask_started");
});
