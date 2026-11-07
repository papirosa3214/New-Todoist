import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {vi as runtimeVi} from "vitest";
runtimeVi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<any>(),runRoleInProcess:runtimeVi.fn(async()=>({runId:"isolated-contract-test",completion:Promise.resolve()}))}));
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { purgeTasks } from "../src/lib/taskPurge.js";
import { proposeWork } from "../src/runtime/chatWork.js";
import { chatWorkRequests } from "../src/lib/chatWorkRequests.js";

// Владелец 12.10.2026: роль из чата готовит работу одной карточкой с шагами
// по ролям, владелец запускает её привычной кнопкой «Запустить» на карточке,
// дальше шаги добавляются в ту же карточку.
describe("работа по разговору: чат запускает исполнителей", () => {
  let app: FastifyInstance;
  const CHAT = "chat-work-test";
  const owner = () => (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });
  const roles = () => (db.prepare("SELECT key FROM roles WHERE enabled = 1 ORDER BY position LIMIT 2").all() as any[]).map((r) => r.key as string);
  const proposed = () => db.prepare("SELECT id, task_id FROM chat_work_launches WHERE chat_id = ? AND status = 'proposed'").get(CHAT) as any;
  const clean = () => {
    purgeTasks((db.prepare("SELECT DISTINCT task_id FROM chat_work_launches WHERE chat_id = ?").all(CHAT) as any[]).map((r) => r.task_id));
    db.prepare("DELETE FROM chat_work_launches WHERE chat_id = ?").run(CHAT);
  };
  // В тестовой базе учёток ролей нет, а сервер выбирает ответственного за
  // интеграцию среди участников плана — заводим учётки на время теста.
  const madeUsers: string[] = [];
  beforeAll(async () => {
    app = await buildApp();
    seedRoleAccounts(db);
    db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run();
    clean();
    for (const key of roles()) {
      const id = "role_" + key;
      if (db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) continue;
      db.prepare("INSERT INTO users(id, name, email, password_hash, role, type, is_system_bot, role_key) VALUES(?, ?, ?, '!', 'agent', 'ai', 1, ?)").run(id, key, id + "@test", key);
      madeUsers.push(id);
    }
  });
  afterAll(async () => {
    clean();
    for (const id of madeUsers) { try { db.prepare("DELETE FROM users WHERE id = ?").run(id); } catch { /* остались ссылки — не мешает */ } }
    await app.close();
  });

  it("готовит одну карточку с шагами по ролям и черновиком плана; ничего не запускает", async () => {
    const [a, b] = roles();
    const res = await proposeWork(a, CHAT, {
      title: "Проверочная работа из чата",
      steps: [{ key: "first", role: a, result: "Первый результат" }, { key: "second", role: b ?? a, result: "Второй результат", after: ["first"] }],
    });
    expect(res.started).toBe(false);
    const task = db.prepare("SELECT status, parent_id, ready_for_pickup FROM tasks WHERE id = ?").get(res.task_id) as any;
    expect(task).toMatchObject({ status: "active", parent_id: null });
    expect(task.ready_for_pickup ?? 0).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(res.task_id) as any).n).toBe(0);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(res.task_id) as any).status).toBe("draft");
    // Шаги видны на карточке до запуска и ещё никем не взяты.
    const steps = db.prepare("SELECT title, done, agent_state FROM subtasks WHERE task_id = ? ORDER BY position").all(res.task_id) as any[];
    expect(steps.map((s) => s.title)).toEqual([expect.stringContaining("Первый результат"), expect.stringContaining("Второй результат")]);
    expect(steps.every((s) => s.done === 0 && s.agent_state === null)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?").get(res.task_id) as any).n).toBe(0);
  });

  it("повторное предложение снимает прежнее незапущенное вместе с его карточкой", async () => {
    const [a] = roles();
    const before = proposed();
    const res = await proposeWork(a, CHAT, { title: "Вторая версия", steps: [{ key: "only", role: a, result: "Результат" }] });
    expect(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(before.task_id)).toBeUndefined();
    expect((db.prepare("SELECT status FROM chat_work_launches WHERE id = ?").get(before.id) as any).status).toBe("cancelled");
    expect(proposed().task_id).toBe(res.task_id);
  });

  it("некорректные шаги отклоняются и ничего не снимают", async () => {
    const [a] = roles();
    const before = proposed();
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ role: "no_such_role", result: "r" }] })).rejects.toThrow(/нет включённой роли/);
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ role: a, result: " " }] })).rejects.toThrow(/какой результат/);
    await expect(proposeWork(a, CHAT, { title: "x", steps: [{ key: "p", role: a, result: "r", after: ["q"] }, { key: "q", role: a, result: "r", after: ["p"] }] })).rejects.toThrow(/по кругу/);
    expect(proposed()).toEqual(before);
    expect(db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(before.task_id)).toBeTruthy();
  });

  it("кнопка «Запустить» на карточке утверждает план; чужому — отказ", async () => {
    const row = proposed();
    const url = `/api/task-intake/drafts/${row.task_id}/start`;
    const stranger = await app.inject({ method: "POST", url, headers: { authorization: "Bearer " + app.jwt.sign({ id: "no-such-user" }) } });
    expect([401, 403]).toContain(stranger.statusCode);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(row.task_id) as any).status).toBe("draft");

    const res = await app.inject({ method: "POST", url, headers: headers() });
    expect(res.statusCode, res.body).toBe(200);
    expect((db.prepare("SELECT status FROM task_collaboration_plans WHERE task_id = ?").get(row.task_id) as any).status).toBe("approved");
    expect((db.prepare("SELECT status FROM chat_work_launches WHERE id = ?").get(row.id) as any).status).toBe("started");
    // План занял уже показанный шаг, а не завёл второй.
    expect((db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?").get(row.task_id) as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND collaboration_plan_id IS NOT NULL").get(row.task_id) as any).n).toBe(1);
  });

  it("отбивка в чат — только по просьбе владельца и только названному шагу", async () => {
    const [a] = roles();
    const running = db.prepare("SELECT task_id FROM chat_work_launches WHERE chat_id = ? AND status = 'started'").get(CHAT) as any;
    // Запущенная работа без просьб: исполнителю ничего сверх обычного не говорится.
    expect(chatWorkRequests(running.task_id)).toEqual([]);
    await proposeWork(a, CHAT, { steps: [
      { key: "quiet", role: a, result: "Обычный шаг", after: ["only"] },
      { key: "loud", role: a, result: "Шаг с отчётом", after: ["only"], report: "отчёт одним абзацем" },
    ] }, "msg-owner-1");
    const lines = chatWorkRequests(running.task_id);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("слот loud");
    expect(lines[1]).toContain('message_id="msg-owner-1"');
    expect(lines[1]).toContain("отчёт одним абзацем");
    expect(lines.join("\n")).not.toContain("слот quiet");
  });

  it("пока работа идёт, новые шаги добавляются в ту же карточку без кнопки", async () => {
    const [a] = roles();
    const running = db.prepare("SELECT task_id FROM chat_work_launches WHERE chat_id = ? AND status = 'started'").get(CHAT) as any;
    const res = await proposeWork(a, CHAT, { steps: [{ key: "more", role: a, result: "Ещё один результат", after: ["only"] }] });
    expect(res.started).toBe(true);
    expect(res.task_id).toBe(running.task_id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id = n.plan_id WHERE p.task_id = ? AND p.status = 'approved'").get(running.task_id) as any).n).toBe(4);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?").get(running.task_id) as any).n).toBe(0);
  });

it("предложение проверки из чата использует шаблон и ждёт запуска владельцем",async()=>{
 const a=roles()[0];
 db.prepare("INSERT OR IGNORE INTO projects(id,name,owner_id) VALUES('review-project','Проверка',?)").run(owner());
 const response=await proposeWork(a,CHAT,{title:"Проверить готовый документ",project_id:"review-project",profile:"result_review"} as any);
 expect(response.started).toBe(false);
 expect(db.prepare("SELECT profile FROM task_collaboration_plans WHERE id=(SELECT plan_id FROM chat_work_launches WHERE id=?)").get(response.launch_id)).toMatchObject({profile:"result_review"});
 expect(db.prepare("SELECT count(*) n FROM role_run_jobs WHERE task_id=?").get(response.task_id)).toMatchObject({n:0});
});

it("предварительное разрешение владельца запускает проверку без повторной кнопки",async()=>{
 const a=roles()[0];
 db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,'Проверка','direct',?)").run(CHAT,owner());
 for(const member of [owner(),"role_"+a])db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(CHAT,member);
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES('review-permission',?,?,'Если посчитаешь нужным, вызови критика.','chat')").run(CHAT,owner());
 const res=await proposeWork(a,CHAT,{title:"Разовая проверка",project_id:"review-project",profile:"result_review",launch_mode:"authorized",authorization_message_id:"review-permission"} as any,"review-permission");
 expect(res.started).toBe(true);
 expect(db.prepare("SELECT status FROM chat_work_launches WHERE id=?").get(res.launch_id)).toEqual({status:"started"});
});
it("роль не может выдать себе предварительное разрешение",async()=>{
 const a=roles()[0];
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES('fake-permission',?,?,'Вызови критика','chat')").run(CHAT,"role_"+a);
 const before=(db.prepare("SELECT count(*) n FROM tasks").get() as any).n;
 await expect(proposeWork(a,CHAT,{title:"Недопустимый запуск",project_id:"review-project",profile:"result_review",launch_mode:"authorized",authorization_message_id:"fake-permission"} as any)).rejects.toThrow(/владел/);
 expect((db.prepare("SELECT count(*) n FROM tasks").get() as any).n).toBe(before);
});

it("обе разовые проверки доступны ролям через настоящий универсальный шлюз",async()=>{
 const a=roles()[0];
 const source="gateway-review-request";
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,?,?,'Предложи разовую проверку','chat')").run(source,CHAT,owner());
 const catalog=buildRoleToolCatalog({role:a,mode:"work",runId:"review-gateway",chatId:CHAT,messageId:source});
 for(const name of ["taskflow_review_result","taskflow_review_code"]){
  const operation=catalog.operations.find(t=>t.name===name)!;
  expect(operation).toBeTruthy();expect(operation.description).toContain("Любой вердикт");expect(operation.description).toContain("authorized");
 }
 const universal=catalog.customTools.find(t=>t.name==="taskflow")!;
 const result=JSON.parse((await universal.execute("review-call",{action:"invoke",operation:"taskflow_review_result",version:1,request_id:"review-tool-call",arguments:{title:"Проверить готовый результат",description:"Сравнить документ с поручением, не переписывать его.",project_id:"review-project"}}) as any).content[0].text);
 expect(result.ok).toBe(true);
 const data=JSON.parse(result.data.content[0].text);expect(data.started).toBe(false);
 expect(db.prepare("SELECT profile FROM task_collaboration_plans WHERE task_id=? AND status='draft'").get(data.task_id)).toEqual({profile:"result_review"});
});
it.each(["Обсудим команду «вызови критика».","Можешь вызвать критика?", "Я не разрешаю запускать ревью.","Не вызывай критика.","Не нужно подключать критика.","Обсудим, нужен ли критик."])("не выдаёт запрет/обсуждение за предварительное разрешение: %s",async text=>{
 const id="deny-"+Math.random();
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,?,?,?,'chat')").run(id,CHAT,owner(),text);
 await expect(proposeWork(roles()[0],CHAT,{title:"Проверка",project_id:"review-project",profile:"result_review",launch_mode:"authorized",authorization_message_id:id} as any)).rejects.toThrow();
});

it("обычная работа не продолжает карточку разовой проверки",async()=>{
 const review=db.prepare("SELECT l.* FROM chat_work_launches l JOIN task_collaboration_plans p ON p.id=l.plan_id WHERE p.profile='result_review' AND l.status='started' LIMIT 1").get() as any;
 db.prepare("UPDATE chat_work_launches SET created_at='2099-01-01' WHERE id=?").run(review.id);
 const res=await proposeWork(roles()[0],CHAT,{title:"Обычная работа",steps:[{key:"separate",role:roles()[0],result:"Самостоятельный результат"}]});
 expect(res.task_id).not.toBe(review.task_id);
});
it("предложение проверки сохраняет незапущенную обычную работу",async()=>{
 const chat="isolated-review-proposal";
 const ordinary=await proposeWork(roles()[0],chat,{title:"Подготовленная работа",steps:[{role:roles()[0],result:"Результат"}]});
 await proposeWork(roles()[0],chat,{title:"Проверка документа",project_id:"review-project",profile:"result_review"});
 expect(db.prepare("SELECT id FROM tasks WHERE id=?").get(ordinary.task_id)).toBeTruthy();
 expect(db.prepare("SELECT status FROM chat_work_launches WHERE id=?").get(ordinary.launch_id)).toEqual({status:"proposed"});
});

});
