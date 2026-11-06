import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chatInstructionArgs} from '../src/runtime/instructionResources.js';
import {prepareRoleRunAccess,releaseRoleRunAccess,setRoleTokenSigner} from '../src/runtime/roleRunAccess.js';
import {migrate} from '../src/db.js';
import {runMigrations} from '../src/migrations.js';
import {parseChatWorkMode} from '../src/runtime/chatWorkMode.js';

migrate();runMigrations();

describe('chat planning permissions',()=>{
 it('blocks write, bash and unknown extension tools while retaining read tools',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tf-plan-'));
  try {
   const args=await chatInstructionArgs('builder',path.join(dir,'run.json'),'plan');
   const extension=await import('file://'+args[args.indexOf('--extension')+1]);
   const tools:any[]=[];let guard:any;
   extension.default({registerTool:(t:any)=>tools.push(t),on:(name:string,handler:any)=>{if(name==='tool_call')guard=handler;}});
   expect(tools.map(t=>t.name)).toEqual(['read','grep','find','ls']);
   expect(args[args.indexOf('--tools')+1].split(',')).toContain('taskflow_task');
   expect(args[args.indexOf('--tools')+1].split(',')).not.toContain('bash');
   for(const toolName of ['bash','write','edit','taskflow_create_task','taskflow_doc_write','taskflow_plan_request','taskflow_consult','unknown_tool','untrusted__read']) {
    expect(await guard({toolName})).toMatchObject({block:true});
   }
   expect(await guard({toolName:'read'})).toBeUndefined();
   expect(await guard({toolName:'taskflow_task'})).toBeUndefined();
   expect(fs.readFileSync(args[args.indexOf('--append-system-prompt')+1],'utf8')).toContain('Режим этого хода: План.');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('plan: read tools and taskflow_inspect allowed, bash/host write tools hidden',async()=>{
  const {PLANNING_TOOLS,chatModeInstruction}=await import('../src/runtime/chatWorkMode.js');
  for(const n of ['read','grep','find','ls','taskflow_host_read','taskflow_host_find','taskflow_host_grep','taskflow_host_ls','taskflow_inspect']) expect(PLANNING_TOOLS).toContain(n);
  for(const n of ['bash','edit','write','taskflow_host_bash','taskflow_host_edit','taskflow_host_write','taskflow_host_push','taskflow_host_attach','taskflow_doc_write','taskflow_state']) expect(PLANNING_TOOLS).not.toContain(n);
  const {isReadOperation}=await import('../src/runtime/universalTaskflow.js');
  expect(isReadOperation('taskflow_inspect')).toBe(true);
  expect(isReadOperation('taskflow_host_bash')).toBe(false);
  expect(chatModeInstruction('plan')).toContain('taskflow_inspect');
  expect(chatModeInstruction('plan')).toContain('Режим этого хода: План.');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tf-plan2-'));
  try {
   const args=await chatInstructionArgs('builder',path.join(dir,'run.json'),'plan');
   const extension=await import('file://'+args[args.indexOf('--extension')+1]);
   let guard:any;extension.default({registerTool:()=>{},on:(n:string,h:any)=>{if(n==='tool_call')guard=h;}});
   expect(await guard({toolName:'taskflow_inspect'})).toBeUndefined();
   expect(await guard({toolName:'taskflow_host_read'})).toBeUndefined();
   expect(await guard({toolName:'taskflow_host_bash'})).toMatchObject({block:true});
   expect(await guard({toolName:'taskflow_host_edit'})).toMatchObject({block:true});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('filters the actual MCP allowlist in planning and restores work permissions',()=>{
  setRoleTokenSigner(()=> 'test-token');
  const plan=prepareRoleRunAccess('mode-plan-test','builder','plan')!;
  const work=prepareRoleRunAccess('mode-work-test','builder','work')!;
  try {
   const names=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8')).mcpServers.taskflow.env.TASKFLOW_MCP_TOOLS.split(',');
   expect(names(plan)).toContain('taskflow_task');
   expect(names(plan)).not.toContain('taskflow_claim');
   expect(names(plan)).not.toContain('taskflow_doc_write');
   expect(names(work)).toContain('taskflow_claim');
  }finally {releaseRoleRunAccess(plan);releaseRoleRunAccess(work);}
 });
 it('rejects unknown modes rather than silently executing work',()=>{
  expect(parseChatWorkMode(undefined)).toBe('work');
  expect(()=>parseChatWorkMode('execute-anything')).toThrow();
 });
});

describe("режим «Цель»", () => {
  it("принимается и распознаёт последнюю строку", async () => {
    const m = await import("../src/runtime/chatWorkMode.js");
    expect(m.parseChatWorkMode("goal")).toBe("goal");
    expect(m.goalStatus("сделал шаг\n**ЦЕЛЬ: ПРОДОЛЖАЮ**")).toBe("continue");
    expect(m.goalStatus("итог\nЦЕЛЬ: ДОСТИГНУТА.")).toBe("done");
    expect(m.goalStatus("вопрос?\nЦЕЛЬ: НУЖЕН ВЛАДЕЛЕЦ")).toBe("owner");
    expect(m.goalStatus("просто ответ")).toBeNull();
    expect(m.stripGoalMark("итог\nЦЕЛЬ: ДОСТИГНУТА")).toBe("итог");
    expect(m.stripGoalMark("просто ответ")).toBe("просто ответ");
  });
});
