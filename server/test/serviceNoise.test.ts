import {isRoutineServiceComment,isQuietSystemMessage} from "../src/lib/serviceNoise.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import type {FastifyInstance} from "fastify";
let app: FastifyInstance; let token: string; let owner: string;
beforeAll(async () => {
  app = await buildApp();
  owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as {id:string}).id;
  token = app.jwt.sign({id:owner});
  db.prepare("INSERT INTO tasks (id,title,creator_id) VALUES (?,?,?)").run("quiet-task","Quiet",owner);
  db.prepare("INSERT INTO chats (id,title,kind,created_by) VALUES (?,?,'group',?)").run("quiet-chat","Quiet",owner);
  db.prepare("INSERT INTO chat_members (chat_id,member_id) VALUES (?,?)").run("quiet-chat",owner);
  for (const [id,type,text] of [["chat-noise","system","Шаг запущен"],["chat-action","system","Укажите конкретный этап"],["chat-work",null,"Готов результат"]])
    db.prepare("INSERT INTO chat_messages (id,chat_id,from_user_id,text,channel,message_type) VALUES (?,?,?,?,'chat',?)").run(id,"quiet-chat",owner,text,type);
  db.prepare("INSERT INTO chat_messages (id,chat_id,from_user_id,text,channel,message_type,created_at) VALUES (?,?,?,?,'chat','system','2099-01-01')").run("chat-noise-last","quiet-chat",owner,"Шаг завершён");
  for (const [id,user,text] of [["noise",null,"Сторож снял задачу с работы: аренда истекла"],["report",owner,"Работа готова"],["human",owner,"Материал для работы собран. Это мой текст"]])
    db.prepare("INSERT INTO comments (id,task_id,user_id,text) VALUES (?,?,?,?)").run(id,"quiet-task",user,text);
});
afterAll(async()=>{await app?.close();});
describe("quiet user feeds",()=>{
  for (const route of ["/api/tasks/quiet-task/comments","/api/tasks/quiet-task"]) {
    it(`hides service comments and keeps owner text in ${route}`,async()=>{
      const response=await app.inject({method:"GET",url:route,headers:{authorization:`Bearer ${token}`}});
      expect(response.statusCode).toBe(200);
      const body=response.json(); const comments=Array.isArray(body)?body:body.comments;
      expect(comments.map((x:any)=>x.id)).toEqual(["report","human"]);
    });
  }
});

describe("service message policy",()=>{
  it("hides generated restart and context notes but preserves role work",()=>{
    expect(isRoutineServiceComment({user_id:"role_builder",text:"Материал для работы собран. База знаний: 2"})).toBe(true);
    expect(isRoutineServiceComment({user_id:"role_builder",text:"«Реализация»: мой ход оборвался — сервер перезапустился. Продолжаю."})).toBe(true);
    expect(isRoutineServiceComment({user_id:"role_builder",text:"Нужен ваш взгляд: нет доступа"})).toBe(false);
    expect(isRoutineServiceComment({user_id:"role_builder",text:"Работа готова. Проверено 5 тестов."})).toBe(false);
    expect(isRoutineServiceComment({user_id:"human",text:"Материал для работы собран."})).toBe(false);
  });
  it("hides routine system chat events but retains actionable errors",()=>{
    expect(isQuietSystemMessage({kind:"system",text:"Шаг запущен"})).toBe(true);
    expect(isQuietSystemMessage({message_type:"system",text:"Не удалось отправить сообщение"})).toBe(false);
    expect(isQuietSystemMessage({message_type:"system",text:"Укажите конкретный этап"})).toBe(false);
    expect(isQuietSystemMessage({is_session_marker:true,text:"Новая сессия"})).toBe(true);
    expect(isQuietSystemMessage({kind:"text",text:"Ответ роли"})).toBe(false);
  });
});

it("hides system chat chatter while retaining actionable delivery warnings",async()=>{
  const response=await app.inject({method:"GET",url:"/api/chats/quiet-chat/messages",headers:{authorization:`Bearer ${token}`}});
  expect(response.statusCode).toBe(200);
  expect(response.json().messages.map((m:any)=>m.id)).toEqual(["chat-action","chat-work"]);
});

it("does not put a hidden system event in the chat list preview",async()=>{
  const response=await app.inject({method:"GET",url:"/api/chats",headers:{authorization:`Bearer ${token}`}});
  expect(response.statusCode).toBe(200);
  const chat=response.json().chats.find((c:any)=>c.id==="quiet-chat");
  expect(JSON.stringify(chat.last_message)).toContain("Готов результат");
  expect(chat.unread_count).toBe(0);
});

it("keeps coordination cards in history and SQL previews for every lifecycle status", async()=>{
  const {visibleChatSql}=await import("../src/lib/serviceNoise.js");
  for(const status of ["queued","thinking","answered","cancelled","error"]){
    const id=`coord-visible-${status}`;
    const coordination={question_id:id,recipient_id:owner,requester_name:"Разработчик",recipient_name:"Архитектор",question:"Уточни контракт",status,activity:"Ответ получен",created_at:"2026-10-26T00:00:00Z",last_activity_at:"2026-10-26T00:00:01Z",answer:"Контракт согласован",terminal:["answered","cancelled","error"].includes(status)};
    db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel,message_type,steps) VALUES(?,?,?,?,'chat','system',?)").run(id,"quiet-chat",owner,"Разработчик → Архитектор: Ответ получен",JSON.stringify({duration_ms:0,items:[],coordination}));
    try {
      const response=await app.inject({method:"GET",url:"/api/chats/quiet-chat/messages",headers:{authorization:`Bearer ${token}`}});
      const card=response.json().messages.find((m:any)=>m.id===id);
      expect(card?.coordination?.question).toBe("Уточни контракт");
      expect(card?.coordination?.answer).toBe("Контракт согласован");
      expect(db.prepare(`SELECT id FROM chat_messages m WHERE m.id=? AND ${visibleChatSql("m")}`).get(id)).toEqual({id});
      expect(isQuietSystemMessage({kind:"system",text:"Ответ получен",coordination})).toBe(false);
    } finally {db.prepare("DELETE FROM chat_messages WHERE id=?").run(id);}
  }
});

it("does not treat malformed or scalar coordination metadata as a visible card",async()=>{
  const {visibleChatSql}=await import("../src/lib/serviceNoise.js");
  for(const steps of ["{broken", JSON.stringify({coordination:"noise"}), JSON.stringify({coordination:null})]){
    expect(db.prepare(`SELECT ${visibleChatSql("m")} AS visible FROM (SELECT 'system' AS message_type, 'Шаг запущен' AS text, 0 AS is_session_marker, ? AS steps) m`).get(steps)).toEqual({visible:0});
  }
});
