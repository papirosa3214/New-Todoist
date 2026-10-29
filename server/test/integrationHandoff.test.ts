import {beforeAll, afterAll, it, expect, vi} from "vitest";
import crypto from "node:crypto";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import {seedRoleAccounts, demoteSeededOwner} from "./helpers/seedOwner.js";
import {createResultVersion} from "../src/resultVersions.js";
import {enqueueIntegrationHandoff, integrationHandoffContext} from "../src/runtime/integrationHandoff.js";
vi.mock("../src/runtime/PiRuntimeAdapter.js",async original=>({...await original<any>(),startChatRun:vi.fn(async()=>({sessionId:null,text:"Передача принята; ожидаю безопасную очередь."}))}));
vi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<any>(),deliverChatToWork:vi.fn(async()=>"idle")}));
import {deliverChatToWork} from "../src/runtime/inProcessRun.js";
import {startChatRun} from "../src/runtime/PiRuntimeAdapter.js";
import {recoverAgentDelivery} from "../src/routes/chats.js";
import {enqueueMessageDelivery} from "../src/runtime/chatQueue.js";
let app:any, owner:string;
beforeAll(async()=> {
 app=await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db);
 owner=crypto.randomUUID();
 db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES (?,'Owner',?,'!','owner','human')").run(owner,owner+"@test");
});
afterAll(async()=>app.close());
function fixture(mode="manual",parent:string|null=null,verdict="approved"){
 const id=crypto.randomUUID(), plan="p_"+id;
 db.prepare("INSERT INTO tasks(id,title,creator_id,integration_mode,integration_owner_id,parent_id) VALUES (?,'Accepted code',?,?,'role_builder',?)").run(id,owner,mode,parent);
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,profile,status,rationale,revision,created_by) VALUES (?,?,'manual','approved','test',1,?)").run(plan,id,owner);
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,expected_result) VALUES (?,?,'build','builder','Code')").run("n_"+id,plan);
 const v=createResultVersion({taskId:id,createdBy:"role_builder",result:"Commit abc123; checks passed"});
 const review=crypto.randomUUID();
 db.prepare("INSERT INTO reviews(id,task_id,version_id,task_revision,reviewer_id,artifact_hash,criteria_version,verdict,findings) VALUES (?,?,?,?,'role_critic_verifier',?,1,?,'Checked')").run(review,id,v.id,v.task_revision,v.artifact_hash,verdict);
 return {id,review,v};
}
it("accepted root writes one persistent addressed work message and delivery, no new slots",()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review);
 expect(a).not.toBeNull();
 const q=db.prepare("SELECT * FROM chat_message_queue WHERE id=?").get(a!.queueRowId) as any;
 expect(q.role_id).toBe("role_builder");expect(q.status).toBe("pending");
 expect(integrationHandoffContext(a!.messageId,"role_builder")).toContain("main");
 expect(integrationHandoffContext(a!.messageId,"role_builder")).toContain(f.v.id);
 expect((db.prepare("SELECT count(*) n FROM subtasks WHERE task_id=?").get(f.id) as any).n).toBe(0);
 const b=enqueueIntegrationHandoff(f.review);
 expect(b!.queueRowId).toBe(a!.queueRowId);
 expect((db.prepare("SELECT count(*) n FROM chat_messages WHERE id=?").get(a!.messageId) as any).n).toBe(1);
});
it("does not send non-approved, not-required, child or archived work",()=>{
 expect(enqueueIntegrationHandoff(fixture("manual",null,"changes_requested").review)).toBeNull();
 expect(enqueueIntegrationHandoff(fixture("not_required").review)).toBeNull();
 const root=fixture();expect(enqueueIntegrationHandoff(fixture("manual",root.id).review)).toBeNull();
 const f=fixture();db.prepare("UPDATE tasks SET archived_at=datetime('now') WHERE id=?").run(f.id);
 expect(enqueueIntegrationHandoff(f.review)).toBeNull();
});
it("revalidates current version and recipient before execution; ordinary messages are never work authorizations",()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 expect(integrationHandoffContext(a.messageId,"role_researcher")).toBeNull();
 expect(integrationHandoffContext("ordinary","role_builder")).toBeNull();
 createResultVersion({taskId:f.id,createdBy:"role_builder",result:"New unreviewed changes"});
 expect(integrationHandoffContext(a.messageId,"role_builder")).toBeNull();
});
it("outbox insertion rolls back with review transaction",()=>{
 const f=fixture();
 expect(()=>db.transaction(()=>{enqueueIntegrationHandoff(f.review);throw Error("rollback");})()).toThrow("rollback");
 expect(db.prepare("SELECT id FROM chat_messages WHERE id=?").get("integration-review:"+f.review)).toBeUndefined();
});

it("idle integrator gets a work continuation, while ordinary colleague messages stay discussion",async()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 vi.mocked(startChatRun).mockClear();
 const result=await recoverAgentDelivery(a);
 expect(result.status).toBe("done");
 expect(vi.mocked(startChatRun).mock.calls.at(-1)![0]).toMatchObject({mode:"work",role:"builder"});
 expect(vi.mocked(startChatRun).mock.calls.at(-1)![0].prompt).toContain("СЕРВЕРНАЯ ПЕРЕДАЧА");
 const id=crypto.randomUUID();
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,work_mode) VALUES (?,'role_critic_verifier','Hello','chat',?,?,'work')").run(id,a.chatId,f.id);
 const q=enqueueMessageDelivery({chatId:a.chatId,roleId:a.roleId,deliveryId:id,messageId:id,payload:{mode:"work"}});
 await recoverAgentDelivery({chatId:a.chatId,roleId:a.roleId,queueRowId:q.id});
 expect(vi.mocked(startChatRun).mock.calls.at(-1)![0].mode).toBe("discussion");
});
it("review API commits handoff with accepted version",async()=>{
 const f=fixture();
 db.prepare("DELETE FROM reviews WHERE id=?").run(f.review);
 db.prepare("UPDATE task_collaboration_plans SET status='draft' WHERE task_id=?").run(f.id);
 const response=await app.inject({method:"POST",url:"/api/reviews",headers:{authorization:"Bearer "+app.jwt.sign({id:owner})},
 payload:{task_id:f.id,version_id:f.v.id,artifact_hash:f.v.artifact_hash,task_revision:f.v.task_revision,criteria_version:"1",verdict:"approved",findings:"Checked"}});
 expect(response.statusCode,response.body).toBe(201);
 const receipt=response.json();
 expect(db.prepare("SELECT id FROM chat_messages WHERE id=?").get("integration-review:"+receipt.review_id)).toBeDefined();
});
it("concurrent recovery of the same receipt starts only one continuation",async()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 vi.mocked(startChatRun).mockClear();
 await Promise.all([recoverAgentDelivery(a),recoverAgentDelivery(a)]);
 expect(vi.mocked(startChatRun).mock.calls.filter(c=>c[0].messageId===a.messageId)).toHaveLength(1);
});

it("occupied integrator receives the receipt in existing work without another model run",async()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 vi.mocked(startChatRun).mockClear();
 vi.mocked(deliverChatToWork).mockResolvedValueOnce("queued");
 const result=await recoverAgentDelivery(a);
 expect(result.status).toBe("skipped");
 expect(startChatRun).not.toHaveBeenCalled();
 expect(vi.mocked(deliverChatToWork).mock.calls.at(-1)![3]).toContain("СЕРВЕРНАЯ ПЕРЕДАЧА");
 expect((db.prepare("SELECT status FROM chat_message_queue WHERE id=?").get(a.queueRowId) as any).status).toBe("picked");
});
it("recipient change fences the old receipt",()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 db.prepare("UPDATE tasks SET integration_owner_id=NULL WHERE id=?").run(f.id);
 expect(integrationHandoffContext(a.messageId,a.roleId)).toBeNull();
});
it("two approval receipts for the same accepted version do not duplicate integration",()=>{
 const f=fixture(), a=enqueueIntegrationHandoff(f.review)!;
 const second=crypto.randomUUID();
 db.prepare("INSERT INTO reviews(id,task_id,version_id,task_revision,reviewer_id,artifact_hash,criteria_version,verdict,findings) VALUES (?,?,?,?,?, ?,1,'approved','Checked again')").run(second,f.id,f.v.id,f.v.task_revision,owner,f.v.artifact_hash);
 expect(enqueueIntegrationHandoff(second)!.queueRowId).toBe(a.queueRowId);
});
