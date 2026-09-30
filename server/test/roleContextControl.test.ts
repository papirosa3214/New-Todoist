import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import db, {migrate} from '../src/db.js';
import {runMigrations} from '../src/migrations.js';
import {buildApp} from '../src/index.js';
import {applyOverride, composeLayer, renderInstruction, revision} from '../src/lib/roleContextResolver.js';
import {startSecretaryVoiceBridge} from '../src/runtime/secretaryVoiceBridge.js';
import {taskflowTools} from '../src/runtime/inProcessRun.js';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
migrate(); runMigrations();
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async()=>{ app=await buildApp(); await app.ready(); });
beforeEach(()=>{ db.exec('DELETE FROM role_context_overrides_history; DELETE FROM role_context_overrides;'); });
const change=(scope:'role'|'command',roleKey:string,layer:string,text:string,action:'set'|'reset'='set',expectedVersion=0)=>applyOverride({scope,roleKey,layer,text,action,expectedVersion,sourceKind:'code',sourceRef:'test',createdBy:'u1'});
const headers=()=>({authorization:'Bearer '+app.jwt.sign({id:'u1'})});
describe('effective instructions, real precedence and concurrency',()=>{
 it('reset follows future team changes and retains its revision',()=>{
  change('command','*','rules','TEAM'); change('role','builder','rules','ROLE');
  expect(composeLayer('builder','rules')!.effective).toBe('ROLE');
  change('role','builder','rules','', 'reset',1);
  expect(composeLayer('builder','rules')!.effective).toBe('TEAM');
  change('command','*','rules','TEAM2','set',1);
  expect(composeLayer('builder','rules')!.effective).toBe('TEAM2');
  expect(revision('role','builder','rules')).toBe(2);
  expect(()=>change('role','builder','rules','STALE','set',1)).toThrow('версия');
 });
 it('renders values once without treating JSON or data as another template',()=>{
  change('role','builder','task.resume','Продолжай {taskId}. JSON: {"a": 1}');
  expect(renderInstruction('builder','task.resume',{taskId:'{taskId} data'})).toBe('Продолжай {taskId} data. JSON: {"a": 1}');
  expect(()=>change('role','builder','task.resume','{unknown}')).toThrow();
 });
 it('API resets require a version and reject stale restore',async()=>{
  const url='/api/runtime/context/builder/rules';
  expect((await app.inject({method:'POST',url:url+'/reset',headers:headers()})).statusCode).toBe(428);
  expect((await app.inject({method:'PATCH',url,headers:headers(),payload:{text:'ONE',if_match:0}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:url+'/reset',headers:headers(),payload:{if_match:1}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:url+'/restore',headers:headers(),payload:{if_match:1,version:1}})).statusCode).toBe(409);
 });
 it('native endpoint exposes all modes without secretary-only data',async()=>{
  const res=await app.inject({url:'/api/roles/builder/runtime-context',headers:headers()});
  expect(res.statusCode).toBe(200);
  expect(res.json().blocks.map((x:any)=>x.id)).toContain('task.plan');
  expect(res.json().blocks.map((x:any)=>x.id)).not.toContain('secretary.summary');
 });
 it('next voice session reads the edited instruction through the Unix bridge',async()=>{
  const socket=path.join('/tmp','tf-v-'+crypto.randomUUID().slice(0,12)+'.sock');
  const stop=await startSecretaryVoiceBridge(app,socket);
  const read=()=>new Promise<any>((resolve,reject)=>{
   http.get({socketPath:socket,path:'/secretary/instructions'},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(JSON.parse(body)));
   }).on('error',reject);
  });
  try {
   const before=await read();
   expect(before.instructions).toContain('Секретарь');
   change('role','secretary','secretary.voice','Новая голосовая инструкция');
   const after=await read();
   expect(after.instructions).toBe('Новая голосовая инструкция');
   expect(after.manifest.some((x:any)=>x.blockId==='secretary.voice'&&x.version===1)).toBe(true);
  } finally {await stop();}
 });
 it('researcher can use the report required by its role instruction',()=>{
  expect(taskflowTools('researcher',null).map(t=>t.name)).toContain('taskflow_report');
  expect(taskflowTools('builder',null).map(t=>t.name)).not.toContain('taskflow_report');
  expect(composeLayer('builder','tool.runtime.taskflow_report')).toBeNull();
 });
});
