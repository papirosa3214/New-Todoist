import {beforeAll,afterAll,it,expect} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
let app:Awaited<ReturnType<typeof buildApp>>;
beforeAll(async()=>{app=await buildApp();});
afterAll(async()=>{await app.close();});
it("новые дубли действий подавлены для владельца, служебные сигналы сохранены",()=>{
 const insert=db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES (?,?,?,?)");
 for(const type of ["reviewed","assigned","commented","agent_state"]){
  insert.run("suppressed-"+type,"u1",type,"Действие");
  expect(db.prepare("SELECT id FROM notifications WHERE id=?").get("suppressed-"+type)).toBeUndefined();
 }
 insert.run("completion-kept","u1","completed","Завершение");
 expect(db.prepare("SELECT id FROM notifications WHERE id='completion-kept'").get()).toBeTruthy();
 insert.run("service-kept","u1","agent_watch","Сбой");
 expect(db.prepare("SELECT id FROM notifications WHERE id='service-kept'").get()).toBeTruthy();
});
it("старые дубли скрыты из API без удаления истории, уведомления исполнителям сохранены",async()=>{
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES ('notify-agent','Agent','notify-agent@test','','agent','ai')").run();
 db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES ('role-assignment','notify-agent','assigned','Поручение')").run();
 expect(db.prepare("SELECT id FROM notifications WHERE id='role-assignment'").get()).toBeTruthy();
 db.exec("DROP TRIGGER notifications_owner_no_activity");
 db.prepare("INSERT INTO notifications(id,user_id,type,text) VALUES ('old-activity','u1','reviewed','Старый вердикт')").run();
 const token=app.jwt.sign({id:"u1"});
 const response=await app.inject({method:"GET",url:"/api/notifications",headers:{authorization:`Bearer ${token}`}});
 expect(response.statusCode).toBe(200);
 expect(response.json().some((n:any)=>n.id==="old-activity")).toBe(false);
 expect(db.prepare("SELECT id FROM notifications WHERE id='old-activity'").get()).toBeTruthy();

});
