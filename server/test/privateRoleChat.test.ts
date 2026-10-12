import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts,demoteSeededOwner} from "./helpers/seedOwner.js";
describe("Владелец открывает существующий приватный чат роли",()=>{
 let app:Awaited<ReturnType<typeof buildApp>>,auth:Record<string,string>,other:Record<string,string>;
 beforeAll(async()=>{
  app=await buildApp();demoteSeededOwner(db);seedRoleAccounts(db);
  const owner=(await app.inject({method:"POST",url:"/api/auth/register",payload:{name:"Private owner",email:"private-"+Date.now()+"@test",password:"password123"}})).json();
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(owner.user.id);
  auth={authorization:"Bearer "+owner.token};
  other={authorization:"Bearer "+app.jwt.sign({id:"role_builder"})};
 });
 afterAll(async()=>{await app.close();});
 it("переиспользует личную историю независимо от создателя; чужому читателю не видна",async()=>{
  const existing=(await app.inject({method:"POST",url:"/api/chats",headers:auth,payload:{kind:"direct",member_ids:["role_researcher"]}})).json().chat;
  const ownerId=(db.prepare("SELECT member_id FROM chat_members WHERE chat_id=? AND member_id!='role_researcher'").get(existing.id) as any).member_id;
  db.prepare("UPDATE chats SET created_by='role_researcher' WHERE id=?").run(existing.id);
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES('private-history',?,'Сохранённая история','chat',?)").run(ownerId,existing.id);
  const open=()=>app.inject({method:"POST",url:"/api/chats/with-role",headers:auth,payload:{role_id:"role_researcher"}});
  const a=await open(),b=await open();expect(a.statusCode).toBe(200);expect(a.json().chat.id).toBe(existing.id);expect(b.json().chat.id).toBe(existing.id);
  expect((await app.inject({url:"/api/chats/"+existing.id+"/messages",headers:auth})).json().messages.some((m:any)=>m.id==="private-history")).toBe(true);
  expect((await app.inject({url:"/api/chats/"+existing.id,headers:other})).statusCode).toBe(404);
 });
 it("создаёт ровно один реальный direct и отвергает не-роль и инициатора-агента",async()=>{
  const open=()=>app.inject({method:"POST",url:"/api/chats/with-role",headers:auth,payload:{role_id:"role_qa"}});
  const a=await open(),b=await open();expect(a.statusCode).toBe(200);expect(a.json().chat.kind).toBe("direct");expect(b.json().chat.id).toBe(a.json().chat.id);
  expect((await app.inject({method:"POST",url:"/api/chats/with-role",headers:other,payload:{role_id:"role_qa"}})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:"/api/chats/with-role",headers:auth,payload:{role_id:"missing"}})).statusCode).toBe(400);
 });
});
