import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { startSecretaryVoiceBridge } from "../src/runtime/secretaryVoiceBridge.js";

const model = vi.hoisted(()=>({texts:[] as string[]}));
vi.mock("../src/routes/ai.js",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("../src/routes/ai.js")>();
  return {...actual,structureDictationToCards:async(text:string,_projects:unknown,options:any)=>{
    model.texts.push(text); expect(options.ownerId).toBe("u1");
    return {title:"Проверка общего пути",description:text,result:"",question:null,
      dueDate:"2026-10-01",startTime:"10:00",priority:2,projectId:null,children:[],subtasks:[],where:"личное",labelIds:[]};
  }};
});
const directory = mkdtempSync(join(tmpdir(), "voice-bridge-test-"));
const socket = join(directory, "voice.sock");
function call(body: unknown, path = "/secretary/tasks") {
  return new Promise<{status:number;body:any}>((resolve,reject) => {
    const req = request({socketPath:socket,path,method:"POST",headers:{"content-type":"application/json"}},res=>{
      let data=""; res.on("data",chunk=>data+=chunk);
      res.on("end",()=>resolve({status:res.statusCode!,body:JSON.parse(data)}));
    });
    req.on("error",reject); req.end(JSON.stringify(body));
  });
}
describe("закрытый инструмент голосового Секретаря", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let stop: () => Promise<void>;
  beforeAll(async()=>{
    app=await buildApp();
    db.prepare("UPDATE users SET task_intake_mode='manual' WHERE id='u1'").run();
    stop=await startSecretaryVoiceBridge(app,socket);
  });
  afterAll(async()=>{ if(stop)await stop(); if(app)await app.close(); rmSync(directory,{recursive:true,force:true}); });
  it("создаёт карточку через штатный маршрут без внешнего ключа",async()=>{
    const response=await call({text:"На завтра к десяти, высокий приоритет, назначить на меня",owner_id:"u1",assignee_id:"attacker"});
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({title:"Проверка общего пути",creator_id:"u1",due_date:"2026-10-01",start_time:"10:00",priority:2,assignee_id:"u1",ready_for_pickup:0});
    expect(response.body.task.assignee_id).not.toBe("attacker");
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });
  it("сообщение и звонок используют один разбор с тем же текстом и промптом владельца",async()=>{
    const text="На завтра к десяти, высокий приоритет, назначить на меня";
    const token=app.jwt.sign({id:"u1"});
    const sent=await app.inject({method:"POST",url:"/api/chat",headers:{authorization:`Bearer ${token}`},payload:{text,to_user_id:"all"}});
    expect(sent.statusCode).toBe(200);
    let draft:any;
    for(let i=0;i<100;i++) {
      draft=db.prepare("SELECT status,task_id FROM chat_task_drafts WHERE chat_message_id=?").get(sent.json().id);
      if(draft?.status==="done")break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(draft.status).toBe("done");
    expect(db.prepare("SELECT due_date,start_time,priority,assignee_id FROM tasks WHERE id=?").get(draft.task_id)).toEqual({due_date:"2026-10-01",start_time:"10:00",priority:2,assignee_id:"u1"});
    expect(model.texts.filter(t=>t===text).length).toBeGreaterThanOrEqual(2);
  });
  it("Система ВКЛ не отдаёт явно назначенную владельцу задачу агенту",async()=>{
    db.prepare("UPDATE users SET task_intake_mode='automatic' WHERE id='u1'").run();
    try {
      const response=await call({text:"На меня",owner_id:"u1"});
      expect(response.body.task).toMatchObject({assignee_id:"u1",ready_for_pickup:0});
      expect(response.body.dispatched).toBe(0);
    } finally {db.prepare("UPDATE users SET task_intake_mode='manual' WHERE id='u1'").run();}
  });
  it("не принимает роль вместо владельца",async()=>{
    expect((await call({text:"Недопустимо",owner_id:"role_builder"})).status).toBe(403);
  });
  it("сводка также проверяет владельца и формат отправки",async()=>{
    expect((await call({text:"Сводка",owner_id:"role_builder"},"/secretary/summary")).status).toBe(403);
    expect((await call({text:"Сводка",owner_id:"u1",send_to_chat:"true"},"/secretary/summary")).status).toBe(400);
  });
  it("не открывает доступ к другим инструментам",async()=>{
    expect((await call({owner_id:"u1"},"/api/tasks/delete")).status).toBe(404);
  });
  it("сохраняет валидацию названия существующего API",async()=>{
    expect((await call({text:"",owner_id:"u1"})).status).toBe(400);
  });
});
