import {reserveReviewRun,assertReviewRunAllowed,finishReviewRun} from "../src/runtime/reviewRunBudget.js";
import {queuePlanFinalReview,markPlanFinalReviewerWaiting} from "../src/runtime/planReviewLifecycle.js";
// 20.10.2026, карточка 1e8c05e2: проход критика кончился без вердикта,
// шаг сбросили, а повторный запуск узла приёмки ничего не поставил в
// очередь — ключ «план + узел + версия» уже был у отработавшего задания,
// и защита от дублей молча возвращала старое.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/inProcessRun.js")>()),
  runRoleInProcess: vi.fn(async () => ({
    runId: "test-run",
    completion: Promise.resolve(),
  })),
}));

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { startPlanSubtaskRun } from "../src/runtime/planSubtaskAdmission.js";

describe("повторная постановка итоговой приёмки", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let owner: string;
  let task: string;
  let critic: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare(
      "UPDATE users SET task_intake_mode='manual' WHERE role='owner'",
    ).run();
    owner = `requeue-owner-${crypto.randomUUID()}`;
    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,'Requeue owner',?,'!','owner','human')",
    ).run(owner, `${owner}@test`);
    const auth = { authorization: `Bearer ${app.jwt.sign({ id: owner })}` };
    task = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: auth,
        payload: { title: "Requeue plan" },
      })
    ).json().task.id;
    const plan = (
      await app.inject({
        method: "POST",
        url: `/api/tasks/${task}/collaboration-plans`,
        headers: auth,
        payload: {
          profile: "manual",
          nodes: [
            {
              slot_key: "executor",
              role_key: "builder",
              required: true,
              expected_result: "Реализация",
            },
            {
              slot_key: "verifier",
              role_key: "critic_verifier",
              required: true,
              expected_result: "Приёмка",
            },
          ],
          edges: [
            {
              from_slot_key: "executor",
              to_slot_key: "verifier",
              start_condition: "submitted",
            },
          ],
        },
      })
    ).json().plan.id;
    await app.inject({
      method: "POST",
      url: `/api/tasks/${task}/collaboration-plans/${plan}/approve`,
      headers: auth,
    });
    db.prepare(
      "UPDATE subtasks SET done=1, agent_state=NULL, result='ok', agent_heartbeat_at=NULL WHERE task_id=? AND plan_node_key='executor'",
    ).run(task);
    critic = (
      db
        .prepare(
          "SELECT id FROM subtasks WHERE task_id=? AND plan_node_key='verifier'",
        )
        .get(task) as { id: string }
    ).id;
    db.prepare(
      "UPDATE subtasks SET agent_state=NULL, agent_id=NULL WHERE id=?",
    ).run(critic);
    db.prepare("DELETE FROM role_run_jobs WHERE task_id=?").run(task);
  });

  afterAll(async () => {
    db.prepare("DELETE FROM role_run_jobs WHERE task_id=?").run(task);
    await app.close();
  });

  const reviewJobs = () =>
    db
      .prepare(
        "SELECT status FROM role_run_jobs WHERE task_id=? AND reason='review' ORDER BY created_at, rowid",
      )
      .all(task) as Array<{ status: string }>;

  it("после прохода без вердикта и сброса шага приёмка встаёт в очередь заново", async () => {
    expect((await startPlanSubtaskRun(critic, owner)).ok).toBe(true);
    expect(reviewJobs()).toEqual([{ status: "queued" }]);

    // Пока задание ждёт — повторный запуск дубля не создаёт.
    db.prepare("UPDATE subtasks SET agent_state=NULL WHERE id=?").run(critic);
    await startPlanSubtaskRun(critic, owner);
    expect(reviewJobs()).toHaveLength(1);

    // Проход отработал без вердикта, шаг сбросили.
    db.prepare(
      "UPDATE role_run_jobs SET status='succeeded', finished_at=datetime('now') WHERE task_id=? AND reason='review'",
    ).run(task);
    db.prepare("UPDATE subtasks SET agent_state=NULL WHERE id=?").run(critic);
    await startPlanSubtaskRun(critic, owner);
    expect(reviewJobs()).toEqual([
      { status: "succeeded" },
      { status: "queued" },
    ]);
  });
  it("три прохода без вердикта нельзя обойти новой очередью и сбросом шага", () => {
    for(let i=0;i<3;i++){
      const ticket=reserveReviewRun(task);
      assertReviewRunAllowed(ticket);
      expect(()=>finishReviewRun(ticket)).toThrow(/без сохранённого вердикта/);
    }
    expect(queuePlanFinalReview(critic,owner).ok).toBe(false);
    markPlanFinalReviewerWaiting(task);
    expect(db.prepare("SELECT agent_state FROM subtasks WHERE id=?").get(critic)).toEqual({agent_state:"blocked"});
    expect(db.prepare("SELECT agent_state FROM tasks WHERE id=?").get(task)).toEqual({agent_state:"blocked"});
  });

});
