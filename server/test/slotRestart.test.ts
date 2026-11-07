import {beforeAll,afterAll,it,expect,vi} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import {buildApp} from "../src/index.js";
import db from "../src/db.js";
import * as admission from "../src/runtime/planSubtaskAdmission.js";
import * as runtime from "../src/runtime/inProcessRun.js";
import {restartOccupiedSlot,restartSlotFromOwnerChat} from "../src/runtime/slotRestart.js";
import {openSlotSession,slotSessionDirectory} from "../src/runtime/slotSession.js";
import {chatTools} from "../src/runtime/chatTools.js";
import {seedRoleAccounts} from "./helpers/seedOwner.js";
const uid=()=>crypto.randomUUID();
let app:any;
beforeAll(async()=>{app=await buildApp();seedRoleAccounts(db);});
afterAll(async()=>{await app.close();vi.restoreAllMocks();});
function seed() {
 const task=uid(),plan=uid(),slot=uid(),other=uid(),attempt=uid();
 db.prepare("INSERT INTO tasks(id,title,status,creator_id) VALUES(?,'restart test','active','u1')").run(task);
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,status,profile,rationale,created_by) VALUES(?,?,1,'approved','manual','test','u1')").run(plan,task);
 for(const [id,key] of [[slot,'server'],[other,'web']]){
  db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES(?,?,?,'builder',1,'implement')").run(uid(),plan,key);
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,agent_state,agent_id) VALUES(?,?,'implement',1,?,?,'in_progress','role_builder')").run(id,task,plan,key);
 }
 db.prepare("INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition) VALUES(?,?,'server','web','submitted')").run(uid(),plan);
 db.prepare("INSERT INTO attempts(id,task_id,subtask_id,executor_id) VALUES(?,?,?,'role_builder')").run(attempt,task,slot);
 db.prepare("UPDATE subtasks SET current_attempt_id=? WHERE id=?").run(attempt,slot);
 return {task,plan,slot,other,attempt};
}
it('fresh attempt uses the same slot and role, retains DAG and parallel lease',async()=>{
 const x=seed(); const before=db.prepare('SELECT * FROM task_collaboration_plan_edges WHERE plan_id=?').all(x.plan);
 const spy=vi.spyOn(admission,'startPlanSubtaskRun').mockResolvedValue({ok:true,runId:'fresh'});
 const result=await restartOccupiedSlot(x.slot,'builder','u1','stuck');
 expect(result.ok).toBe(true);expect(spy).toHaveBeenCalledWith(x.slot,'u1',{freshSession:true});
 expect(db.prepare('SELECT outcome,ended_at FROM attempts WHERE id=?').get(x.attempt)).toMatchObject({outcome:'reset',ended_at:expect.any(String)});
 expect(db.prepare('SELECT agent_state FROM subtasks WHERE id=?').get(x.other)).toEqual({agent_state:'in_progress'});
 expect(db.prepare('SELECT * FROM task_collaboration_plan_edges WHERE plan_id=?').all(x.plan)).toEqual(before);
 expect(db.prepare('SELECT count(*) AS n FROM task_collaboration_plan_nodes WHERE plan_id=?').get(x.plan)).toEqual({n:2});
 spy.mockRestore();
});
it('different role and completed slot are refused before stopping work',async()=>{
 const x=seed();await expect(restartOccupiedSlot(x.slot,'qa','u1','stuck')).rejects.toThrow('той же ролью');
 db.prepare('UPDATE subtasks SET done=1 WHERE id=?').run(x.slot);
 await expect(restartOccupiedSlot(x.slot,'builder','u1','stuck')).rejects.toThrow('незавершённый');
 expect(db.prepare('SELECT ended_at FROM attempts WHERE id=?').get(x.attempt)).toEqual({ended_at:null});
});
it('waits for complete old run cleanup before launching and rejects concurrent replacement',async()=>{
 const x=seed();let finish!:()=>void;const completion=new Promise<void>(r=>finish=r);
 const run:any={runId:'old',taskId:x.task,role:'builder',subtaskId:x.slot,abort:vi.fn(async()=>{}),completion};
 const active=vi.spyOn(runtime,'activeInProcessRun').mockReturnValue(run);
 const start=vi.spyOn(admission,'startPlanSubtaskRun').mockResolvedValue({ok:true,runId:'new'});
 const pending=restartOccupiedSlot(x.slot,'builder','u1','replace');
 await Promise.resolve();expect(run.abort).toHaveBeenCalled();expect(start).not.toHaveBeenCalled();expect(run.replacementRequested).toBe(true);
 await expect(restartOccupiedSlot(x.slot,'builder','u1','again')).rejects.toThrow('уже выполняется');
 finish();await pending;expect(start).toHaveBeenCalledOnce();active.mockRestore();start.mockRestore();
});
it('new session retains old file and next regular open resumes new session',()=>{
 const x=seed(),cwd=process.cwd(); const old=openSlotSession(x.task,'builder',x.slot,cwd);
 old.appendMessage({role:'user',content:'old',timestamp:Date.now()});
 old.appendMessage({role:'assistant',content:[{type:'text',text:'old reply'}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 const fresh=openSlotSession(x.task,'builder',x.slot,cwd,true);
 expect(fresh.getSessionId()).not.toBe(old.getSessionId());expect(fresh.getEntries()).toHaveLength(0);
 fresh.appendMessage({role:'user',content:'new',timestamp:Date.now()});
 fresh.appendMessage({role:'assistant',content:[{type:'text',text:'new reply'}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 expect(openSlotSession(x.task,'builder',x.slot,cwd).getSessionId()).toBe(fresh.getSessionId());
 expect(fs.readdirSync(slotSessionDirectory(x.task,'builder',x.slot)).filter(f=>f.endsWith('.jsonl'))).toHaveLength(2);
});
it('REST denies agents and model cannot supply chat authority',async()=>{
 const x=seed();const auth=app.jwt.sign({id:'role_builder'});
 const res=await app.inject({method:'POST',url:`/api/subtasks/${x.slot}/restart`,headers:{authorization:`Bearer ${auth}`},payload:{role:'builder',reason:'replace'}});
 expect(res.statusCode).toBe(403);
 await expect(restartSlotFromOwnerChat('missing','fake',{subtask_id:x.slot,role:'builder',reason:'replace'})).rejects.toThrow('владельца');
 expect(chatTools('builder').some(t=>t.name==='taskflow_slot_restart')).toBe(false);
 expect(chatTools('builder',{chatId:'chat',messageId:'owner-message'}).some(t=>t.name==='taskflow_slot_restart')).toBe(true);
});
it('owner chat tool calls REST and actually creates a new attempt on the same slot',async()=>{
 const x=seed(),chat=uid(),message=uid();
 db.prepare("INSERT INTO chats(id,title,kind,created_by) VALUES(?,'control','group','u1')").run(chat);
 db.prepare("INSERT INTO chat_messages(id,chat_id,from_user_id,text,channel) VALUES(?,?,'u1','restart builder','owner')").run(message,chat);
 const run=vi.spyOn(runtime,'runRoleInProcess').mockResolvedValue({runId:'fresh-sdk',completion:Promise.resolve()});
 const tool=chatTools('builder',{chatId:chat,messageId:message}).find(t=>t.name==='taskflow_slot_restart')!;
 await tool.execute('test',{subtask_id:x.slot,role:'builder',reason:'owner restart'});
 expect(run).toHaveBeenCalledWith(expect.objectContaining({subtaskId:x.slot,role:'builder',freshSession:true}));
 const now=db.prepare('SELECT current_attempt_id,agent_state FROM subtasks WHERE id=?').get(x.slot) as any;
 expect(now.current_attempt_id).not.toBe(x.attempt);expect(now.agent_state).toBe('in_progress');
 expect(db.prepare('SELECT count(*) AS n FROM attempts WHERE subtask_id=?').get(x.slot)).toEqual({n:2});
 run.mockRestore();
});
it('same-role critic replacement starts fresh review in the existing slot',async()=>{
 const x=seed();
 db.prepare("UPDATE task_collaboration_plan_nodes SET role_key='critic_verifier',instructions='[taskflow:final-review]' WHERE plan_id=? AND slot_key='server'").run(x.plan);
 db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(x.task);
 const prompt=vi.spyOn(runtime,'reviewPromptFor').mockReturnValue('review current result');
 const run=vi.spyOn(runtime,'runRoleInProcess').mockResolvedValue({runId:'fresh-critic',completion:Promise.resolve()});
 await restartOccupiedSlot(x.slot,'critic_verifier','u1','critic stalled');
 expect(run).toHaveBeenCalledWith(expect.objectContaining({subtaskId:x.slot,role:'critic_verifier',mode:'review',freshSession:true}));
 expect(db.prepare('SELECT agent_state FROM tasks WHERE id=?').get(x.task)).toEqual({agent_state:'review'});
 prompt.mockRestore();run.mockRestore();
});
