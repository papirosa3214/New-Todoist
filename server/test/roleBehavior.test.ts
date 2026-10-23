import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import crypto from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {readRoleBehavior,applyRoleBehavior,saveRoleBehaviorTemplate,behaviorInstruction} from '../src/runtime/roleBehavior.js';
let dir:string;const originalRolesDir=process.env.TASKFLOW_ROLES_DIR;
beforeEach(async()=>{const db=(await import('../src/db.js')).default;if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='role_context_overrides'").get()){db.prepare('DELETE FROM role_context_overrides_history').run();db.prepare('DELETE FROM role_context_overrides').run();}dir=fs.mkdtempSync(path.join(os.tmpdir(),'behavior-'));process.env.TASKFLOW_ROLES_DIR=dir;});
afterEach(()=>{process.env.TASKFLOW_ROLES_DIR=originalRolesDir;fs.rmSync(dir,{recursive:true,force:true});});
describe('role behavior',()=>{
it('saves without applying and detects stale direct-file edits',()=>{
 const first=readRoleBehavior('builder');const template=saveRoleBehaviorTemplate('builder',{name:'Мой',text:'PERSONA',gender:'female'});
 expect(readRoleBehavior('builder').text).toBe(first.text);
 const next=applyRoleBehavior('builder',{text:template.text,gender:template.gender,expectedVersion:first.version});
 expect(next.text).toBe('PERSONA');expect(next.gender).toBe('female');expect(next.templates.find(t=>t.id===template.id)).toEqual(template);
 expect(()=>applyRoleBehavior('builder',{text:'bad',gender:'male',expectedVersion:first.version})).toThrow(/версия/);
 fs.writeFileSync(path.join(dir,'builder','ROLE.md'),'EXTERNAL');
 expect(readRoleBehavior('builder').version).not.toBe(next.version);
 expect(behaviorInstruction('builder')).toContain('женском');
 expect(readRoleBehavior('reviewer').templates.some(t=>t.id===template.id)).toBe(false);
});
it('rejects traversal, oversized text, invalid gender',()=>{
 expect(()=>readRoleBehavior('../bad')).toThrow();
 expect(()=>saveRoleBehaviorTemplate('builder',{name:'x',text:'a',gender:'other' as any})).toThrow();
 expect(()=>saveRoleBehaviorTemplate('builder',{name:'x',text:'x'.repeat(65537),gender:'male'})).toThrow();
});
});

it('uses ROLE exactly once in actual task/chat prompts and shares the common document',async()=>{
 const {roleInstructionText,systemPromptSourceFile}=await import('../src/runtime/roleHome.js');
 const {chatSystemPrompt,discoverChatResources}=await import('../src/runtime/instructionResources.js');
 const {composeLayer,applyOverride,revision,compose}=await import('../src/lib/roleContextResolver.js');
 const dbModule=await import('../src/db.js');dbModule.migrate();(await import('../src/migrations.js')).runMigrations();
 dbModule.default.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES('test','test','behavior-test@test','hash','owner','human')").run();
 const common=path.join(dir,'common.md');fs.writeFileSync(common,'# COMMON {{IDENTITY}}');process.env.TASKFLOW_ROLE_SYSTEM_PROMPT=common;
 try{
 const first=readRoleBehavior('builder');applyRoleBehavior('builder',{text:'UNIQUE_PERSONA',gender:'female',expectedVersion:first.version});
 expect(roleInstructionText('builder').split('UNIQUE_PERSONA')).toHaveLength(2);
 expect(roleInstructionText('builder',{withAgents:false}).split('UNIQUE_PERSONA')).toHaveLength(2);
 const chat=await chatSystemPrompt('builder','work',dir);expect(chat.split('UNIQUE_PERSONA')).toHaveLength(2);expect(chat).toContain('женском');
 expect(compose('builder','voice').find(x=>x.layer==='role.persona')?.effective).toContain('женском');
 await discoverChatResources('builder');
 applyOverride({scope:'command',roleKey:'builder',layer:'role.system',text:'NEW_COMMON {{IDENTITY}}',expectedVersion:revision('command','builder','role.system'),action:'set',sourceKind:'file',sourceRef:systemPromptSourceFile(),createdBy:'test'});
 expect(roleInstructionText('reviewer')).toContain('NEW_COMMON');
 expect(composeLayer('builder','role.system')?.version).toBe(composeLayer('reviewer','role.system')?.version);
 const current=readRoleBehavior('builder');
 applyOverride({scope:'role',roleKey:'builder',layer:'role.persona',text:'EDITED_PERSONA',expectedVersion:current.version,action:'set',sourceKind:'file',sourceRef:'ROLE.md',createdBy:'test'});
 expect(readRoleBehavior('builder').version).toBe(current.version+1);expect(readRoleBehavior('builder').text).toBe('EDITED_PERSONA');
 const agentsFile=path.join(dir,'builder','AGENTS.md');const legacy='resource.'+crypto.createHash('sha256').update(agentsFile).digest('hex').slice(0,20);
 applyOverride({scope:'role',roleKey:'builder',layer:legacy,text:'LEGACY_AGENT',expectedVersion:0,action:'set',sourceKind:'file',sourceRef:agentsFile,createdBy:'test'});
 applyOverride({scope:'role',roleKey:'builder',layer:'role.prompt',text:'CURRENT_AGENT',expectedVersion:1,action:'set',sourceKind:'file',sourceRef:agentsFile,createdBy:'test'});
 expect(composeLayer('builder',legacy)?.effective).toBe('CURRENT_AGENT');expect(revision('role','builder',legacy)).toBe(2);
 expect(await chatSystemPrompt('builder','work',dir)).toContain('CURRENT_AGENT');
 }finally{delete process.env.TASKFLOW_ROLE_SYSTEM_PROMPT;}
});
it('enforces owner authentication, known roles, save-only and stale conflicts in API',async()=>{
 const previousSystem=process.env.TASKFLOW_ROLE_SYSTEM_PROMPT;process.env.TASKFLOW_ROLE_SYSTEM_PROMPT=path.join(dir,'api-common.md');fs.writeFileSync(process.env.TASKFLOW_ROLE_SYSTEM_PROMPT,'API_COMMON_ORIGINAL {{IDENTITY}}');
 const {buildApp}=await import('../src/index.js');const db=(await import('../src/db.js')).default;
 const owner=crypto.randomUUID(),agent=crypto.randomUUID();
 for(const [id,role] of [[owner,'owner'],[agent,'agent']])db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,?,?,'human')").run(id,id,id+'@test','hash',role);
 const key='test_behavior';db.prepare("INSERT OR IGNORE INTO roles(key,title,summary,enabled,position) VALUES(?,?,?,1,0)").run(key,key,'');
 const app=await buildApp();await app.ready();
 const auth=(id:string)=>({authorization:'Bearer '+app.jwt.sign({id})});
 try{
 expect((await app.inject({method:'GET',url:'/api/roles/'+key+'/behavior'})).statusCode).toBe(401);
 expect((await app.inject({method:'GET',url:'/api/roles/'+key+'/behavior',headers:auth(agent)})).statusCode).toBe(403);
 const headers=auth(owner);
 expect((await app.inject({method:'GET',url:'/api/roles/unknown_role/behavior',headers})).statusCode).toBe(404);
 const first=(await app.inject({method:'GET',url:'/api/roles/'+key+'/behavior',headers})).json();
 const saved=await app.inject({method:'POST',url:'/api/roles/'+key+'/behavior/templates',headers,payload:{name:'Mine',text:'CUSTOM_PATTERN',gender:'female'}});expect(saved.statusCode).toBe(200);
 expect(readRoleBehavior(key).text).toBe(first.text);
 const updated=await app.inject({method:'PATCH',url:'/api/roles/'+key+'/behavior',headers,payload:{text:'CUSTOM_PATTERN',gender:'female',expectedVersion:first.version}});expect(updated.statusCode).toBe(200);
 expect(updated.json().gender).toBe('female');
 expect((await app.inject({method:'PATCH',url:'/api/roles/'+key+'/behavior',headers,payload:{text:'STALE',gender:'male',expectedVersion:first.version}})).statusCode).toBe(409);
 const url='/api/runtime/context/'+key+'/role.system';
 const common=await app.inject({method:'PATCH',url,headers,payload:{text:'API_COMMON_EDITED {{IDENTITY}}',expectedVersion:0,scope:'role'}});expect(common.statusCode).toBe(200);
 const history=(await app.inject({method:'GET',url,headers})).json();expect(history.history.some((x:any)=>x.version===1)).toBe(true);
 const restore=await app.inject({method:'POST',url:url+'/restore',headers,payload:{version:0,expectedVersion:1}});expect(restore.statusCode).toBe(200);
 expect(restore.json().effective).toContain('API_COMMON_ORIGINAL');
 }finally{await app.close();if(previousSystem)process.env.TASKFLOW_ROLE_SYSTEM_PROMPT=previousSystem;else delete process.env.TASKFLOW_ROLE_SYSTEM_PROMPT;}
});

it('regression: an existing ROLE.md reaches the actual role prompt',async()=>{
 const {roleInstructionText,ensureRoleHome}=await import('../src/runtime/roleHome.js');
 const home=ensureRoleHome('builder');
 fs.writeFileSync(path.join(home.dir,'ROLE.md'),'BASELINE_PERSONALITY_MARKER');
 const prompt=roleInstructionText('builder');
 expect(prompt).toContain('BASELINE_PERSONALITY_MARKER');
 expect(prompt).toContain('Говори о себе в мужском роде');
});

it('recovers an interrupted apply journal with matching text, gender and version',()=>{
 const home=path.join(dir,'secretary');readRoleBehavior('secretary');
 expect(readRoleBehavior('secretary').gender).toBe('female');
 fs.writeFileSync(path.join(home,'behavior.pending.json'),JSON.stringify({text:'RECOVERED',state:{gender:'male',templates:[],version:12,textHash:crypto.createHash('sha256').update('RECOVERED').digest('hex')}}));
 const recovered=readRoleBehavior('secretary');expect(recovered.text).toBe('RECOVERED');expect(recovered.gender).toBe('male');expect(recovered.version).toBe(12);
 expect(fs.existsSync(path.join(home,'behavior.pending.json'))).toBe(false);
});

it('sends personality and explicit gender once through the real voice socket',async()=>{
 const {startSecretaryVoiceBridge}=await import('../src/runtime/secretaryVoiceBridge.js');
 const http=await import('node:http');const Fastify=(await import('fastify')).default;const app=Fastify();
 const first=readRoleBehavior('secretary');applyRoleBehavior('secretary',{text:'VOICE_PERSONA_MARKER',gender:'male',expectedVersion:first.version});
 const socket=path.join(dir,'voice.sock');const stop=await startSecretaryVoiceBridge(app,socket);
 try{
 const response=await new Promise<any>((resolve,reject)=>http.get({socketPath:socket,path:'/secretary/instructions'},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));}).on('error',reject));
 expect(response.instructions.split('VOICE_PERSONA_MARKER')).toHaveLength(2);expect(response.instructions).toContain('Говори о себе в мужском роде');
 }finally{await stop();await app.close();}
});
