import {afterAll,beforeAll,expect,it} from 'vitest';
import {buildApp} from '../src/index.js';
import {composeLayer,registerInstructionBlock} from '../src/lib/roleContextResolver.js';
import {TASK_BRIEF_INSTRUCTIONS} from '../src/lib/taskBrief.js';
import {PREPARATION_CONTRACT} from '../src/lib/taskPreparation.js';
let app:Awaited<ReturnType<typeof buildApp>>;
beforeAll(async()=>{
 app=await buildApp();
 for(const key of ['tool.mcp.taskflow_create_task','tool.runtime.taskflow_create_task','mcp.initialize']) {
  registerInstructionBlock({key,title:key,group:'Возможности',scope:'command',modes:['chat'],sourceKind:'code',originRef:'test',readOnly:false}, 'Описание инструмента');
 }
});
afterAll(async()=>{await app.close();});
it('internal creation tool and preparation receive the same brief and decomposition contract',()=>{
 expect(composeLayer('builder','tool.mcp.taskflow_create_task')?.effective).toContain(TASK_BRIEF_INSTRUCTIONS);
 expect(composeLayer('builder','tool.runtime.taskflow_create_task')?.effective).toContain(TASK_BRIEF_INSTRUCTIONS);
 expect(composeLayer('builder','mcp.initialize')?.effective).toContain(TASK_BRIEF_INSTRUCTIONS);
 expect(PREPARATION_CONTRACT).toContain(TASK_BRIEF_INSTRUCTIONS);
 expect(PREPARATION_CONTRACT).toContain('subtasks=[]');
});
