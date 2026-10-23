import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {pathToFileURL} from "node:url";
const titles:Record<string,string>={analyst:"аналитик",architect:"архитектор",builder:"разработчик",critic_verifier:"критик",designer:"дизайнер",infra_engineer:"инженер инфраструктуры",qa:"тестировщик",researcher:"исследователь",code_orchestrator:"оркестратор",claude_code:"инженерный помощник"};
/** Pure, repeatable split. No working rule is inferred/deleted by a classifier. */
export function splitRoleBehavior(role:string,source:string):{agents:string;persona:string} {
 if(role==="secretary") {
  const start=source.indexOf("## Роль");
  const owner=source.indexOf("## Работа с владельцем");
  if(start<0||owner<0)throw new Error("Неизвестная структура secretary: нужен ручной перенос");
  const prefix=source.slice(0,start), body=source.slice(start,owner), suffix=source.slice(owner);
  const sections=body.split(/(?=^### [0-9]+\. )/m);
  const operational=sections.filter(s=>/^### [56]\. /m.test(s));
  const persona=sections.filter(s=>!/^### [56]\. /m.test(s)).join("");
  if(operational.length!==2) throw new Error("Не найдены рабочие разделы 5 и 6 secretary");
  return {agents:prefix+"## Персональные инструкции\n\n"+operational.join("")+suffix,persona};
 }
 let agents=source;
 let persona="# Личность роли\n\nТы — "+(titles[role]??role)+" в TaskFlow. Спокойный, внимательный и деловой собеседник. Объясняй свои мысли ясно, сохраняй профессиональный подход.";
 // Exact descriptive sentences only; following constraints stay in AGENTS.
 const identity:Record<string,string>={
  analyst:"Ты аналитик,",
  architect:"Ты проектируешь структуру системы и технические границы решения.",
  builder:"Ты реализуешь согласованное изменение в коде проекта.",
  critic_verifier:"Ты ищешь ошибки, несоответствия требованиям и слабые доказательства в предложении или готовом результате.",
  designer:"Ты отвечаешь за пользовательский опыт и визуальную систему продукта на вебе и мобильных экранах.",
  researcher:"Ты ищешь, собираешь и проверяешь факты для решения задачи.",
  code_orchestrator:"Ты Оркестратор, у тебя задача организовать группу из агентов для выполнения задач и достижения высоких результатов."
 };
 const sentence=identity[role];
 if(sentence && agents.includes(sentence)) {
  agents=agents.replace(sentence,role==="analyst"?"Анализируй информацию:":"");
  persona="# Личность роли\n\n"+(role==="analyst"?"Ты — аналитик в TaskFlow.":sentence);
 }
 // Infrastructure/QA paragraphs contain binding work restrictions: keep complete.
 agents=agents.replace(/^## Роль$/m,"## Персональные инструкции");
 return {agents,persona:persona+"\n"};
}
const sha=(text:string)=>crypto.createHash("sha256").update(text).digest("hex");
export function migrateRoleBehavior(root:string,apply=false) {
 // Preflight ALL roles before mutating any role.
 const plans=fs.readdirSync(root).filter(key=>fs.existsSync(path.join(root,key,"AGENTS.md"))).map(key=>{
  const dir=path.join(root,key),file=path.join(dir,"AGENTS.md"),marker=path.join(dir,".behavior-split.json"),pending=path.join(dir,".behavior-split.pending.json");
  if(fs.existsSync(marker))return {key,done:true,dir,file,marker,pending};
  if(fs.existsSync(pending)) {
   const plan=JSON.parse(fs.readFileSync(pending,"utf8")) as {source:string;agents:string;persona:string;hash:string};
   if(sha(plan.source)!==plan.hash)throw new Error(key+": повреждён журнал переноса");
   const current=fs.readFileSync(file,"utf8");
   if(current!==plan.source&&current!==plan.agents)throw new Error(key+": инструкции изменились после начала переноса");
   const personaFile=path.join(dir,"ROLE.md");
   if(fs.existsSync(personaFile)&&fs.readFileSync(personaFile,"utf8")!==plan.persona)throw new Error(key+": личность изменена после начала переноса");
   return {key,done:false,dir,file,marker,pending,...plan};
  }
  if(fs.existsSync(path.join(dir,"ROLE.md")))throw new Error(key+": ROLE.md уже существует; автоматическая перезапись запрещена");
  const source=fs.readFileSync(file,"utf8"),result=splitRoleBehavior(key,source);
  return {key,done:false,dir,file,marker,pending,source,hash:sha(source),...result};
 });
 const atomic=(file:string,text:string)=>{
  const tmp=file+"."+crypto.randomUUID()+".tmp",fd=fs.openSync(tmp,"wx",0o600);
  try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
 };
 return plans.map(plan=>{
  if(plan.done)return {key:plan.key,status:"already_split"};
  const {source,agents,persona,hash}=plan as typeof plan & {source:string;agents:string;persona:string;hash:string};
  if(apply) {
   if(!fs.existsSync(plan.pending))atomic(plan.pending,JSON.stringify({source,agents,persona,hash})+"\n");
   const backup=path.join(plan.dir,".behavior-backup-"+hash.slice(0,16)+".md");
   if(fs.existsSync(backup)) {if(fs.readFileSync(backup,"utf8")!==source)throw new Error(plan.key+": резервная копия не совпала");}
   else atomic(backup,source);
   const current=fs.readFileSync(plan.file,"utf8");
   if(current!==source&&current!==agents)throw new Error(plan.key+": AGENTS изменился во время переноса");
   atomic(path.join(plan.dir,"ROLE.md"),persona);
   atomic(plan.file,agents);
   atomic(plan.marker,JSON.stringify({originalSha256:hash,backup:path.basename(backup),at:new Date().toISOString()},null,2)+"\n");
   fs.rmSync(plan.pending);
  }
  return {key:plan.key,status:apply?"split":"preview",originalSha256:hash,agentsChars:agents.length,personaChars:persona.length};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const root=process.env.TASKFLOW_ROLES_DIR??path.join(process.env.HOME??".","taskflow","roles");
 console.log(JSON.stringify(migrateRoleBehavior(root,process.argv.includes("--apply")),null,2));
}

