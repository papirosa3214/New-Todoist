import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {agentVisibleTextError} from "../src/lib/agentVisibleText.js";
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
it("word limit rejects 101 short words and accepts 100",()=>{
 expect(agentVisibleTextError("coordination_agent",Array(100).fill("а").join(" "))).toBeNull();
 expect(agentVisibleTextError("coordination_agent",Array(101).fill("а").join(" "))).not.toBeNull();
});
it("task folder is created once and retained",()=>{
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('coordination_task','Работа',?)").run(user);
 const first=ensureTaskArtifactFolder("coordination_task");
 expect(ensureTaskArtifactFolder("coordination_task")).toBe(first);
 expect((db.prepare("SELECT artifact_folder_id FROM tasks WHERE id='coordination_task'").get() as any).artifact_folder_id).toBe(first);
});
