import * as work from "../src/runtime/inProcessRun.js";
import crypto from "node:crypto";
import {beforeAll, afterAll, it, expect, vi} from "vitest";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {loadChatMessage} from "../src/lib/chatMessages.js";
import {claimMessageDelivery} from "../src/runtime/chatQueue.js";
import {registerChatSteering,offerChatSteering} from "../src/runtime/chatSteering.js";
let app:any, auth:any;
beforeAll(async()=>{app=await buildApp();await app.ready();seedRoleAccounts(db);auth={authorization:`Bearer ${app.jwt.sign({id:"u1"})}`};});
afterAll(async()=>{await app.close();});
function fixture(status?:string){
 const chat=crypto.randomUUID(), message=crypto.randomUUID(), delivery=crypto.randomUUID();
 db.prepare("INSERT INTO chats(id,kind,created_by) VALUES(?,'group','u1')").run(chat);
 for(const user of ["u1","role_builder"])db.prepare("INSERT INTO chat_members(chat_id,member_id) VALUES(?,?)").run(chat,user);
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text) VALUES(?,?,'u1','Передумал')").run(message,chat);
 if(status)db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES(?,?,'role_builder',?,?,1,'{}',?)").run(delivery,chat,delivery,message,status);
 return {chat,message,delivery};
}
const withdraw=(f:ReturnType<typeof fixture>)=>app.inject({method:"POST",url:`/api/chats/${f.chat}/messages/${f.message}/withdraw`,headers:auth});
it("withdraws pending delivery before FIFO can claim it",async()=>{
 const f=fixture("pending");expect(loadChatMessage(f.message).can_withdraw).toBe(true);
 expect((await withdraw(f)).statusCode).toBe(200);
 expect(loadChatMessage(f.message)).toBeNull();expect(claimMessageDelivery(f.delivery)).toBe(false);
});
it("withdraws saved message without delivery",async()=>{expect((await withdraw(fixture())).statusCode).toBe(200);});
for(const status of ["picked","done","failed"])it(`refuses message already started: ${status}`,async()=>{
 const f=fixture(status);if(status==="failed")db.prepare("UPDATE chat_message_queue SET picked_at=datetime('now') WHERE id=?").run(f.delivery);
 expect((await withdraw(f)).statusCode).toBe(409);expect(loadChatMessage(f.message)).toBeTruthy();
});
it("rechecks after client saw pending",async()=>{
 const f=fixture("pending");expect(loadChatMessage(f.message).can_withdraw).toBe(true);claimMessageDelivery(f.delivery);
 expect((await withdraw(f)).statusCode).toBe(409);
});
it("never withdraws another author's message",async()=>{
 const f=fixture();db.prepare("UPDATE chat_messages SET from_user_id='role_builder' WHERE id=?").run(f.message);
 expect((await withdraw(f)).statusCode).toBe(403);
});
it("blocks input reserved for an active SDK run even before receipt",async()=>{
 const f=fixture("pending");let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const steering=registerChatSteering({chatId:f.chat,roleId:"role_builder",steer:async()=>held,outcome:Promise.resolve(true)});
 const offered=offerChatSteering(f.chat,"role_builder",f.message,{from:"owner",chatId:f.chat,chatTitle:"test",body:"hello"});
 try {expect(loadChatMessage(f.message).can_withdraw).toBe(false);expect((await withdraw(f)).statusCode).toBe(409);}
 finally{release();await offered;steering.close();}
});

it("blocks input already reserved by a task run while durable is pending",async()=>{
 const f=fixture("pending");
 const list=vi.spyOn(work,"listActiveInProcessRuns").mockReturnValue([{runId:"test",taskId:"test",role:"builder",subtaskId:undefined,lastActivityAt:0}]);
 const run=vi.spyOn(work,"activeInProcessRun").mockReturnValue({messengerMessages:new Set([f.message])} as any);
 try{expect(loadChatMessage(f.message).can_withdraw).toBe(false);expect((await withdraw(f)).statusCode).toBe(409);}
 finally{list.mockRestore();run.mockRestore();}
});
it("does not let one pending recipient hide an already started recipient",async()=>{
 const f=fixture("pending");
 db.prepare("INSERT INTO chat_message_queue(id,chat_id,role_id,delivery_id,message_id,session_generation,payload_json,status) VALUES(?,?,'role_builder',?,?,1,'{}','done')").run(crypto.randomUUID(),f.chat,crypto.randomUUID(),f.message);
 expect((await withdraw(f)).statusCode).toBe(409);
});
it("refuses users outside the room",async()=>{
 const f=fixture();db.prepare("DELETE FROM chat_members WHERE chat_id=? AND member_id='u1'").run(f.chat);
 expect((await withdraw(f)).statusCode).toBe(404);
});
