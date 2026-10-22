import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {ensureTaskArtifactFolder} from "../src/lib/taskArtifactFolder.js";
import {formatChatMessage} from "../src/lib/chatMessages.js";
let app:any; let user:string; let chat:string;
beforeAll(async()=>{
 app=await buildApp();
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'!','agent','ai')").run("coordination_agent","Агент","coordination-agent@test.local");
 user="coordination_owner";
 db.prepare("INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,'!','owner')").run(user,"Тест","coordination@test.local");
 chat="coordination_chat";
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES(?,?,'group',?)").run(chat,"Проверка",user);
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,user);
});
afterAll(async()=>{await app?.close();});
it("system account has no agent role or credential",()=>{
 const row=db.prepare("SELECT * FROM users WHERE id='taskflow_system'").get() as any;
 expect(row.name).toBe("Система");expect(row.role_key).toBeNull();expect(row.api_token).toBeNull();
});
it("task link keeps message text and is not a proposal",()=>{
 const m=formatChatMessage({id:"link",text:"Конкретный вопрос",task_id:null,kind:null});
 expect(m.kind).toBeNull();expect(m.text).toBe("Конкретный вопрос");
});
it("proposal kind stays explicit",()=>{
 expect(formatChatMessage({id:"proposal",text:"Предлагаю",kind:"task_proposal"}).kind).toBe("task_proposal");
});
// Правило про длину текста ролей снято целиком (владелец 04.10.2026,
// миграция 099): сервер больше не считает слова и не режет ответы. Проверяем
// обратное — что длинное сообщение роли сохраняется, а не пропадает.
it("long agent message is stored instead of being rejected",()=>{
 const text=Array(300).fill("слово").join(" ");
 const id="coordination_long";
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(id,"coordination_agent",text,chat);
 const row=db.prepare("SELECT length(text) AS n FROM chat_messages WHERE id=?").get(id) as {n:number};
 expect(row.n).toBe(text.length);
});
it("task folder is created once and retained",()=>{
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('coordination_task','Работа',?)").run(user);
 const first=ensureTaskArtifactFolder("coordination_task");
 expect(ensureTaskArtifactFolder("coordination_task")).toBe(first);
 expect((db.prepare("SELECT artifact_folder_id FROM tasks WHERE id='coordination_task'").get() as any).artifact_folder_id).toBe(first);
});

// Сохранённый связанный ответ — единственное подтверждение answered.
import {queueWorkCoordination,registerCoordinationOrigin,markDeliveredToWork,markCoordinationAnswered} from "../src/runtime/chatCoordination.js";
function workQuestion(id:string){
 db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,"coordination_agent");
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(id,user,"Уточнение",chat);
 markDeliveredToWork(id,"coordination_agent",user);
 return ()=>{const row=db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?").get(id) as any;return JSON.parse(row.steps).coordination;};
}
it("завершение запуска без связанного ответа не закрывает обращение",()=>{
 const card=workQuestion("no-linked-answer");
 markCoordinationAnswered("no-linked-answer","coordination_agent");
 expect(card().status).toBe("delivered");expect(card().terminal).toBe(false);
});
it("ответ на другой вопрос не закрывает обращение, связанный закрывает",()=>{
 const card=workQuestion("linked-answer");
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('unrelated',?,'Другой ответ','chat',?)").run("coordination_agent",chat);
 markCoordinationAnswered("linked-answer","coordination_agent");expect(card().terminal).toBe(false);
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES('linked',?,'Вот ответ','chat',?,'linked-answer')").run("coordination_agent",chat);
 markCoordinationAnswered("linked-answer","coordination_agent");expect(card().status).toBe("answered");expect(card().answer).toBe("Вот ответ");
});
it("вопрос коллеги в той же комнате не порождает отдельное обращение",()=>{
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('room-parent',?,'Обсудите','chat',?)").run(user,chat);
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('room-question',?,'@коллега вопрос','chat',?)").run("coordination_agent",chat);
 registerCoordinationOrigin("room-question","room-parent","coordination_agent");
 const row=db.prepare("SELECT steps FROM chat_messages WHERE id='room-question'").get() as any;
 expect(JSON.parse(row.steps??"{}").coordination_origin).toBeUndefined();
});

it("слот принимает уточнение без ложного подтверждения доставки",()=>{
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('work-pending',?,'Уточнение','chat',?)").run(user,chat);
 queueWorkCoordination("work-pending","coordination_agent","coordination_task","step-1");
 const get=()=>JSON.parse((db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='work-pending'").get() as any).steps).coordination;
 expect(get()).toMatchObject({status:"queued",terminal:false,task_id:"coordination_task",subtask_id:"step-1"});
 expect(get().activity).toContain("Работа");
 markDeliveredToWork("work-pending","coordination_agent");expect(get().status).toBe("delivered");
});
it("обращение вне комнаты сохраняет исходный разговор",()=>{
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES('outside','Личный','direct',?)").run(user);
 db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES('outside','coordination_agent')").run();
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('outside-question','coordination_agent','Вопрос','chat','outside')").run();
 registerCoordinationOrigin("outside-question","room-parent","coordination_agent");markDeliveredToWork("outside-question","coordination_agent");
 const card=db.prepare("SELECT chat_id,steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='outside-question'").get() as any;
 expect(card.chat_id).toBe(chat);expect(JSON.parse(card.steps).coordination.status).toBe("delivered");
});
