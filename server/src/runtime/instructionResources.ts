import {hasSingleChatSystem,singleChatSystemPrompt} from "./secretaryChatPrompt.js";
import {behaviorInstruction,genderInstruction} from './roleBehavior.js';
import {chatExecutionMode} from './chatExecutionMode.js';
import {registryEnabled,buildRegistryRules} from './roleRegistryPrompt.js';
import { stageSkillNames } from "../lib/collaborationTemplates.js";
import { skillLabels, type SkillLabel } from "../lib/skillCatalog.js";
import { PLANNING_TOOLS, chatModeInstruction, type ChatWorkMode } from "./chatWorkMode.js";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
 createCodingTools, createReadOnlyTools, DefaultResourceLoader, SettingsManager, loadSkills, type ResourceLoader,
 createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
 createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {registerInstructionBlock, composeLayer, LAYER_CATALOG, type RunMode} from '../lib/roleContextResolver.js';
import {INSTRUCTION_DEFAULTS} from './instructionDefaults.js';
import {ensureRoleHome, roleHome, roleHomeInstruction, systemPromptSourceFile, renderSystemPrompt, renderPromptAddendum, roleAgentsSection, roleAnswerContract} from './roleHome.js';
import type { RuleChannel } from '../lib/roleRules.js';
import { withObservationContext } from "../lib/contextObservability.js";
import { selectSkillsByJev } from "../lib/memorySkillsJev.js";
const ROLE_RESOURCE_MODES: RunMode[] = ['work','resume','reply','review','subtask','chat'];
const keyFor=(file:string)=>path.basename(file)==='AGENTS.md'?'role.prompt':file===systemPromptSourceFile()?'role.system':'resource.'+crypto.createHash('sha256').update(file).digest('hex').slice(0,20);
const builtinTools=(cwd:string)=>[...new Map([...createCodingTools(cwd),...createReadOnlyTools(cwd)].map(t=>[t.name,t])).values()];
/**
 * Папки навыков для загрузчика. Помощнице владельца подключаются и
 * исследовательские навыки: глубокое исследование она ведёт сама
 * (карточка e11eae7a, пункт 3) — тот же загрузчик, тот же код навыков.
 */
function skillPathsFor(role:string, sharedChatSkills:boolean):string[]{
 const home=ensureRoleHome(role);
 // Общие навыки — у всех ролей во всех режимах (владелец 07.11.2026).
 const paths=[path.resolve(process.cwd(),'scripts','shared-skills'),home.skills];
 if(role==='secretary'){
  const researchSkills=roleHome('researcher').skills;
  if(fs.existsSync(researchSkills))paths.push(researchSkills);
 }
 return paths.filter(dir=>fs.existsSync(dir));
}
export function instructionResources(cwd=process.cwd()) {
 const specs:Array<{key:string;text:string;title:string;source:string;editable:boolean}>=[];
 for(const [key,text] of Object.entries(INSTRUCTION_DEFAULTS)) {
  if(key==='mcp.initialize'||key.startsWith('tool.mcp.'))specs.push({key,text,title:key==='mcp.initialize'?'Инструкция MCP initialize':key.slice(9),source:'server/scripts/mcp_server.py:'+key,editable:true});
 }
 for(const t of builtinTools(cwd))specs.push({key:'tool.builtin.'+t.name,text:t.description,title:t.name,source:'Pi SDK builtin tool: '+t.name,editable:true});
 const sdkRoot=path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
 for(const rel of ['core/system-prompt.js','core/compaction/compaction.js','core/compaction/utils.js','core/compaction/branch-summarization.js']) {
  const source=path.join(sdkRoot,rel);
  const text=fs.readFileSync(source,'utf8');
  const prompts=[...text.matchAll(/(?:const|let) ([A-Z_]*PROMPT) = `([\s\S]*?)`;/g)].map(m=>m[1]+':\n'+m[2]).join('\n\n');
  specs.push({key:'pi.'+rel.replace(/[^a-z]/g,'_'),text:prompts||text,title:rel.includes('compaction')?'Pi: сжатие/резюме истории':'Pi: системная инструкция',source,editable:false});
 }
 for(const s of specs)registerInstructionBlock({key:s.key,title:s.title,group:s.key.startsWith('tool.')?'Возможности':'Контекст',scope:'command',modes:s.key.startsWith('tool.builtin.')?['work','resume','reply','review','subtask','chat']:['chat'],sourceKind:'file',originRef:s.source,readOnly:!s.editable},s.text);
 registerInstructionBlock({key:'runtime.boundaries',title:'Программные ограничения',group:'Возможности',scope:'role',modes:['work','chat','voice','summary'],sourceKind:'code',originRef:'auth/access/agentState + Pi SDK',readOnly:true},'Разрешения API, allowlist MCP, схемы инструментов и переходы состояний проверяются кодом. Текст инструкции не меняет эти ограничения. AGENTS.md и skills выбранной роли загружаются из её постоянной папки и в задачах, и в чате. Чат работает в workspace роли, задача — в проекте. Скрипты доступны обоим по абсолютному пути. Pi extensions и prompt templates из папки роли подключаются только к чату; в задачах исполняемые расширения отключены. Глобальные ресурсы Pi не подмешиваются.');
 return specs;
}
/** Freeze the exact text sources once per chat turn, leave SDK tool schema and extensions intact. */
export async function chatInstructionArgs(role:string, configPath:string, mode:ChatWorkMode="work", cwd=ensureRoleHome(role).workspace, chatId?:string):Promise<string[]> {
 const channel=chatExecutionMode(chatId)==="card"?"card":"chat";
 instructionResources(cwd);
 const dir=path.dirname(configPath);const prefix=path.basename(configPath);
 const discovered=await discoverChatResources(role,true);
 const useRegistry=registryEnabled()&&!hasSingleChatSystem(role);
 const append=useRegistry?[roleAgentsSection(role)].filter(Boolean):discovered.agentsFiles.map(x=>'# '+x.path+'\n'+(composeLayer(role,keyFor(x.path))?.effective ?? fs.readFileSync(x.path,'utf8')));
 for(const source of discovered.appendSources)append.push(composeLayer(role,keyFor(source.path))?.effective ?? fs.readFileSync(source.path,'utf8'));
 // Правила карточки в чат не идут (владелец 28.10.2026: чат и карточка — разные режимы).
 append.push(useRegistry?genderInstruction(role):behaviorInstruction(role));
 append.push(chatModeInstruction(mode));
 append.push('ПРОМЕЖУТОЧНЫЕ ПОЯСНЕНИЯ: краткость относится к итогу. Чек-лист (taskflow_work_plan) заводится до начала работы; дальше обычный текст идёт по нему — начал этап, одной фразой что делаешь; закрыл этап, одной-двумя фразами что по нему вышло. Внутри этапа по операциям не отчитывайся: одна операция почти ничего не меняет. Вне плана пиши только при смене подхода, значимой находке, содержательной проверке или блоке. Обычный текст должен быть понятен владельцу без открытия инструментов. Не выдумывай прогресс. Не раскрывай внутренние рассуждения. Это правило уточняет запреты пересказа хода работы в старых инструкциях.');
 append.push(roleHomeInstruction(role));
 const file=path.join(dir,prefix+'.prompt.txt');
 fs.writeFileSync(file,append.join('\n\n'),{mode:0o600});
 const args=['--no-context-files','--no-skills','--no-extensions','--no-prompt-templates','--append-system-prompt',file];
 const home=ensureRoleHome(role);
 for(const entry of fs.readdirSync(home.extensions).filter(n=>!n.startsWith('.'))) args.push('--extension',path.join(home.extensions,entry));
 if(discovered.prompts.length) args.push('--prompt-template',home.prompts);
 // Snapshot skills without modifying external/global files. Original base directories are explicit.
 if(discovered.skills.length) {
  const skillDir=configPath+'.skills';fs.mkdirSync(skillDir,{recursive:true,mode:0o700});
  for(const skill of discovered.skills) {
   const snapshot=path.join(skillDir,path.basename(skill.filePath)+'-'+crypto.createHash('sha256').update(skill.filePath).digest('hex').slice(0,12)+'.md');
   fs.writeFileSync(snapshot,(composeLayer(role,keyFor(skill.filePath))?.effective ?? fs.readFileSync(skill.filePath,'utf8'))+'\n\nReference files resolve relative to original directory: '+skill.baseDir,{mode:0o600});
   args.push('--skill',snapshot);
  }
 }
 const descriptionMap=Object.fromEntries(builtinTools(cwd).map(t=>[t.name,composeLayer(role,'tool.builtin.'+t.name)?.effective ?? t.description]));
 const extension=configPath+'.tools.mjs';
 fs.writeFileSync(extension,`import * as sdk from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
 export default function(api) { const mode=${JSON.stringify(mode)}; const allowed=${JSON.stringify(PLANNING_TOOLS)};
 if(mode === "plan") api.on("tool_call", async event => {
  const composioRead = ["COMPOSIO_SEARCH_TOOLS","COMPOSIO_MULTI_EXECUTE_TOOL","COMPOSIO_GET_TOOL_SCHEMAS"].some(name => event.toolName === "composio_"+name);
  if (!composioRead && !allowed.some(name => event.toolName === name || event.toolName === "taskflow_"+name || event.toolName === "mcp__taskflow_"+name || event.toolName === "mcp__taskflow__"+name)) return {block:true,reason:"Планирование: разрешены только инструменты чтения. Для выполнения выберите режим Работа."};
 });
 const descriptions=${JSON.stringify(descriptionMap)};
 for (const make of [sdk.createReadToolDefinition,sdk.createBashToolDefinition,sdk.createEditToolDefinition,sdk.createWriteToolDefinition,sdk.createGrepToolDefinition,sdk.createFindToolDefinition,sdk.createLsToolDefinition]) {
  const tool=make(${JSON.stringify(cwd)}); if(mode === "plan" && !allowed.includes(tool.name)) continue; api.registerTool({...tool,description:descriptions[tool.name] ?? tool.description});
 }}
`,{mode:0o600});
 args.push('--extension',extension);
 if(mode==='plan') args.push('--tools',PLANNING_TOOLS.join(','));
 // --no-context-files не отключает глобальный SYSTEM.md в Pi CLI.
 // Всегда передаём явную базовую инструкцию: файл роли либо штатный prompt SDK.
 const custom=discovered.systemPromptSource;
 const sdkRoot=path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
 const {buildSystemPrompt}=await import(pathToFileURL(path.join(sdkRoot,'core/system-prompt.js')).href);
 const tools=[createReadToolDefinition,createBashToolDefinition,createEditToolDefinition,createWriteToolDefinition,createGrepToolDefinition,createFindToolDefinition,createLsToolDefinition]
  .map(make=>make(cwd)).filter(t=>mode!=='plan'||PLANNING_TOOLS.includes(t.name));
 const base=useRegistry ? buildRegistryRules(role,channel).text : custom ? renderSystemPrompt(role,ensureRoleHome(role)) : buildSystemPrompt({
  cwd,selectedTools:tools.map(t=>t.name),
  toolSnippets:Object.fromEntries(tools.map(t=>[t.name,t.promptSnippet])),
  promptGuidelines:tools.flatMap(t=>t.promptGuidelines ?? []),
 });
 const sys=configPath+'.system.txt';fs.writeFileSync(sys,base,{mode:0o600});args.push('--system-prompt',sys);
 return args;
}

/** Same SDK discovery as chat, with executable extensions disabled while inspecting resources. */
export async function discoverChatResources(role:string, sharedChatSkills=false) {
 const home=ensureRoleHome(role,{refreshSystem:true});
 const loader=new DefaultResourceLoader({
  cwd:home.workspace,agentDir:home.dir,settingsManager:SettingsManager.inMemory(),
  noExtensions:true,noThemes:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,
  additionalSkillPaths:skillPathsFor(role,sharedChatSkills),additionalPromptTemplatePaths:[home.prompts],
  agentsFilesOverride:()=>({agentsFiles:[{path:home.agents,content:fs.readFileSync(home.agents,'utf8')}]}),
 });
 await loader.reload();
 const currentKeys=new Set<string>();
 const register=(file:string,title:string,text:string,readOnly=false,modes=ROLE_RESOURCE_MODES)=>{
  const key=keyFor(file);currentKeys.add(key);
 const shared=file.startsWith(path.resolve(process.cwd(),'scripts','shared-skills')+path.sep);
  registerInstructionBlock({key,title,group:'Контекст',scope:file===systemPromptSourceFile()||shared?'command':'role',roles:file===systemPromptSourceFile()||shared?undefined:[role],modes,sourceKind:'file',originRef:file,readOnly},text);
 };
 // AGENTS.md uses the static role.prompt layer; never expose a second resource editor.
 for(const file of loader.getAgentsFiles().agentsFiles)if(path.basename(file.path)!=='AGENTS.md')register(file.path,path.basename(file.path),file.content);
 register(systemPromptSourceFile(),'Общие инструкции — SYSTEM.md',fs.readFileSync(systemPromptSourceFile(),'utf8'),false,['work','resume','reply','review','subtask','chat','voice']);
 for(const source of [...loader.getAppendSystemPromptSources()].filter((x):x is {path:string}=>!!x))register(source.path,path.basename(source.path),fs.readFileSync(source.path,'utf8'),false,['chat']);
 const skills=loader.getSkills().skills;
 for(const skill of skills)register(skill.filePath,'Навык: '+skill.name,fs.readFileSync(skill.filePath,'utf8'));
 const prompts=loader.getPrompts().prompts;
 for(const prompt of prompts)register(prompt.filePath,'Шаблон Pi: '+prompt.name,prompt.content,true,['chat']);
 // Каталог динамический: удалённый файл больше не должен выглядеть действующим.
 for(let i=LAYER_CATALOG.length-1;i>=0;i--) {
  const spec=LAYER_CATALOG[i];
  if(spec.key.startsWith('resource.')&&spec.roles?.includes(role)&&!currentKeys.has(spec.key)&&!(spec.sourceKind==='file'&&fs.existsSync(spec.originRef))) LAYER_CATALOG.splice(i,1);
 }
 registerInstructionBlock({key:'runtime.role_home.'+role,title:'Папка и инструментарий роли',group:'Контекст',scope:'role',roles:[role],modes:ROLE_RESOURCE_MODES,sourceKind:'code',originRef:home.dir,readOnly:true},roleHomeInstruction(role));
 return {skills,diagnostics:loader.getSkills().diagnostics,agentsFiles:loader.getAgentsFiles().agentsFiles,systemPromptSource:loader.getSystemPromptSource(),appendSources:loader.getAppendSystemPromptSources(),prompts};
}

/**
 * Реальные навыки роли (те же пути, что и в чате) — для списка команд.
 * Без регистрации слоёв инструкций: вызов только читает.
 */
export async function listRoleSkills(role: string) {
  const home = ensureRoleHome(role, { refreshSystem: true });
  const loader = new DefaultResourceLoader({
    cwd: home.workspace,
    agentDir: home.dir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noThemes: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalSkillPaths: skillPathsFor(role, true),
    additionalPromptTemplatePaths: [home.prompts],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await loader.reload();
  // Слой навыка зарегистрирован не всегда: блоки ресурсов регистрирует
  // discoverChatResources, а он до первого хода роли мог не выполняться.
  // Тогда composeLayer отдаёт null — читаем текст навыка с диска (D2
  // карточки e11eae7a: реальный навык должен быть доступен сразу).
  return loader.getSkills().skills.map((skill) => {
    const composed = composeLayer(role, keyFor(skill.filePath));
    return {
      name: skill.name,
      description: skill.description ?? "",
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      content: composed?.effective ?? fs.readFileSync(skill.filePath, "utf8"),
    };
  });
}

/** Тот же набор файлов роли; cwd задачи не меняется, executable extensions отключены. */
export async function createTaskResourceLoader(role:string,cwd:string,systemPrompt:string,work?:{title:string;description:string|null;step?:string|null;stageInstructions?:string|null}, sharedChatSkills=false):Promise<ResourceLoader & {disposeResources:()=>void; usedSkills:()=>SkillLabel[]}> {
 const home=ensureRoleHome(role);
 // Навыки и папка роли подключаются и в чате (владелец 07.11.2026): сверка перед работой одинакова везде.
 const discovered=await discoverChatResources(role,sharedChatSkills);
 let snapshotDir:string|undefined;
 const skills=discovered.skills.map(skill=>{
  const effective=composeLayer(role,keyFor(skill.filePath))?.effective ?? fs.readFileSync(skill.filePath,'utf8');
  if(effective===fs.readFileSync(skill.filePath,'utf8')) return skill;
  snapshotDir ??= fs.mkdtempSync(path.join(home.dir,'.task-instructions-'));
  const filePath=path.join(snapshotDir,skill.name+'.md');
  fs.writeFileSync(filePath,effective+'\n\nReference files resolve relative to original directory: '+skill.baseDir,{mode:0o600});
  const loaded=loadSkills({cwd,agentDir:home.dir,skillPaths:[filePath],includeDefaults:false});
  if(!loaded.skills.length) {
   fs.rmSync(snapshotDir,{recursive:true,force:true});
   throw new Error('Некорректный текст навыка '+skill.name+': '+loaded.diagnostics.map(d=>d.message).join('; '));
  }
  return {...loaded.skills[0],baseDir:skill.baseDir};
 });
 // Галочка «Навыки под задачу» (раздел JEV): у роли много навыков — JEV
 // уточняет набор этапа. Не включено/не ответил — кандидаты этапа;
 // у индивидуального/старого плана без пакета сохраняется прежний набор роли.
 const names=stageSkillNames(work?.stageInstructions);
 const candidates=names === null ? skills : skills.filter(s=>names.includes(s.name));
 const missing=names?.filter(name=>!skills.some(s=>s.name===name)) ?? [];
 const keep=work ? await withObservationContext({role},()=>selectSkillsByJev({...work,step:[work.step,work.stageInstructions].filter(Boolean).join("\n")},candidates.map(s=>({name:s.name,description:s.description})),names ?? [])).catch(()=>null) : null;
 const usedSkills=keep ? candidates.filter(s=>keep.has(s.name)) : candidates;
 // Владельцу показываем русские заголовки навыков, а не имена папок (lib/skillCatalog).
 const usedSkillLabels=skillLabels(usedSkills.map(s=>({name:s.name,filePath:(s as {filePath?:string}).filePath ?? null})));
 const stagePrompt=work?.stageInstructions ? "\n\nЗадание текущего этапа:\n"+work.stageInstructions : "";
 const missingPrompt=missing.length ? "\n\nНедоступные навыки этапа: "+missing.join(", ")+". Не утверждай, что они подключены; укажи ограничение в результате." : "";
 const loader=new DefaultResourceLoader({
  cwd,agentDir:home.dir,settingsManager:SettingsManager.inMemory(),
  noExtensions:true,noThemes:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,
  systemPrompt:systemPrompt+'\n\n'+roleHomeInstruction(role)+stagePrompt+missingPrompt,
  appendSystemPrompt:[],
  skillsOverride:()=>({skills:usedSkills,diagnostics:discovered.diagnostics}),
  agentsFilesOverride:()=>({agentsFiles:registryEnabled()?[]:discovered.agentsFiles.map(f=>({path:f.path,content:composeLayer(role,keyFor(f.path))?.effective ?? fs.readFileSync(f.path,'utf8')})).filter(f=>!systemPrompt.includes(f.content))}),
 });
 await loader.reload();
 return Object.assign(loader,{disposeResources:()=>{if(snapshotDir)fs.rmSync(snapshotDir,{recursive:true,force:true});},
  /** Навыки, реально подключённые к этому ходу: имя папки + русский заголовок. */
  usedSkills:()=>usedSkillLabels});
}

/**
 * Системная инструкция хода чата внутри сервера (владелец 02.10.2026: чат
 * без отдельного процесса Pi и без MCP). Тот же текст, что раньше уходил в
 * `--system-prompt` и `--append-system-prompt`: базовая инструкция роли (её
 * SYSTEM.md или штатная Pi), дополнения роли, правила и режим чата.
 * AGENTS.md и навыки подмешивает загрузчик ресурсов (createTaskResourceLoader).
 */
export async function chatSystemPrompt(role:string, mode:ChatWorkMode, cwd:string, chatId?:string, channelOverride?:RuleChannel):Promise<string> {
 // channelOverride — сессия Помощника собирается по своему каналу реестра «session».
 const channel:RuleChannel=channelOverride ?? (chatExecutionMode(chatId)==="card"?"card":"chat");
 if(hasSingleChatSystem(role))return singleChatSystemPrompt(role);
 instructionResources(cwd);
 const discovered=await discoverChatResources(role,true);
 const custom=discovered.systemPromptSource;
 let base:string;
 const useRegistry=registryEnabled();
 if(useRegistry) base=buildRegistryRules(role,channel).text;
 else if(custom) base=renderSystemPrompt(role,ensureRoleHome(role));
 else {
  const sdkRoot=path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  const {buildSystemPrompt}=await import(pathToFileURL(path.join(sdkRoot,'core/system-prompt.js')).href);
  const tools=[createReadToolDefinition,createBashToolDefinition,createEditToolDefinition,createWriteToolDefinition,createGrepToolDefinition,createFindToolDefinition,createLsToolDefinition]
   .map(make=>make(cwd)).filter(t=>mode!=='plan'||PLANNING_TOOLS.includes(t.name));
  base=buildSystemPrompt({cwd,selectedTools:tools.map(t=>t.name),toolSnippets:Object.fromEntries(tools.map(t=>[t.name,t.promptSnippet])),promptGuidelines:tools.flatMap(t=>t.promptGuidelines ?? [])});
 }
 const append:string[]=[];
 // AGENTS.md роли и её папка: при переезде чата внутрь процесса (8986da3) эти
 // два слоя выпали из базовой инструкции — роль не знала ни про свою папку, ни
 // про свои навыки. Возвращены оба, файлом и текстом соответственно.
 if(useRegistry){const agents=roleAgentsSection(role);if(agents)append.push(agents);}
 for(const file of useRegistry?[]:discovered.agentsFiles)append.push('# '+file.path+'\n'+(composeLayer(role,keyFor(file.path))?.effective ?? fs.readFileSync(file.path,'utf8')));
 for(const source of discovered.appendSources)append.push(composeLayer(role,keyFor(source.path))?.effective ?? fs.readFileSync(source.path,'utf8'));
 // Сессия владельца (владелец 12.11.2026: «из реестра почисти всё ненужное
 // для сессии»): после реестра и AGENTS.md — только род и контракт ответа.
 // Правил чат-комнаты (коллеги, кнопки, чек-лист чата), «ключа роли» и
 // повтора папки (она уже в реестре, R010) в сессии нет.
 if(channel==="session"){
  append.push(genderInstruction(role));
  append.push(roleAnswerContract());
  return [base,...append.filter(Boolean)].join('\n\n');
 }
 // Правила карточки в чат не идут (владелец 28.10.2026: чат и карточка — разные режимы).
 append.push(roleHomeInstruction(role));
 append.push(useRegistry?genderInstruction(role):behaviorInstruction(role));
 append.push(renderPromptAddendum('chat',role,ensureRoleHome(role)));
 append.push(chatModeInstruction(mode));
 append.push('ПРОМЕЖУТОЧНЫЕ ПОЯСНЕНИЯ: краткость относится к итогу. Чек-лист (taskflow_work_plan) заводится до начала работы, где больше одного шага. Дальше обычный текст идёт по чек-листу — начал этап, одной фразой что делаешь; закрыл этап, одной-двумя фразами что по нему вышло. Внутри этапа по операциям не отчитывайся: одна операция почти ничего не меняет, и повторять «делаю то же самое» незачем. Вне плана пиши только когда меняешь подход, нашёл значимое, перед содержательной проверкой или упёрся — одной фразой, что именно. Обычный текст должен быть понятен владельцу без открытия инструментов. Не выдумывай прогресс. Не раскрывай внутренние рассуждения. Это правило уточняет запреты пересказа хода работы в старых инструкциях.');
 return [base,...append].join('\n\n');
}
