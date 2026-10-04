import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import type { FastifyInstance } from "fastify";

describe("Группы проекта и темы",()=>{
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
 it("одна группа, две изолированные темы; повтор не создаёт дублей",async()=>{
  const g=(await post(`/api/projects/${projectId}/chat`)).json().chat;
  expect((await post(`/api/projects/${projectId}/chat`)).json().chat.id).toBe(g.id);
  const taskIds=[];
  for(const title of ["Первая","Вторая"]){
   const r=await post("/api/tasks",{title,project_id:projectId});expect(r.statusCode).toBe(200);taskIds.push(r.json().task.id);
  }
  const topics=[];
  for(const id of taskIds){
   const r=await post(`/api/tasks/${id}/topic`);expect(r.statusCode).toBe(200);topics.push(r.json().chat);
   expect((await post(`/api/tasks/${id}/topic`)).json().chat.id).toBe(r.json().chat.id);
  }
  expect(topics[0].id).not.toBe(topics[1].id);
  expect(topics[0].parent_chat_id).toBe(g.id);
  const sent=await post(`/api/chats/${topics[0].id}/messages`,{text:"Только первая тема"});expect(sent.statusCode).toBe(200);
  const history=await app.inject({method:"GET",url:`/api/chats/${topics[1].id}/messages`,headers:auth});expect(history.json().messages).toHaveLength(0);
  const list=await app.inject({method:"GET",url:`/api/chats/${g.id}/topics`,headers:auth});expect(list.json().chats).toHaveLength(2);
  const denied=await app.inject({method:"GET",url:`/api/chats/${topics[0].id}/messages`,headers:other});expect(denied.statusCode).toBe(404);
  const rebind=await app.inject({method:"PATCH",url:`/api/chats/${topics[0].id}`,headers:auth,payload:{task_id:taskIds[1]}});expect(rebind.statusCode).toBe(409);
 });
 it("членство темы не заменяет доступ к задаче",async()=>{
  const task=(await post("/api/tasks",{title:"Доступ отозван",project_id:projectId,assignee_id:otherId})).json().task;
  const topic=(await post(`/api/tasks/${task.id}/topic`)).json().chat;
  expect((await post(`/api/chats/${topic.id}/members`,{member_id:otherId})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:`/api/chats/${topic.id}`,headers:other})).statusCode).toBe(200);
  db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(ownerId,task.id);
  expect((await app.inject({method:"GET",url:`/api/chats/${topic.id}`,headers:other})).statusCode).toBe(404);
 });
 it("БД не принимает тему в чужом проекте",async()=>{
  const group=(await post(`/api/projects/${projectId}/chat`)).json().chat;
  const t=(await post("/api/tasks",{title:"Без проекта"})).json().task;
  expect(()=>db.prepare("INSERT INTO chats(id,kind,created_by,project_id,parent_chat_id,task_id) VALUES (?,'group',?,?,?,?)").run("bad-topic",ownerId,projectId,group.id,t.id)).toThrow("invalid project topic");
 });
});
