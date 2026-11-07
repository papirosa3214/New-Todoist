import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from "vitest";
const {start}=vi.hoisted(()=>({start:vi.fn(async()=>({ok:true,runId:"run"}))}));
vi.mock("../src/runtime/planSubtaskAdmission.js",async original=>({...await original<typeof import("../src/runtime/planSubtaskAdmission.js")>(),startPlanSubtaskRun:start}));
import crypto from "node:crypto";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {RESOLUTION_PLAN_BEACON,hasResolutionPlan,slotFromMention,slotLabels} from "../src/lib/slotResolution.js";

const PLAN="Нашла причину.\n\n```plan\n1. Поправить путь\n2. Прогнать тест\n```";

describe("план решения заблокированного слота",()=>{
 let app:any,owner:any,other:any,task:string,chat:string,slotA:string,slotB:string,slotQa:string;
 const auth=(u:any)=>({authorization:`Bearer ${u.token}`});
 const roleMessage=(text:string,subtask:string|null)=>{
  const id=crypto.randomUUID();
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,subtask_id) VALUES(?,'role_builder',?,'chat',?,?,?)").run(id,text,chat,task,subtask);
  return id;
 };
 const press=(id:string,u=owner)=>app.inject({method:"POST",url:`/api/chats/${chat}/messages/${id}/continue-slot`,headers:auth(u)});
 beforeAll(async()=>{
  app=await buildApp();
  seedRoleAccounts(db);
  const reg=async(name:string)=>(await app.inject({method:"POST",url:"/api/auth/register",payload:{name,email:name+"@plan.test",password:"password123"}})).json();
  owner=await reg("plan-owner");other=await reg("plan-other");
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.user.id);
  task=crypto.randomUUID();chat=crypto.randomUUID();
  const plan=crypto.randomUUID();
  slotA=crypto.randomUUID();slotB=crypto.randomUUID();slotQa=crypto.randomUUID();
  db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES(?,'plan task',?)").run(task,owner.user.id);
  db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,profile,status,created_by) VALUES(?,?,1,'delivery','approved',?)").run(plan,task,owner.user.id);
  const node=db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result) VALUES(?,?,?,?,'итог')");
  const step=db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,agent_state) VALUES(?,?,?,?,?,?,?)");
  node.run(crypto.randomUUID(),plan,"b1","builder");step.run(slotA,task,"Первый",0,plan,"b1","blocked");
  node.run(crypto.randomUUID(),plan,"b2","builder");step.run(slotB,task,"Второй",1,plan,"b2",null);
  node.run(crypto.randomUUID(),plan,"q1","qa");step.run(slotQa,task,"Проверка",2,plan,"q1",null);
  db.prepare("INSERT INTO chats(id,kind,created_by,task_id) VALUES(?,'group',?,?)").run(chat,owner.user.id,task);
  for(const id of [owner.user.id,other.user.id,"role_builder"])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,id);
 });
 afterAll(async()=>app?.close());
 beforeEach(()=>{start.mockClear();db.prepare("UPDATE subtasks SET agent_state='blocked' WHERE id=?").run(slotA);});

 it("одинаковые роли получают номера, единственная остаётся без номера",()=>{
  const labels=slotLabels(task);
  const builder=labels.filter(x=>x.role_id==="role_builder").map(x=>x.label);
  expect(builder.length).toBe(2);
  expect(builder[0]).toMatch(/ 1$/);expect(builder[1]).toMatch(/ 2$/);
  expect(labels.find(x=>x.subtask_id===slotQa)?.label).not.toMatch(/\d$/);
 });
 it("адрес берётся из упоминания с номером, без номера слота нет",()=>{
  const second=slotLabels(task).find(x=>x.subtask_id===slotB)!.label;
  const first=slotLabels(task).find(x=>x.subtask_id===slotA)!.label;
  expect(slotFromMention(task,`@${second} проверь`)).toBe(slotB);
  expect(slotFromMention(task,`Смотри, @${first}, тут`)).toBe(slotA);
  expect(slotFromMention(task,"@Кто-то другой")).toBeNull();
 });
 it("ответ роли подписан её номером",async()=>{
  const id=roleMessage("Проверяю",slotB);
  const room=(await app.inject({url:`/api/chats/${chat}/messages`,headers:auth(owner)})).json();
  const list=room.messages??room;
  expect(list.find((m:any)=>m.id===id).from_user_name).toMatch(/ 2$/);
 });
 it("распознаёт блок плана только с содержимым",()=>{
  expect(hasResolutionPlan(PLAN)).toBe(true);
  expect(hasResolutionPlan("```plan\n   \n```")).toBe(false);
  expect(hasResolutionPlan("план: сделать так")).toBe(false);
  expect(RESOLUTION_PLAN_BEACON).toContain("```plan");
 });
 it("кнопка видна только у плана заблокированного слота",async()=>{
  const plan=roleMessage(PLAN,slotA),plain=roleMessage("Просто ответ",slotA),free=roleMessage(PLAN,slotB);
  const room=(await app.inject({url:`/api/chats/${chat}/messages`,headers:auth(owner)})).json();
  const list=room.messages??room;
  const flag=(id:string)=>list.find((m:any)=>m.id===id).slot_resumable;
  expect(flag(plan)).toBe(true);expect(flag(plain)).toBe(false);expect(flag(free)).toBe(false);
 });
 it("«Продолжить» запускает тот же слот и кладёт согласие владельца во входящие",async()=>{
  const id=roleMessage(PLAN,slotA);
  const r=await press(id);
  expect(r.statusCode).toBe(200);
  expect(start).toHaveBeenCalledWith(slotA,owner.user.id,{manualStart:true});
  const queued=db.prepare("SELECT m.text,m.from_user_id FROM slot_topic_inbox i JOIN chat_messages m ON m.id=i.message_id WHERE i.subtask_id=? AND i.delivered_at IS NULL").all(slotA) as any[];
  expect(queued.at(-1)).toMatchObject({from_user_id:owner.user.id});
  expect(queued.at(-1).text).toContain("план");
 });
 it("не запускает без плана, не заблокированный слот и не для чужого",async()=>{
  expect((await press(roleMessage("Просто ответ",slotA))).statusCode).toBe(409);
  expect((await press(roleMessage(PLAN,slotB))).statusCode).toBe(409);
  expect((await press(roleMessage(PLAN,slotA),other)).statusCode).toBe(403);
  expect(start).not.toHaveBeenCalled();
 });
});
