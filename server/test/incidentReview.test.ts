// Поломка, одобренная Критиком, закрывается сама и не шлёт владельцу вердикт
// (владелец 14.10.2026: «такие задачи могут сами закрывать, видеть не хочу»).
import { afterAll, beforeAll, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts, demoteSeededOwner } from "./helpers/seedOwner.js";
import { finishCompletedPlans } from "../src/runtime/planSubtaskAdmission.js";
import { createResultVersion } from "../src/resultVersions.js";

let app: any, owner: string, critic: string;
beforeAll(async () => {
  app = await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db);
  owner = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')").run(owner, owner + "@test");
  db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run();
  critic = `Bearer ${app.jwt.sign({ id: "role_critic_verifier" })}`;
});
afterAll(async () => app.close());

function fixture(incident: boolean) {
  const id = crypto.randomUUID(), plan = "p_" + id;
  db.prepare("INSERT INTO tasks(id,title,creator_id,agent_state,incident_key,service_hidden) VALUES (?,'Починка',?,'review',?,?)").run(id, owner, incident ? "test-" + id : null, incident ? 1 : 0);
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,profile,status,rationale,revision,created_by) VALUES (?,?,'single_executor','approved','test',1,?)").run(plan, id, owner);
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result) VALUES (?,?,'fix','infra_engineer','Починить')").run("n_" + id, plan);
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result,instructions) VALUES (?,?,'final_review_x','critic_verifier','Итоговая проверка результата','[taskflow:final-review]')").run("r_" + id, plan);
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,result) VALUES (?,?,'Починить',1,?,'fix',1,'done')").run(crypto.randomUUID(), id, plan);
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,done,agent_id) VALUES (?,?,'Итоговая проверка результата',2,?,'final_review_x',0,'role_critic_verifier')").run(crypto.randomUUID(), id, plan);
  const v = createResultVersion({ taskId: id, createdBy: "role_infra_engineer", result: "Починено: сервис отвечает" });
  return { id, v };
}
const report = "## Результат\n\nПочинено.\n\n## Что сделано\n\nПроверил.\n\n## Проверки\n\nСервис отвечает.\n\n## Ограничения\n\nНет.\n\n## Материалы\n\nЖурнал.";
async function approve(f: { id: string; v: any }) {
  return app.inject({ method: "POST", url: "/api/reviews", headers: { authorization: critic }, payload: {
    task_id: f.id, version_id: f.v.id, artifact_hash: f.v.artifact_hash, criteria_version: "1", task_revision: f.v.task_revision,
    verdict: "approved", findings: "Проверил: работает", report_markdown: report } });
}

it("поломка после одобрения Критиком закрыта, уведомления владельцу нет", async () => {
  const f = fixture(true);
  const res = await approve(f);
  expect(res.statusCode, res.body).toBe(201);
  expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(f.id) as any).status).toBe("completed");
  expect((db.prepare("SELECT count(*) n FROM notifications WHERE task_id=? AND type='reviewed'").get(f.id) as any).n).toBe(0);
});

it("обычная задача после одобрения остаётся владельцу", async () => {
  const f = fixture(false);
  const res = await approve(f);
  expect(res.statusCode, res.body).toBe(201);
  expect((db.prepare("SELECT status FROM tasks WHERE id=?").get(f.id) as any).status).toBe("active");
});

it("восстанавливает старую сданную поломку без проверяющего ровно один раз", () => {
  const f = fixture(true);
  const plan = (db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=?").get(f.id) as any).id;
  db.prepare("DELETE FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='final_review_x'").run(plan);
  db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key='final_review_x'").run(plan);
  finishCompletedPlans();
  expect(db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=? AND reason='review'").get(f.id)).toEqual({n:1});
  expect(db.prepare("SELECT COUNT(*) n FROM subtasks WHERE task_id=? AND done=0").get(f.id)).toEqual({n:1});
  finishCompletedPlans();
  expect(db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=? AND reason='review'").get(f.id)).toEqual({n:1});
  expect(db.prepare("SELECT status FROM tasks WHERE id=?").get(f.id)).toEqual({status:'active'});
});

it("не запускает проверку обычной сданной задачи и незаконченной поломки", () => {
  const normal = fixture(false), unfinished = fixture(true);
  for (const f of [normal, unfinished]) {
    const plan = (db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=?").get(f.id) as any).id;
    db.prepare("DELETE FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key='final_review_x'").run(plan);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id=? AND slot_key='final_review_x'").run(plan);
  }
  db.prepare("UPDATE subtasks SET done=0 WHERE task_id=?").run(unfinished.id);
  finishCompletedPlans();
  for (const f of [normal, unfinished])
    expect(db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=?").get(f.id)).toEqual({n:0});
});
