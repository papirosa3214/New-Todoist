import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ensureRoleHome} from './roleHome.js';
import {builtInBehaviorTemplates} from './roleBehaviorCatalog.js';
export type BehaviorGender='male'|'female';
export type BehaviorTemplate={id:string;name:string;text:string;gender:BehaviorGender;builtin:boolean};
type State={gender:BehaviorGender;templates:BehaviorTemplate[];version?:number;textHash?:string};
export class BehaviorConflict extends Error {}
export function atomicBehaviorWrite(file:string,text:string) {
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 const fd=fs.openSync(temp,'wx',0o600);
 try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
 try {fs.renameSync(temp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}} finally {fs.rmSync(temp,{force:true});}
}
function state(role:string):State {
 const home=ensureRoleHome(role);const file=path.join(home.dir,'behavior.json');
 const journal=path.join(home.dir,'behavior.pending.json');
 if(fs.existsSync(journal)){const pending=JSON.parse(fs.readFileSync(journal,'utf8'));validateBehavior({text:pending.text,gender:pending.state?.gender});atomicBehaviorWrite(home.role,pending.text);atomicBehaviorWrite(file,JSON.stringify(pending.state,null,2)+'\n');fs.unlinkSync(journal);}
 try {const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!['male','female'].includes(data.gender)||!Array.isArray(data.templates))throw new Error('повреждено хранилище поведения');return data;}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {gender:role==='secretary'?'female':'male',templates:[]};throw e;}
}
export function validateBehavior(input:{text:unknown;gender:unknown}) {
 if(typeof input.text!=='string'||!input.text.trim()||Buffer.byteLength(input.text)>65536)throw new Error('нужен текст роли до 64 КБ');
 if(input.gender!=='male'&&input.gender!=='female')throw new Error('пол: male или female');
}
export function readRoleBehavior(role:string) {
 const home=ensureRoleHome(role);const data=state(role);const text=fs.readFileSync(home.role,'utf8');
 const hash=crypto.createHash('sha256').update(text).digest('hex');
 let version=data.version ?? 0;
 if(data.textHash!==hash){if(data.textHash)version++;data.textHash=hash;data.version=version;atomicBehaviorWrite(path.join(home.dir,'behavior.json'),JSON.stringify(data,null,2)+'\n');}
 return {role,text,gender:data.gender,version,templates:[...builtInBehaviorTemplates(role),...data.templates]};
}
export function applyRoleBehavior(role:string,input:{text:string;gender:BehaviorGender;expectedVersion:number}) {
 validateBehavior(input);const current=readRoleBehavior(role);
 if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==current.version)throw new BehaviorConflict('версия роли не совпала');
 const home=ensureRoleHome(role);const data=state(role);data.gender=input.gender;data.version=current.version+1;data.textHash=crypto.createHash('sha256').update(input.text).digest('hex');
 atomicBehaviorWrite(path.join(home.dir,'behavior.pending.json'),JSON.stringify({text:input.text,state:data}));
 atomicBehaviorWrite(home.role,input.text);
 atomicBehaviorWrite(path.join(home.dir,'behavior.json'),JSON.stringify(data,null,2)+'\n');
 fs.unlinkSync(path.join(home.dir,'behavior.pending.json'));
 return readRoleBehavior(role);
}
export function saveRoleBehaviorTemplate(role:string,input:{name:string;text:string;gender:BehaviorGender}):BehaviorTemplate {
 validateBehavior(input);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>120)throw new Error('нужно имя шаблона до 120 символов');
 const home=ensureRoleHome(role);const data=state(role);if(data.templates.length>=100)throw new Error('не больше 100 шаблонов роли');
 const template:BehaviorTemplate={id:crypto.randomUUID(),name:input.name.trim(),text:input.text,gender:input.gender,builtin:false};
 data.templates.push(template);atomicBehaviorWrite(path.join(home.dir,'behavior.json'),JSON.stringify(data,null,2)+'\n');return template;
}
/** Рамка характера (владелец 27.10.2026): характер говорит, кто роль и каким
 *  тоном она говорит, но не перебивает правила работы — раньше «коротко,
 *  панчами» глушило пояснения по ходу работы. */
const PERSONA_FRAME='ЛИЧНОСТЬ РОЛИ — кто ты и каким тоном говоришь. Правила SYSTEM, AGENTS.md и правила работы главнее этого раздела: если манера речи отсюда расходится с ними (например, «коротко» против пояснений по ходу работы), выполняй правила, а тон сохраняй.';
export function behaviorInstruction(role:string):string {
 const current=readRoleBehavior(role);
 return PERSONA_FRAME+'\n\n'+current.text+'\n\nПол и грамматический род (явная настройка владельца): '+(current.gender==='female'?'женский. Говори о себе в женском роде: «проверила», «готова», «сделала».':'мужской. Говори о себе в мужском роде: «проверил», «готов», «сделал».')+' Эта настройка определяет род самоописания даже при другом роде в тексте шаблона. Она не меняет полномочия, правила работы или голос озвучивания.';
}
