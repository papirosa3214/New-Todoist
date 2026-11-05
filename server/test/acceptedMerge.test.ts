import { afterAll, beforeAll, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { createResultVersion } from "../src/resultVersions.js";
import { setSetting } from "../src/lib/serverSettings.js";
import { selectTargetedTests } from "../src/lib/worktree/testGate.js";

// Роль на интеграции убрана (владелец 05.11.2026): принятое идёт в очередь сразу,
// сбой слияния возвращается тому, кто писал код. Git здесь подменён: сами слияния
// проверяет worktreeMergeQueue.test.ts.
vi.mock("../src/lib/worktree/paths.js", async (original) => ({
  ...(await original<typeof import("../src/lib/worktree/paths.js")>()),
  refExists: () => true,
}));

import { enqueueAcceptedMerge, enqueueAfterStepSubmitted, returnFailedMerge } from "../src/runtime/acceptedMerge.js";

let app: any;
let owner: string;

beforeAll(async () => {
  app = await buildApp();
  demoteSeededOwner(db);
  seedRoleAccounts(db);
  owner = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')").run(owner, owner + "@test");
  setSetting("auto_merge_mode", "on", null, "тест");
  process.env.TASKFLOW_ROLE_WORKTREES = "/tmp/accepted-merge-test";
});
afterAll(async () => {
  process.env.TASKFLOW_ROLE_WORKTREES = "off";
  await app.close();
});

function fixture(opts: { profile?: string; mode?: string; slots?: Array<[string, string]> } = {}) {
  const id = crypto.randomUUID();
  const plan = "p_" + id;
  db.prepare("INSERT INTO tasks(id,title,creator_id,integration_mode,agent_state) VALUES (?,'Accepted code',?,?,'review')").run(id, owner, opts.mode ?? "auto");
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,profile,status,rationale,revision,created_by,version) VALUES (?,?,?,'approved','test',1,?,1)").run(plan, id, opts.profile ?? "manual", owner);
  (opts.slots ?? [["build", "builder"], ["check", "critic_verifier"]]).forEach(([slot, role], index) => {
    db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result) VALUES (?,?,?,?,'Итог')").run(`n_${id}_${slot}`, plan, slot, role);
    db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,result) VALUES (?,?,?,?,?,?,1,'ok')").run(`${id}_${slot}`, id, slot, index + 1, plan, slot);
  });
  return { id, plan };
}

const row = (taskId: string) => db.prepare("SELECT trigger,state FROM worktree_merge_queue WHERE task_id=?").get(taskId) as { trigger: string; state: string } | undefined;

it("принятый результат сразу в очереди, шага и сообщения роли нет", async () => {
  const f = fixture();
  const version = createResultVersion({ taskId: f.id, createdBy: "role_builder", result: "Commit abc" });
  const nodes = () => (db.prepare("SELECT count(*) n FROM task_collaboration_plan_nodes WHERE plan_id=?").get(f.plan) as { n: number }).n;
  const before = nodes();
  const response = await app.inject({
    method: "POST",
    url: "/api/reviews",
    headers: { authorization: "Bearer " + app.jwt.sign({ id: owner }) },
    payload: { task_id: f.id, version_id: version.id, artifact_hash: version.artifact_hash, task_revision: version.task_revision, criteria_version: "1", verdict: "approved", findings: "Checked" },
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(row(f.id)?.state).toBe("queued");
  expect(nodes()).toBe(before);
  expect(db.prepare("SELECT id FROM chat_messages WHERE id=?").get("integration-review:" + response.json().review_id)).toBeUndefined();
});

it("разовая проверка и «не требуется» в очередь не идут", () => {
  const oneShot = fixture({ profile: "result_review" });
  expect(enqueueAcceptedMerge(oneShot.id)).toBe(false);
  expect(row(oneShot.id)).toBeUndefined();
  const none = fixture({ mode: "not_required" });
  expect(enqueueAcceptedMerge(none.id)).toBe(false);
});

it("непройденный контракт держит результат вне main", () => {
  const f = fixture();
  db.prepare("INSERT INTO mission_assertions(id,task_id,assertion_id,title,behavior,status) VALUES (?,?,'A1','Сценарий','Работает','pending')").run(crypto.randomUUID(), f.id);
  expect(enqueueAcceptedMerge(f.id)).toBe(false);
  db.prepare("UPDATE mission_assertions SET status='passed' WHERE task_id=?").run(f.id);
  expect(enqueueAcceptedMerge(f.id)).toBe(true);
});

it("в плане оркестратора очередь открывает сдача его шага сборки, а не рядовой шаг", () => {
  const f = fixture({ profile: "orchestrated", slots: [["orchestrate", "builder"], ["build", "builder"], ["assemble", "builder"]] });
  expect(enqueueAfterStepSubmitted(`${f.id}_build`)).toBe(false);
  expect(enqueueAfterStepSubmitted(`${f.id}_orchestrate`)).toBe(false);
  expect(row(f.id)).toBeUndefined();
  expect(enqueueAfterStepSubmitted(`${f.id}_assemble`)).toBe(true);
  expect(row(f.id)?.state).toBe("queued");
});

it("шаг с тем же именем в обычном плане очередь не открывает", () => {
  const f = fixture({ slots: [["assemble", "builder"]] });
  expect(enqueueAfterStepSubmitted(`${f.id}_assemble`)).toBe(false);
});

it("старый незакрытый шаг интеграции при сдаче всё равно доводит до очереди", () => {
  const f = fixture();
  db.prepare("UPDATE task_collaboration_plan_nodes SET instructions='[taskflow:integration] version=v1' WHERE plan_id=? AND slot_key='build'").run(f.plan);
  expect(enqueueAfterStepSubmitted(`${f.id}_build`)).toBe(true);
});

it("сбой слияния возвращается тому, кто писал код, с причиной", () => {
  const f = fixture({ slots: [["design", "designer"], ["build", "builder"], ["check", "critic_verifier"]] });
  expect(returnFailedMerge(f.id, "конфликт в: a.ts")).toBe(true);
  const fix = db.prepare("SELECT role_key,instructions FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key NOT IN ('design','build','check')").get(f.plan) as { role_key: string; instructions: string };
  expect(fix.role_key).toBe("builder");
  expect(fix.instructions).toContain("конфликт в: a.ts");
  expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(f.id) as { status: string }).status).toBe("active");
});

it("без плана возвращать некому: остаётся событие, а не падение", () => {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES (?,'Без плана',?)").run(id, owner);
  expect(returnFailedMerge(id, "конфликт")).toBe(false);
  expect(db.prepare("SELECT id FROM task_events WHERE task_id=? AND kind='merge_return_failed'").get(id)).toBeDefined();
});

it("точечные тесты: сами изменённые и одноимённые файлу, без полного прогона", () => {
  const all = ["server/test/a.test.ts", "server/test/a.live.test.ts", "server/test/ab.test.ts", "server/test/lib/c.test.ts", "server/test/d.test.ts"];
  expect(selectTargetedTests(["server/src/a.ts", "server/test/d.test.ts", "web/a.ts"], all)).toEqual(["test/a.live.test.ts", "test/a.test.ts", "test/d.test.ts"]);
  expect(selectTargetedTests(["server/src/lib/c.ts"], all)).toEqual(["test/lib/c.test.ts"]);
  expect(selectTargetedTests(["server/src/none.ts"], all)).toEqual([]);
});
