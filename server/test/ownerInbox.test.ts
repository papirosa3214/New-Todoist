import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
let app: Awaited<ReturnType<typeof buildApp>>;
const read = async (user = "u1") => (await app.inject({ method: "GET", url: "/api/attention", headers: { authorization: "Bearer " + app.jwt.sign({ id: user }) } })).json();
beforeAll(async () => { app = await buildApp(); seedRoleAccounts(db); db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES ('inbox-chat','Комната','direct','u1')").run(); db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES ('inbox-chat','u1')").run(); });
afterAll(async () => { await app.close(); });
const question = (id: string, status = "open", deadline: string | null = null) => db.prepare("INSERT INTO chat_questions(id,chat_id,role_id,payload_json,status,deadline_at) VALUES (?,'inbox-chat','role_qa',?,?,?)").run(id, JSON.stringify({ questions: [{ question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }] }), status, deadline);
it("shows independent open questions without blocked tasks and removes answered", async () => { question("iq1"); question("iq2"); expect((await read()).tickets).toEqual(expect.arrayContaining([expect.objectContaining({ id: "question:iq1", chat_id: "inbox-chat" }), expect.objectContaining({ id: "question:iq2" })])); db.prepare("UPDATE chat_questions SET status='answered' WHERE id='iq1'").run(); expect((await read()).tickets.map((t: any) => t.id)).not.toContain("question:iq1"); });
it("excludes expired and cancelled questions and protects owner inbox", async () => { question("expired", "open", "2000-01-01"); question("cancelled", "cancelled"); const ids = (await read()).tickets.map((t: any) => t.id); expect(ids).not.toContain("question:expired"); expect(ids).not.toContain("question:cancelled"); expect((await read("role_architect")).tickets).toEqual([]); });
it("shows active clarification regardless of task state, removes resolved", async () => { db.prepare("INSERT INTO tasks(id,title,status,creator_id,needs_clarification,clarification_question) VALUES ('ic','Задача','active','u1',1,'Какой проект?')").run(); expect((await read()).tickets).toContainEqual(expect.objectContaining({ id: "clarification:ic", task_id: "ic" })); db.prepare("UPDATE tasks SET needs_clarification=0 WHERE id='ic'").run(); expect((await read()).tickets.map((t: any) => t.id)).not.toContain("clarification:ic"); });
it("shows owner decision but not ordinary dependency waits", async () => { for (const [id, reason] of [["owner", "Требуется решение владельца"], ["dependency", "Ждёт результат разработчика"]])
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,agent_state,blocked_reason) VALUES (?,?,'active','u1','blocked',?)").run(id, id, reason); expect((await read()).tickets.map((t: any) => t.id)).toContain("decision:owner"); expect((await read()).tickets.map((t: any) => t.id)).not.toContain("decision:dependency"); db.prepare("UPDATE tasks SET agent_state='in_progress' WHERE id='owner'").run(); expect((await read()).tickets.map((t: any) => t.id)).not.toContain("decision:owner"); });
it("keeps pending proposals across version changes and excludes superseded plans", async () => { db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES ('ipt','План','active','u1')").run(); db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,created_by,version) VALUES ('ip','ipt',1,'approved','manual','u1',2)").run(); for (const [id, v] of [["current", 2], ["old", 1]])
    db.prepare("INSERT INTO task_collaboration_plan_ops(id,plan_id,base_version,actor_id,actor_kind,ops_json,status,reason) VALUES (?,'ip',?,'role_qa','role','[]','proposed','Добавить проверку')").run(id, v); expect((await read()).tickets.map((t: any) => t.id)).toContain("plan-op:current"); expect((await read()).tickets.map((t: any) => t.id)).toContain("plan-op:old"); db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE id='ip'").run(); expect((await read()).tickets.map((t: any) => t.id)).not.toContain("plan-op:current"); });
it("keeps unrelated private chats out and hides requests for terminal tasks", async () => {
    db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES ('not-owner-chat','Между ролями','direct','role_qa')").run();
    db.prepare("INSERT INTO chat_questions(id,chat_id,role_id,payload_json,status) VALUES ('hidden','not-owner-chat','role_qa',?,'open')").run(JSON.stringify({ questions: [{ question: "Не владельцу", options: [{ label: "Да" }, { label: "Нет" }] }] }));
    expect((await read()).tickets.map((t: any) => t.id)).not.toContain("question:hidden");
    db.prepare("UPDATE tasks SET needs_clarification=1,status='completed' WHERE id='ic'").run();
    expect((await read()).tickets.map((t: any) => t.id)).not.toContain("clarification:ic");
});
it("shows the latest draft once and removes it on approval", async () => {
    db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES ('draft-task','Новый план','active','u1')").run();
    for (const [id, rev] of [["draft-old", 1], ["draft-latest", 2]])
        db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,created_by) VALUES (?,'draft-task',?,'draft','manual','u1')").run(id, rev);
    const ids = (await read()).tickets.map((t: any) => t.id);
    expect(ids).toContain("plan:draft-latest");
    expect(ids).not.toContain("plan:draft-old");
    db.prepare("UPDATE task_collaboration_plans SET status='approved' WHERE id='draft-latest'").run();
    expect((await read()).tickets.map((t: any) => t.id)).not.toContain("plan:draft-latest");
});
it("captures the current owner-discretion wait but preserves its original age", async () => {
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,agent_state,blocked_reason,created_at,updated_at) VALUES ('discretion','Решение','active','u1','blocked','Оставлено на усмотрение владельца','2026-10-01 00:00:00','2026-10-30 12:00:00')").run();
    db.prepare("INSERT INTO task_events(id,task_id,actor_id,kind,field,to_value,created_at) VALUES ('discretion-event','discretion','role_qa','state_changed','agent_state','blocked','2026-10-29 12:00:00')").run();
    expect((await read()).tickets).toContainEqual(expect.objectContaining({ id: "decision:discretion", created_at: "2026-10-29 12:00:00" }));
});
it("keeps independent step questions alongside a task clarification", async () => {
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,needs_clarification,clarification_question) VALUES ('many','Разные обращения','active','u1',1,'Какой проект?')").run();
    for (const [id, pos] of [["step-one", 1], ["step-two", 2]])
        db.prepare("INSERT INTO subtasks(id,task_id,title,position,agent_state,agent_id,block_type,blocked_at) VALUES (?,'many',?,?,'blocked','role_qa','needs_input','2026-10-28 10:00:00')").run(id, id, pos);
    const ids = (await read()).tickets.map((t: any) => t.id);
    expect(ids).toContain("clarification:many");
    expect(ids).toContain("step:step-one");
    expect(ids).toContain("step:step-two");
});
