import {beforeAll,afterAll,it,expect,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const harness=vi.hoisted(()=>({cwd:"",options:[] as any[],events:[] as string[]}));
vi.mock("../src/runtime/PiRuntimeAdapter.js",async original=>({...await original<typeof import("../src/runtime/PiRuntimeAdapter.js")>(),getModelRuntime:async()=>({getModel:(_provider:string,id:string)=>({id})})}));
vi.mock("../src/runtime/inProcessRun.js",async original=>({...await original<typeof import("../src/runtime/inProcessRun.js")>(),slotWorkspace:()=>harness.cwd,deliverTopicToWork:async()=>"idle"}));
vi.mock("../src/runtime/instructionResources.js",async original=>({...await original<typeof import("../src/runtime/instructionResources.js")>(),createTaskResourceLoader:async()=>({disposeResources:()=>{}})}));
vi.mock("@earendil-works/pi-coding-agent",async original=>{
 const actual=await original<typeof import("@earendil-works/pi-coding-agent")>();
 return {...actual,createAgentSession:async(options:any)=>{
  harness.options.push(options);let listener=(event:any)=>{};
  return {session:{subscribe:(fn:any)=>{listener=fn;},abort:async()=>{},dispose:()=>{},
   state:{messages:[]},prompt:async(text:string)=>{
    options.sessionManager.appendMessage({role:"user",content:text,timestamp:Date.now()});
    const answer={role:"assistant",content:[{type:"text",text:"Ответ по сохранённому этапу"}],stopReason:"stop",api:"test",provider:"test",model:"test",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
    options.sessionManager.appendMessage(answer);listener({type:"agent_end",messages:[answer]});
   }}};
 }};
});
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {acquireSlotSession,openSlotSession,slotSessionDirectory,resolveTopicSlot} from "../src/runtime/slotSession.js";
import {startSlotConversation,slotConversationTools} from "../src/runtime/slotConversation.js";
import {roleProjectSnapshot} from "../src/runtime/roleProjectContext.js";
let root:string;
beforeAll(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),"slot-conversation-"));harness.cwd=path.join(root,"work");fs.mkdirSync(harness.cwd);process.env.TASKFLOW_RUNS_DIR=root;
 migrate();runMigrations();seedRoleAccounts(db);
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('shared_task','Работа','u1')").run();
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by,approved_by) VALUES('shared_plan','shared_task',1,'approved','manual','test','u1','u1')").run();
 for(const [id,key,role] of [["slot_a","work","builder"],["slot_b","qa","qa"]]){
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,'shared_plan',?,?,1,'Результат')").run('node_'+id,key,role);
  db.prepare("INSERT INTO subtasks(id,task_id,title,agent_id,collaboration_plan_id,plan_node_key,agent_state,result) VALUES(?,'shared_task',?,?,'shared_plan',?,'blocked','Исходный блок')").run(id,key,'role_'+role,key);
 }
 db.prepare("INSERT INTO chats(id,title,kind,created_by,task_id) VALUES('shared_chat','Тема','group','u1','shared_task')").run();
 db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id) VALUES('shared_message','u1','Почему блок?','chat','shared_chat','shared_task')").run();
});
afterAll(()=>{fs.rmSync(root,{recursive:true,force:true});});
it("one writer; cancelling a queued discussion does not unlock active work",async()=>{
 const releaseWork=await acquireSlotSession('mutex');const controller=new AbortController();
 const cancelled=acquireSlotSession('mutex',controller.signal);controller.abort(new Error('cancelled'));
 await expect(cancelled).rejects.toThrow('cancelled');
 let entered=false;const next=acquireSlotSession('mutex').then(release=>{entered=true;return release;});
 await Promise.resolve();expect(entered).toBe(false);releaseWork();const releaseNext=await next;expect(entered).toBe(true);releaseNext();
});
it("adopts work history even when chat cwd differs",()=>{
 const dir=slotSessionDirectory('shared_task','builder','slot_a');fs.mkdirSync(dir,{recursive:true});
 const manager=SessionManager.create(harness.cwd,dir);
 manager.appendMessage({role:'user',content:'Исходная рабочая история',timestamp:Date.now()} as any);
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Рабочий результат'}],api:'test',provider:'test',model:'test',usage:{},stopReason:'stop',timestamp:Date.now()} as any);
 const opened=openSlotSession('shared_task','builder','slot_a',path.join(root,'different-chat-cwd'));
 expect(opened.getSessionId()).toBe(manager.getSessionId());expect(opened.getCwd()).toBe(harness.cwd);
 expect(JSON.stringify(opened.buildSessionContext().messages)).toContain('Исходная рабочая история');
});
it("ambiguous roles require a slot; explicit targeting cannot select another role",()=>{
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES('node_c','shared_plan','extra','builder',1,'Результат')").run();
 db.prepare("INSERT INTO subtasks(id,task_id,title,agent_id,collaboration_plan_id,plan_node_key) VALUES('slot_c','shared_task','Дополнительный этап','role_builder','shared_plan','extra')").run();
 expect(resolveTopicSlot('shared_task','builder')).toBeNull();expect(resolveTopicSlot('shared_task','builder','work')?.id).toBe('slot_a');
 expect(resolveTopicSlot('shared_task','builder',undefined,'slot_b')).toBeNull();
 const shared=roleProjectSnapshot('builder',null,'shared_task');
 expect(shared).toContain('Исходный блок');expect(shared).toContain('Дополнительный этап');expect(shared).toContain('постоянный участник');
});
// Владелец 20.10.2026: «Обсуждение» — то же, что работа по задаче, без ограничений.
it("discussion has the same tools as work",()=>{
 const names=slotConversationTools('builder','test','shared_task','slot_a').map(tool=>tool.name);
 expect(names).toContain('taskflow_doc_read');expect(names).toContain('taskflow_task');
 expect(names).toContain('taskflow_state');expect(names).toContain('taskflow_subtask_done');expect(names).toContain('taskflow_doc_write');expect(names).toContain('taskflow_topic_send');expect(names).toContain('taskflow');
});
it("conversation continues work file without changing slot state or creating attempts",async()=>{
 const before=db.prepare("SELECT * FROM subtasks WHERE id='slot_a'").get();const attempts=(db.prepare("SELECT count(*) n FROM attempts").get() as any).n;
 const saved=(db.prepare("SELECT * FROM slot_sessions WHERE subtask_id='slot_a'").get() as any);
 const reply=await startSlotConversation({taskId:'shared_task',subtaskId:'slot_a',role:'builder',chatId:'shared_chat',messageId:'shared_message',prompt:'Поясни блок'});
 expect(reply.text).toBe('Ответ по сохранённому этапу');expect(reply.sessionId).toBe(saved.session_id);
 expect(db.prepare("SELECT * FROM subtasks WHERE id='slot_a'").get()).toEqual(before);expect((db.prepare("SELECT count(*) n FROM attempts").get() as any).n).toBe(attempts);
 expect((db.prepare("SELECT session_file FROM slot_sessions WHERE subtask_id='slot_a'").get() as any).session_file).toBe(saved.session_file);
 expect(harness.options.at(-1).tools).toContain('taskflow');expect(harness.options.at(-1).tools).not.toContain('taskflow_task');expect(harness.options.at(-1).tools).not.toContain('bash');expect(harness.options.at(-1).tools).not.toContain('write');
});
