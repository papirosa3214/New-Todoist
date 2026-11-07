// Отметка «Критик проверил» рядом с «На проверке» (владелец 07.10.2026).
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { logEvent } from "../src/agentState.js";
import { criticApproved, withAgentStale } from "../src/routes/tasks.js";
import { taskRoomClosedAt } from "../src/lib/projectTopics.js";

describe("critic_approved", () => {
  let owner: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp();
    owner = (db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string }).id;
  });
  afterAll(async () => { await app.close(); });
  const task = () => {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO tasks(id,title,creator_id,status,agent_state) VALUES(?,'На проверке',?,'active','review')").run(id, owner);
    return id;
  };
  const event = (taskId: string, kind: string, toValue: string, at: string) => {
    logEvent({ taskId, actorId: null, kind, field: "x", toValue });
    db.prepare("UPDATE task_events SET created_at=? WHERE task_id=? AND kind=? AND to_value=?").run(at, taskId, kind, toValue);
  };
  const planWithLastStep = (taskId: string, role: string, result: string | null) => {
    const plan = `tcp_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,created_by) VALUES(?,?,1,'approved','manual',?)").run(plan, taskId, owner);
    for (const [i, [slot, r, res]] of ([["work", "builder", "Готово"], ["check", role, result], ["after", "qa", "Проверено"]] as const).entries()) {
      db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,?,?,1,'x')").run(`tcpn_${crypto.randomUUID()}`, plan, slot, r);
      db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,result) VALUES(?,?,'x',?,?,?,1,?)").run(crypto.randomUUID(), taskId, i + 1, plan, slot, res);
    }
  };

  it("нет вердикта и плана — не отмечена; поле приходит в данных задачи", () => {
    const id = task();
    expect(criticApproved(id)).toBe(false);
    expect(withAgentStale({ id, agent_state: "review" }).critic_approved).toBe(false);
  });
  it("вердикт approved после ухода в review — отмечена; changes_requested и вердикт прошлого круга — нет", () => {
    const a = task(); event(a, "state_changed", "review", "2026-10-07 10:00:00"); event(a, "review_recorded", "1:approved", "2026-10-07 10:05:00");
    expect(withAgentStale({ id: a, agent_state: "review" }).critic_approved).toBe(true);
    expect(withAgentStale({ id: a, agent_state: "in_progress" }).critic_approved).toBe(false);
    const b = task(); event(b, "state_changed", "review", "2026-10-07 10:00:00"); event(b, "review_recorded", "1:changes_requested", "2026-10-07 10:05:00");
    expect(criticApproved(b)).toBe(false);
    const c = task(); event(c, "review_recorded", "1:approved", "2026-10-07 09:00:00"); event(c, "state_changed", "review", "2026-10-07 10:00:00");
    expect(criticApproved(c)).toBe(false);
  });
  it("Критик закрыл свой шаг согласованного плана (после него может идти QA) — отмечена; Критика в плане нет или он вернул — нет", () => {
    const a = task(); planWithLastStep(a, "critic_verifier", "approved: принято");
    expect(criticApproved(a)).toBe(true);
    const b = task(); planWithLastStep(b, "qa", "Проверено");
    expect(criticApproved(b)).toBe(false);
    const c = task(); planWithLastStep(c, "critic_verifier", "changes_requested: дефект");
    expect(criticApproved(c)).toBe(false);
  });
  it("тема задачи закрыта, пока карточка на проверке с одобрением Критика; вернули в работу — открыта", () => {
    const id = task(); event(id, "state_changed", "review", "2026-10-07 10:00:00"); event(id, "review_recorded", "1:approved", "2026-10-07 10:05:00");
    const topic = { task_id: id, room_kind: "task", closed_at: null };
    expect(taskRoomClosedAt(topic)).toBeTruthy();
    expect(taskRoomClosedAt({ ...topic, room_kind: null })).toBeNull();
    db.prepare("UPDATE tasks SET agent_state='in_progress' WHERE id=?").run(id);
    expect(taskRoomClosedAt(topic)).toBeNull();
    expect(taskRoomClosedAt({ ...topic, closed_at: "2026-10-07 12:00:00" })).toBe("2026-10-07 12:00:00");
    const plain = task();
    expect(taskRoomClosedAt({ task_id: plain, room_kind: "task", closed_at: null })).toBeNull();
  });
});
