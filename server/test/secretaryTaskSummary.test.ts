import { beforeAll, describe, expect, it, vi } from "vitest";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { buildApp } from "../src/index.js";
const model=vi.hoisted(()=>({reply:{} as any}));
vi.mock("../src/routes/ai.js",async original=>({...await original<typeof import("../src/routes/ai.js")>(),callUnifiedAi:async()=>JSON.stringify(model.reply)}));
import { collectTaskSummary, summaryClock, summaryPeriods, validateSummaryFilter, requestTaskSummary } from "../src/lib/secretaryTaskSummary.js";
import { deliverSecretaryReply } from "../src/lib/secretaryReply.js";
const base={is_summary:true,assignee_id:null,groups:["all"],from:null,to:null,date_field:"due_date",question:null};
const now=new Date("2026-09-27T12:00:00Z");
describe("единая фактическая сводка Секретаря",()=>{
 beforeAll(async()=>{
  const app=await buildApp();await app.close();
  seedRoleAccounts(db);
  const insert=db.prepare(`INSERT INTO tasks(id,title,creator_id,assignee_id,status,agent_state,due_date,completed_at,blocked_reason,ready_for_pickup) VALUES (?,?, 'u1',?,?,?,?,?,?,1)`);
  insert.run("sum-unassigned","Без роли", null,"active",null,null,null,null);
  insert.run("sum-wait","Назначенная", "role_builder","active",null,"2026-10-01",null,null);
  insert.run("sum-block","Стоп", "role_qa","active","blocked","2026-09-25",null,"Нужен доступ");
  insert.run("sum-review","Проверка", "role_builder","active","review",null,null,null);
  insert.run("sum-done","Готово", "role_builder","completed",null,"2026-09-01","2026-09-26 22:30:00",null);
  db.prepare("UPDATE users SET task_intake_mode='manual' WHERE id='u1'").run();
 });
 it("зависшие включают не взятые и blocked, а review не завершённая",()=>{
  const s=collectTaskSummary("u1",validateSummaryFilter(base),now);
  const section=(name:string)=>s.sections.find(s=>s.group===name)!;
  expect(section("unassigned").tasks.map(t=>t.id)).toContain("sum-unassigned");
  expect(section("assigned_waiting").tasks.map(t=>t.id)).toContain("sum-wait");
  expect(section("blocked").tasks.find(t=>t.id==="sum-block")?.reason).toBe("Нужен доступ");
  expect(section("completed").tasks.map(t=>t.id)).not.toContain("sum-review");
  expect(section("overdue").tasks.map(t=>t.id)).toContain("sum-block");
  expect(section("overdue").tasks.map(t=>t.id)).not.toContain("sum-wait");
  expect(section("future").tasks.map(t=>t.id)).toContain("sum-wait");
 });
 it("фильтрует любую роль и период по сроку",()=>{
  const s=collectTaskSummary("u1",validateSummaryFilter({...base,assignee_id:"role_builder",groups:["stuck"],from:"2026-09-28",to:"2026-10-04"}),now);
  expect(s.sections[0].tasks.map(t=>t.id)).toEqual(["sum-wait"]);
  expect(s.sections[0].tasks[0].reason).toContain("Автоматика выключена");
 });
 it("завершения выбирает по дате завершения в часовом поясе сервера",()=>{
  const s=collectTaskSummary("u1",validateSummaryFilter({...base,groups:["completed"],from:"2026-09-27",to:"2026-09-27",date_field:"completed_at"}),now);
  expect(s.sections[0].tasks.map(t=>t.id)).toContain("sum-done");
 });
 it("общая сводка за период разделяет дату завершения и срок активной задачи",()=>{
  const s=collectTaskSummary("u1",validateSummaryFilter({...base,date_field:"auto",from:"2026-09-27",to:"2026-10-01"}),now);
  expect(s.sections.find(s=>s.group==="completed")!.tasks.map(t=>t.id)).toContain("sum-done");
  expect(s.sections.find(s=>s.group==="assigned_waiting")!.tasks.map(t=>t.id)).toContain("sum-wait");
 });
 it("неделя, месяц и переход года вычисляются на сервере",()=>{
  expect(summaryClock(new Date("2026-09-27T22:00:00Z")).today).toBe("2026-09-28");
  expect(summaryPeriods("2026-09-27").rolling_week).toEqual({from:"2026-09-27",to:"2026-10-03"});
  expect(summaryPeriods("2026-09-27").next_week).toEqual({from:"2026-09-28",to:"2026-10-04"});
  expect(summaryPeriods("2026-12-31").next_month).toEqual({from:"2027-01-01",to:"2027-01-31"});
  expect(summaryPeriods("2026-01-31").rolling_month).toEqual({from:"2026-01-31",to:"2026-02-27"});
 });
 it("не принимает невозможные даты, неизвестную роль и читателя без прав",()=>{
  expect(()=>validateSummaryFilter({...base,from:"2026-02-30"})).toThrow();
  expect(()=>validateSummaryFilter({...base,assignee_id:"invented"})).toThrow();
  expect(()=>collectTaskSummary("role_builder",validateSummaryFilter(base),now)).toThrow();
 });
 it("голосовой запрос без отправки ничего не пишет, по просьбе пишет именно в чат Секретаря",async()=>{
  model.reply={...base,assignee_id:"role_builder",groups:["stuck"]};
  const count=()=> (db.prepare("SELECT count(*) n FROM chat_messages WHERE chat_id='chat-secretary'").get() as any).n;
  const before=count();
  const spoken=await requestTaskSummary("u1","Что зависло у разработчика?");
  expect(spoken).toHaveProperty("message_id",null);expect(count()).toBe(before);
  const sent=await requestTaskSummary("u1","Пришли сводку разработчика",true);
  expect(count()).toBe(before+1);
  expect(db.prepare("SELECT from_user_id,chat_id,text FROM chat_messages WHERE id=?").get((sent as any).message_id)).toMatchObject({from_user_id:"u-secretary",chat_id:"chat-secretary",text:(sent as any).text});
 });
 it("чат использует тот же разбор и фактическую выборку",async()=>{
  model.reply={...base,assignee_id:"role_builder",groups:["stuck"]};
  const id=await deliverSecretaryReply("Какие задачи зависли у разработчика?");
  const row=db.prepare("SELECT text FROM chat_messages WHERE id=?").get(id) as any;
  expect(row.text).toContain("Назначенная");expect(row.text).not.toContain("Стоп — QA");
 });
 it("неоднозначность даёт вопрос без отправки отчёта",async()=>{
  model.reply={...base,question:"Какого исполнителя выбрать?"};
  expect(await requestTaskSummary("u1","Что у него?",true)).toEqual({question:"Какого исполнителя выбрать?"});
 });
 it("относительный период модели заменяется серверным расчётом",async()=>{
  model.reply={...base,period:"next_week",from:"1999-01-01",to:"1999-01-02"};
  const {parseSummaryRequest}=await import("../src/lib/secretaryTaskSummary.js");
  expect(await parseSummaryRequest("На следующую неделю",now)).toMatchObject({from:"2026-09-28",to:"2026-10-04"});
 });
});
