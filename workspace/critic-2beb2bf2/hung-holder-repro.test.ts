// Проверка критика (карточка 2beb2bf2, критерий приёмки №1):
// «Слот с умершим запуском (hung_holder) порождает одно сообщение
// оркестратору в чат: карточка, шаг, роль, факт зависания, факт авторестарта».
//
// Сценарий 16.10.2026, ради которого карточка и написана: у разработчика
// УМЕРШИЙ ЗАПУСК, который держит слот. Боевой путь:
//   stalledStepWatcher.restartAttempt
//     → startPlanSubtaskRun
//       → runRoleInProcess            (inProcessRun.ts:1204)
//         → await acquireSlotSession (inProcessRun.ts:1205)
// `tails` — процессная карта; если прежний запуск умер и не отпустил
// слот, acquireSlotSession ждёт вечно. Ниже это воспроизведено буквально:
// мок входит в настоящий acquireSlotSession и не отпускает его.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/runtime/inProcessRun.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/inProcessRun.js")>();
  const { acquireSlotSession } = await import("../src/runtime/slotSession.js");
  return {
    ...actual,
    // Умерший запуск, который держат слот: сессию заняли и не отпускают.
    runRoleInProcess: async (input: { subtaskId?: string }) => {
      if (input?.subtaskId) await acquireSlotSession(input.subtaskId); // вечно
      throw new Error("unreachable");
    },
  };
});

import db from "../src/db.js";
import { buildApp } from "../src/index.js";
import { roleUserId } from "../src/roleRouting.js";
import { runStalledStepWatch } from "../src/runtime/stalledStepWatcher.js";
import { slotSessionDirectory } from "../src/runtime/slotSession.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const sessionsDir = path.join(process.env.TASKFLOW_RUNS_DIR ?? os.tmpdir(), "sessions");
const ORCH_CHAT = `orchestrator-wake:${roleUserId("code_orchestrator")}`;
const orchMessages = (): Array<{ id: string; text: string }> =>
  db.prepare("SELECT id, text FROM chat_messages WHERE chat_id = ? ORDER BY rowid").all(ORCH_CHAT) as Array<{ id: string; text: string }>;

function seedSessionJournal(taskId: string, role: string, step: string, minutesAgo: number): void {
  const dir = slotSessionDirectory(taskId, role, step);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_critic-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, '{"step":"critic"}\n');
  const mtime = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, mtime, mtime);
}

describe("критик: hung_holder", () => {
  let app: FastifyInstance;
  let taskId = "";
  let subtaskId = "";

  beforeAll(async () => {
    process.env.TASKFLOW_SESSIONS_DIR = sessionsDir;
    fs.mkdirSync(sessionsDir, { recursive: true });
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare(
      `INSERT OR IGNORE INTO users (id,name,email,password_hash,role,role_key,type,avatar_color,initials,status,is_system_bot)
       VALUES ('role_code_orchestrator','Code Orchestrator','orchestrator@taskflow.local','','agent',NULL,'ai','#8E8E93','O','offline',1)`,
    ).run();
  });

  beforeEach(async () => {
    db.prepare("DELETE FROM chat_message_queue WHERE chat_id LIKE 'orchestrator-wake:%'").run();
    db.prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'orchestrator-wake:%'").run();
    db.prepare(`UPDATE subtasks SET agent_state='todo', agent_id=NULL, current_attempt_id=NULL, agent_heartbeat_at=NULL WHERE collaboration_plan_id IS NOT NULL`).run();
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Critic owner", email: `critic-${Date.now()}-${Math.random()}@test`, password: "password123" } });
    const userId = reg.json().user.id;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(userId);
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE role='owner'").run();
    const auth = { authorization: `Bearer ${reg.json().token}` };
    const task = await app.inject({ method: "POST", url: "/api/tasks", headers: auth, payload: { title: "Stalled fixture" } });
    taskId = task.json().task.id;
    const plan = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/collaboration-plans`,
      headers: auth,
      payload: { profile: "manual", rationale: "тест", nodes: [{ slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" }], edges: [] },
    });
    const approve = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/collaboration-plans/${plan.json().id ?? plan.json().plan?.id}/approve`, headers: auth });
    expect(approve.statusCode).toBeLessThan(300);
    subtaskId = (db.prepare("SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'").get(taskId) as { id: string }).id;
  });

  it("зависание с умершим держателем слота: сообщение уходит, тик не замирает", async () => {
    const attemptId = "att_critic_hung_" + Date.now();
    db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id,started_at,ended_at,outcome,reason) VALUES (?,?,?,?,datetime('now','-30 minutes'),NULL,NULL,NULL)")
      .run(attemptId, taskId, subtaskId, roleUserId("builder"));
    db.prepare("UPDATE subtasks SET agent_state='in_progress', agent_id=?, current_attempt_id=? WHERE id=?")
      .run(roleUserId("builder"), attemptId, subtaskId);
    seedSessionJournal(taskId, "builder", subtaskId, 30);

    // Тик сторожа. Если зависший слот держит мёртвый запуск, тик не
    // завершится никогда — об этом и тест: ждём 5 секунд и смотрим.
    const timeout = Symbol("timeout");
    const result = await Promise.race([runStalledStepWatch(), new Promise((r) => setTimeout(() => r(timeout), 5000))]);

    const messages = orchMessages();
    console.log("[critic] тик завершился:", result !== timeout, "| сообщений оркестратору:", messages.length);
    for (const m of messages) console.log("[critic] сообщение:", m.id, "|", m.text.slice(0, 160));
    const subtaskNow = db.prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id=?").get(subtaskId) as any;
    fs.writeFileSync("/tmp/hung-evidence.json", JSON.stringify({
      tickResolved: result !== timeout,
      orchestratorMessages: messages.length,
      messageIds: messages.map((m) => m.id),
      subtaskAfterTick: subtaskNow,
      attemptAfterTick: db.prepare("SELECT outcome, ended_at FROM attempts WHERE id=?").get(attemptId),
      roleRunJobs: db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(taskId),
    }, null, 2));

    fs.writeFileSync("/tmp/hung-evidence2.json", JSON.stringify({
      tickResolved: result !== timeout,
      orchestratorMessages: messages.length,
      messageIds: messages.map((m) => m.id),
      messageTexts: messages.map((m) => m.text),
      subtaskAfterTick: subtaskNow,
      roleRunJobs: db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(taskId),
    }, null, 2));
    // После доработки: сообщение уходит, тик не замирает.
    expect(messages).toHaveLength(1);
    expect(result).not.toBe(timeout);
  }, 30000);
});
