import { afterAll, beforeAll, expect, it } from "vitest";
import { archiveTask } from "../src/lib/taskArchive.js";
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
// Вопрос владельцу живёт, пока есть куда ответить (31.10.2026). Прецедент:
// вопрос Помощника владельца от 26.10 висел в «Нужен ответ» после закрытия
// чата и удаления карточки «Промтрочка» — сообщение стёрто, отвечать некуда.
const вопросВ = (id: string, chatId: string) =>
    db.prepare("INSERT INTO chat_questions(id,chat_id,role_id,payload_json,status) VALUES (?,?,'role_qa',?,'open')")
        .run(id, chatId, JSON.stringify({ questions: [{ question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }] }));
const комната = (id: string, taskId: string | null, closed = false) => {
    db.prepare("INSERT INTO chats(id,title,kind,created_by,task_id,closed_at) VALUES (?,?,'direct','u1',?,?)")
        .run(id, id, taskId, closed ? "2026-10-26 20:19:30" : null);
    db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES (?,'u1')").run(id);
};

it("hides questions when the chat is closed or archived", async () => {
    комната("closed-chat", null, true);
    вопросВ("q-closed", "closed-chat");
    комната("archived-chat", null);
    db.prepare("UPDATE chats SET archived_at='2026-10-26 20:19:30' WHERE id='archived-chat'").run();
    вопросВ("q-archived", "archived-chat");
    комната("live-chat", null);
    вопросВ("q-live", "live-chat");
    const ids = (await read()).tickets.map((t: any) => t.id);
    expect(ids).not.toContain("question:q-closed");
    expect(ids).not.toContain("question:q-archived");
    expect(ids).toContain("question:q-live");
});

it("hides questions of deleted and archived cards", async () => {
    db.prepare("INSERT INTO tasks(id,title,status,creator_id,archived_at) VALUES ('card-archived','Архивная','active','u1','2026-10-26 20:19:30')").run();
    комната("archived-card-chat", "card-archived");
    вопросВ("q-card-archived", "archived-card-chat");
    // Удалённая карточка: каскад обнуляет chats.task_id, чат остаётся живым.
    комната("deleted-card-chat", null);
    вопросВ("q-card-deleted", "deleted-card-chat");
    db.prepare("UPDATE chats SET task_id=NULL WHERE id='deleted-card-chat'").run();
    const ids = (await read()).tickets.map((t: any) => t.id);
    expect(ids).not.toContain("question:q-card-archived");
    expect(ids).toContain("question:q-card-deleted"); // чат живой — вопрос законный
});

it("cancels open questions when the chat closes or the card goes to archive", async () => {
    комната("closing-chat", null);
    вопросВ("q-closing", "closing-chat");
    const res = await app.inject({
        method: "POST", url: "/api/chats/closing-chat/close",
        headers: { authorization: "Bearer " + app.jwt.sign({ id: "u1" }) }, payload: { closed: true },
    });
    expect(res.statusCode).toBe(200);
    expect((db.prepare("SELECT status FROM chat_questions WHERE id='q-closing'").get() as any).status).toBe("cancelled");

    db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES ('card-to-archive','В архив','active','u1')").run();
    комната("card-chat", "card-to-archive");
    вопросВ("q-card-chat", "card-chat");
    db.prepare("INSERT INTO chat_questions(id,chat_id,role_id,payload_json,status) VALUES ('q-wake','wake:card-to-archive','role_qa',?,'open')")
        .run(JSON.stringify({ questions: [{ question: "Дежурный?", options: [{ label: "Да" }, { label: "Нет" }] }] }));
    archiveTask("card-to-archive", "u1");
    const остались = db.prepare("SELECT id,status FROM chat_questions WHERE id IN ('q-card-chat','q-wake')").all() as Array<{ id: string; status: string }>;
    expect(остались.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
});
it("показывает вопрос без чата и закрывает его ответом по номеру вопроса (владелец 13.11.2026)", async () => {
    const payload = { questions: [{ question: "Выдать права?", header: "Права", options: [{ label: "Да" }, { label: "Нет" }] }] };
    db.prepare("INSERT INTO chat_questions(id,chat_id,role_id,payload_json,status) VALUES ('chatless','','role_qa',?,'open')").run(JSON.stringify(payload));
    expect((await read()).tickets.map((t: any) => t.id)).toContain("question:chatless");
    const res = await app.inject({ method: "POST", url: "/api/questions/chatless/answer", headers: { authorization: "Bearer " + app.jwt.sign({ id: "u1" }) }, payload: { answers: [{ questionIndex: 0, selected: ["Да"] }] } });
    expect(res.statusCode).toBe(200);
    expect((db.prepare("SELECT status FROM chat_questions WHERE id='chatless'").get() as any).status).toBe("answered");
    expect((await read()).tickets.map((t: any) => t.id)).not.toContain("question:chatless");
});
