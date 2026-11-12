// Комнаты задач (владелец 08.11.2026): одна на задачу, независимо от проекта,
// топиком в личной комнате каждой роли-участника. Проект — папка владельца, а
// не чат: проектных чатов больше не существует
// (docs/2026-11-08-role-slot-chat-branches-spec.md §1–3).
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import type { FastifyInstance } from "fastify";

describe("Комнаты задач: одна на задачу, независимо от проекта",()=>{
 let app:FastifyInstance, auth:any, other:any, otherId:string, ownerId:string, projectId:string;
 beforeAll(async()=>{
  app=await buildApp();
  for (const name of ["TopicOwner","TopicOther"]) {
   const r=await app.inject({method:"POST",url:"/api/auth/register",payload:{name,email:`${name}-${Date.now()}@test`,password:"password123"}});
   const body=r.json(); const headers={authorization:`Bearer ${body.token}`};
   if(name==="TopicOwner"){auth=headers;ownerId=body.user.id;db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);}else {other=headers;otherId=body.user.id;}
  }
  const p=await app.inject({method:"POST",url:"/api/projects",headers:auth,payload:{name:"Темы проекта"}});
  projectId=p.json().id;
 });
 afterAll(async()=>{await app.close();});
 const post=(url:string,payload:any={})=>app.inject({method:"POST",url,headers:auth,payload});
 it("у проекта своего чата нет; у каждой задачи своя комната",async()=>{
  // Проектных чатов не существует: адрес прежней проектной группы отвечает 404.
  expect((await post(`/api/projects/${projectId}/chat`)).statusCode).toBe(404);
  const taskIds=[];
  for(const title of ["Первая","Вторая"]){
   const r=await post("/api/tasks",{title,project_id:projectId});expect(r.statusCode).toBe(200);taskIds.push(r.json().task.id);
  }
  const rooms=[];
  for(const id of taskIds){
   const r=await post(`/api/tasks/${id}/topic`);expect(r.statusCode).toBe(200);rooms.push(r.json().chat);
   expect((await post(`/api/tasks/${id}/topic`)).json().chat.id).toBe(r.json().chat.id);
  }
  expect(rooms[0].id).not.toBe(rooms[1].id);
  // Комната задачи самостоятельна: ни проекта, ни родителя.
  expect(rooms[0].room_kind).toBe("task");
  expect(rooms[0].parent_chat_id ?? null).toBeNull();
  expect(rooms[0].project_id ?? null).toBeNull();
  const projectChats=db.prepare("SELECT COUNT(*) AS n FROM chats WHERE project_id IS NOT NULL").get() as {n:number};
  expect(projectChats.n).toBe(0);
 });
 it("переписка одной комнаты не попадает в другую; чужой её не читает",async()=>{
  const tasks=[];
  for(const title of ["Тихая","Гулкая"]){
   tasks.push((await post("/api/tasks",{title})).json().task.id);
  }
  const rooms=[];
  for(const id of tasks) rooms.push((await post(`/api/tasks/${id}/topic`)).json().chat);
  const sent=await post(`/api/chats/${rooms[0].id}/messages`,{text:"Только первая комната"});expect(sent.statusCode).toBe(200);
  const history=await app.inject({method:"GET",url:`/api/chats/${rooms[1].id}/messages`,headers:auth});expect(history.json().messages).toHaveLength(0);
  const denied=await app.inject({method:"GET",url:`/api/chats/${rooms[0].id}/messages`,headers:other});expect(denied.statusCode).toBe(404);
  const rebind=await app.inject({method:"PATCH",url:`/api/chats/${rooms[0].id}`,headers:auth,payload:{task_id:tasks[1]}});expect(rebind.statusCode).toBe(409);
 });
 it("членство в комнате не заменяет доступ к задаче",async()=>{
  const task=(await post("/api/tasks",{title:"Доступ отозван",assignee_id:otherId})).json().task;
  const room=(await post(`/api/tasks/${task.id}/topic`)).json().chat;
  expect((await post(`/api/chats/${room.id}/members`,{member_id:otherId})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:`/api/chats/${room.id}`,headers:other})).statusCode).toBe(200);
  db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(ownerId,task.id);
  db.prepare("DELETE FROM chat_members WHERE chat_id=? AND member_id=?").run(room.id,otherId);
  expect((await app.inject({method:"GET",url:`/api/chats/${room.id}`,headers:other})).statusCode).toBe(404);
 });
 it("задача без проекта получает комнату на общих основаниях",async()=>{
  const task=(await post("/api/tasks",{title:"Совсем без папки"})).json().task;
  const room=(await post(`/api/tasks/${task.id}/topic`)).json().chat;
  expect(room.room_kind).toBe("task");
  expect(room.project_id ?? null).toBeNull();
  const row=db.prepare("SELECT room_kind, project_id, parent_chat_id FROM chats WHERE id=?").get(room.id) as {
   room_kind:string; project_id:string|null; parent_chat_id:string|null;
  };
  expect(row.room_kind).toBe("task");
  expect(row.project_id).toBeNull();
  expect(row.parent_chat_id).toBeNull();
 });
});
