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
import {queueWorkCoordination,registerCoordinationOrigin,registerCrossSessionOrigin,markDeliveredToWork,markCoordinationAnswered,ensureCoordinationCard} from "../src/runtime/chatCoordination.js";
// Вопрос владельца уходит роли В ДРУГУЮ комнату — сообщение пересекает
// сессии, поэтому карточка обращения заводится (правило владельца
// 29.10.2026: карточка — только для пересечения сессий).
const ROOM="coordination_room";
function ensureRoom(){
 db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,'Комната роли','direct',?)").run(ROOM,user);
 db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(ROOM,"coordination_agent");
}
function workQuestion(id:string){
 ensureRoom();
 db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,"coordination_agent");
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(id,user,"Уточнение",chat);
 // Исток: вопрос пришёл из сессии отправителя; работа — в другой.
 registerCrossSessionOrigin(id,chat,user);
 ensureCoordinationCard(id,"coordination_agent",ROOM);
 markDeliveredToWork(id,"coordination_agent",user);
 return ()=>{const row=db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?").get(id) as any;return row?JSON.parse(row.steps).coordination:undefined;};
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
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES('linked',?,'Вот ответ','chat',?,?)").run("coordination_agent",chat,"linked-answer");
 markCoordinationAnswered("linked-answer","coordination_agent");expect(card().status).toBe("answered");
 // Текст ответа в карточку НЕ копируется: ответ лежит в этой же нитке,
 // копия была вторым дублем (владелец 29.10.2026, скриншот чата).
 expect(card().answer).toBeUndefined();
 expect(card().activity).toBe("Ответ получен");
});
it("ответ в нитке не дублируется текстом в карточке",()=>{
 // Сценарий владельца (29.10.2026): он спросил роль в общем чате, вопрос ушёл
 // в работу, карточка завелась — и ответ показался ДВАЖДЫ: текстом в карточке
 // и сообщением в нитке. Карточка — статус, а не копия ответа.
 const card=workQuestion("dup-question");
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES('dup-answer',?,'Ответ роли','chat',?,?)").run("coordination_agent",chat,"dup-question");
 markCoordinationAnswered("dup-question","coordination_agent");
 expect(card().status).toBe("answered");
 expect(card().terminal).toBe(true);
 expect(card().answer??"").toBe("");
});
it("вопрос коллеги в той же комнате не порождает отдельное обращение",()=>{
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('room-parent',?,'Обсудите','chat',?)").run(user,chat);
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('room-question',?,'@коллега вопрос','chat',?)").run("coordination_agent",chat);
 registerCoordinationOrigin("room-question","room-parent","coordination_agent");
 const row=db.prepare("SELECT steps FROM chat_messages WHERE id='room-question'").get() as any;
 expect(JSON.parse(row.steps??"{}").coordination_origin).toBeUndefined();
});

it("внутри одной сессии карточка заводится только когда вопрос уходит в работу роли",()=>{
 // Правило владельца (29.10.2026): карточка — только когда сообщение
 // пересекает сессии.
 //
 // 1. Разговор в комнате: вопрос и ответ в одной нитке — карточки нет
 //    (видно и так, кому написан вопрос).
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('same-room',?,'Обсуждение','chat',?)").run(user,chat);
 markDeliveredToWork("same-room","coordination_agent");
 const plain=db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='same-room'").get() as any;
 expect(plain).toBeUndefined();
 // 2. Вопрос уходит в рабочую сессию роли — сессии разные: карточка в
 //    комнате вопроса («кто кому», статус, остановить). Поведение main,
 //    на нём держится карточка занятой роли (inProcessRun).
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('work-pending',?,'Уточнение','chat',?)").run(user,chat);
 queueWorkCoordination("work-pending","coordination_agent","coordination_task","step-1");
 const row=db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='work-pending'").get() as any;
 expect(row).toBeTruthy();
 expect(JSON.parse(row.steps).coordination.status).toBe("queued");
 markDeliveredToWork("work-pending","coordination_agent");
 const after=db.prepare("SELECT steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='work-pending'").get() as any;
 expect(JSON.parse(after.steps).coordination.status).toBe("delivered");
});
it("пересечение сессий: карточка заводится и указывает на комнату доставки",()=>{
 const card=workQuestion("cross-question");
 expect(card()).toBeTruthy();
 expect(card().child_chat_id).toBe(ROOM);
 expect(card().requester_name).toBe("Тест");
 expect(card().recipient_id).toBe("coordination_agent");
});
it("вопрос из одной комнаты, работа в другой: карточка в комнате вопроса",()=>{
 // Реальный поток (владелец 29.10.2026): вопрос остаётся в комнате
 // отправителя, работа идёт в комнате получателя — сообщение пересекает
 // сессии, поэтому карточка заводится в комнате вопроса, а child_chat_id
 // указывает на комнату доставки (там останавливается ход роли).
 db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES('outside','Личный','direct',?)").run(user);
 db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES('outside','coordination_agent')").run();
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('outside-question',?,'Вопрос','chat',?)").run(user,chat);
 registerCrossSessionOrigin("outside-question",chat,user);
 ensureCoordinationCard("outside-question","coordination_agent","outside");
 markDeliveredToWork("outside-question","coordination_agent");
 const card=db.prepare("SELECT chat_id,steps FROM chat_messages WHERE json_valid(steps) AND json_extract(steps,'$.coordination.question_id')='outside-question'").get() as any;
 expect(card.chat_id).toBe(chat);
 expect(JSON.parse(card.steps).coordination.status).toBe("delivered");
 expect(JSON.parse(card.steps).coordination.child_chat_id).toBe("outside");
});
