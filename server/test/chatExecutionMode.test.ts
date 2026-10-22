import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
const {nudge}=vi.hoisted(()=>({nudge:vi.fn(async()=>{})}));
vi.mock("../src/runtime/taskNudge.js",()=>({nudgeTaskPlan:nudge}));
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {chatExecutionMode} from "../src/runtime/chatExecutionMode.js";
import {buildRoleToolCatalog} from "../src/runtime/roleToolCatalog.js";
import {runVoiceTool} from "../src/lib/secretaryVoiceTools.js";
import {registerChatSteering,offerChatSteering} from "../src/runtime/chatSteering.js";

describe("chat/card execution boundary",()=>{
 let app:any,owner:any,other:any,chat:any;
 const auth=(u:any)=>({authorization:`Bearer ${u.token}`});
 beforeAll(async()=>{
  app=await buildApp();
  const reg=async(name:string)=>(await app.inject({method:"POST",url:"/api/auth/register",payload:{name,email:name+"@modes.test",password:"password123"}})).json();
  owner=await reg("mode-owner");other=await reg("mode-other");
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.user.id);
  chat=(await app.inject({method:"POST",url:"/api/chats",headers:auth(owner),payload:{kind:"direct",member_ids:[other.user.id]}})).json().chat;
 });
 afterAll(async()=>app?.close());
 const send=async(text:string)=>(await app.inject({method:"POST",url:`/api/chats/${chat.id}/messages`,headers:auth(owner),payload:{text}})).json().message;
 const mode=(value:any,u=owner)=>app.inject({method:"POST",url:`/api/chats/${chat.id}/execution-mode`,headers:auth(u),payload:{execution_mode:value}});
 const invoke=(tool:any,name:string,id:string)=>tool.execute(id,{action:"invoke",operation:name,version:1,arguments:{},request_id:id}).then((r:any)=>JSON.parse(r.content[0].text));
 it("defaults a standalone room to chat",async()=>{
  const room=(await app.inject({url:`/api/chats/${chat.id}`,headers:auth(owner)})).json().chat;
  expect(room.execution_mode).toBe("chat");
 });
 it("only the owner can persist a valid mode",async()=>{
  expect((await mode("card",other)).statusCode).toBe(403);
  expect((await mode("anything")).statusCode).toBe(400);
  const r=await mode("card");expect(r.statusCode).toBe(200);expect(r.json().chat.execution_mode).toBe("card");
  expect((await mode("chat")).statusCode).toBe(200);
 });
 it("blocks hidden and direct card operations without losing coding/docs/plan tools",async()=>{
  const msg=await send("Исправь код прямо здесь");
  const catalog=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"mode-chat",chatId:chat.id,messageId:msg.id});
  const tool=catalog.customTools[0];
  const found=JSON.parse((await tool.execute("find",{action:"discover",query:""})).content[0].text);
  const names=found.data.operations.map((x:any)=>x.operation);
  for(const name of ["taskflow_create_task","taskflow_work_start","taskflow_subtask_add","taskflow_claim","taskflow_plan_request"]){
   const targeted=JSON.parse((await tool.execute("find-"+name,{action:"discover",query:name,limit:20})).content[0].text);
   expect(targeted.data.operations.map((x:any)=>x.operation)).not.toContain(name);
   expect(names).not.toContain(name);
   expect((await invoke(tool,name,"deny-"+name)).error.code).toBe("EXECUTION_MODE_RESTRICTED");
  }
  for(const name of ["taskflow_doc_write","taskflow_work_plan","taskflow_host_bash"])
   expect(catalog.customTools.map(t=>t.name)).toContain(name);
 });
 it("snapshots accepted messages so later switching does not change their permissions",async()=>{
  await mode("chat");const online=await send("Работай в чате");
  await mode("card");const card=await send("Оформи работу по карточке");
  const make=(m:any)=>buildRoleToolCatalog({role:"secretary",mode:"work",runId:m.id,chatId:chat.id,messageId:m.id});
  expect(make(online).customTools.map(t=>t.name)).not.toContain("taskflow_create_task");
  expect(make(card).customTools.map(t=>t.name)).toContain("taskflow_create_task");
  expect(make(card).context.executionMode).toBe("card");
  await mode("chat");
  expect(make(card).context.executionMode).toBe("card");
 });
 it("does not wake a card plan for online work in a task topic",async()=>{
  const task=crypto.randomUUID(),topic=crypto.randomUUID();
  const project=crypto.randomUUID(),parent=crypto.randomUUID();
  db.prepare("INSERT INTO projects(id,name,owner_id) VALUES(?,?,?)").run(project,"Mode project",owner.user.id);
  db.prepare("INSERT INTO tasks(id,title,creator_id,project_id) VALUES(?,?,?,?)").run(task,"mode task",owner.user.id,project);
  db.prepare("INSERT INTO chats(id,kind,created_by,project_id) VALUES(?,'group',?,?)").run(parent,owner.user.id,project);
  db.prepare("INSERT INTO chats(id,kind,created_by,task_id,parent_chat_id,project_id) VALUES(?,'group',?,?,?,?)").run(topic,owner.user.id,task,parent,project);
  for(const id of [owner.user.id,other.user.id])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(topic,id);
  nudge.mockClear();
  const r=await app.inject({method:"POST",url:`/api/chats/${topic}/messages`,headers:auth(owner),payload:{text:"Работай здесь",execution_mode:"chat"}});
  expect(r.statusCode).toBe(200);expect(nudge).not.toHaveBeenCalled();
 });
 it("inherits online mode across a role reply after the owner switches the room",async()=>{
  const source=await send("Сделай прямо здесь");
  await mode("card");
  const secretary="u-secretary";
  db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat.id,secretary);
  const token=app.jwt.sign({id:secretary});
  const result=await app.inject({method:"POST",url:`/api/chats/${chat.id}/messages`,headers:{authorization:`Bearer ${token}`},payload:{text:"Уточнение",reply_to_message_id:source.id}});
  expect(result.statusCode).toBe(200);
  expect(chatExecutionMode(chat.id,result.json().message.id)).toBe("chat");
  await mode("chat");
 });
 it("uses the same restriction through the real voice gateway",async()=>{
  const msg=await send("Сделай это здесь голосом");
  const result=await runVoiceTool(owner.user.id,"taskflow",{operation:"taskflow_create_task",arguments:{}},{chatId:chat.id,messageId:msg.id});
  expect(JSON.parse(result.result).error.code).toBe("EXECUTION_MODE_RESTRICTED");
 });
 it("allows an explicit owner handoff for one message and preserves the room selection",async()=>{
  await mode("chat");const msg=await send("Оформить как карточку");
  expect(chatExecutionMode(chat.id,msg.id)).toBe("card");expect(chatExecutionMode(chat.id)).toBe("chat");
  const ordinary=await send("Не создавай карточку, выполни здесь");
  expect(chatExecutionMode(chat.id,ordinary.id)).toBe("chat");
 });
 it("does not let a role select card mode in a message",async()=>{
  const token=app.jwt.sign({id:"u-secretary"});
  const r=await app.inject({method:"POST",url:`/api/chats/${chat.id}/messages`,headers:{authorization:`Bearer ${token}`},payload:{text:"Выбираю карточку",execution_mode:"card"}});
  expect(r.statusCode).toBe(403);
  const selected=await mode("card",{token});expect(selected.statusCode).toBe(403);
 });
 it("planning remains read-only even with card execution selected",async()=>{
  await mode("card");const msg=await send("Сначала только план");
  const catalog=buildRoleToolCatalog({role:"secretary",mode:"plan",runId:"mode-plan-card",chatId:chat.id,messageId:msg.id});
  expect((await invoke(catalog.customTools[0],"taskflow_create_task","plan-card-deny")).error.code).toBe("MODE_RESTRICTED");
  await mode("chat");
 });
 it("does not steer a card request into an online run",async()=>{
  let steered=false;
  const turn=registerChatSteering({chatId:"mode-chat",roleId:"mode-role",executionMode:"chat",steer:async()=>{steered=true;},outcome:Promise.resolve(true)} as any);
  try {
   expect(await offerChatSteering("mode-chat","mode-role","m-card",{from:"owner",chatId:"mode-chat",chatTitle:"room",body:"card",executionMode:"card"} as any)).toBeNull();
   expect(steered).toBe(false);
  }finally{turn.close();}
 });
});
