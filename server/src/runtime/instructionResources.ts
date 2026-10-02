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
import {ensureRoleHome, roleHomeInstruction} from './roleHome.js';
const ROLE_RESOURCE_MODES: RunMode[] = ['work','resume','reply','review','subtask','chat'];
const keyFor=(file:string)=>'resource.'+crypto.createHash('sha256').update(file).digest('hex').slice(0,20);
const builtinTools=(cwd:string)=>[...new Map([...createCodingTools(cwd),...createReadOnlyTools(cwd)].map(t=>[t.name,t])).values()];
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
export async function chatInstructionArgs(role:string, configPath:string, mode:ChatWorkMode="work", cwd=ensureRoleHome(role).workspace):Promise<string[]> {
 instructionResources(cwd);
 const dir=path.dirname(configPath);const prefix=path.basename(configPath);
 const discovered=await discoverChatResources(role);
 const append=discovered.agentsFiles.map(x=>'# '+x.path+'\n'+composeLayer(role,keyFor(x.path))!.effective);
 for(const source of discovered.appendSources)append.push(composeLayer(role,keyFor(source.path))!.effective);
 append.push(composeLayer(role,'rules')!.effective);
 append.push(chatModeInstruction(mode));
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
   fs.writeFileSync(snapshot,composeLayer(role,keyFor(skill.filePath))!.effective+'\n\nReference files resolve relative to original directory: '+skill.baseDir,{mode:0o600});
   args.push('--skill',snapshot);
  }
 }
 const descriptionMap=Object.fromEntries(builtinTools(cwd).map(t=>[t.name,composeLayer(role,'tool.builtin.'+t.name)!.effective]));
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
 const base=custom ? composeLayer(role,keyFor(custom.path))!.effective : buildSystemPrompt({
  cwd,selectedTools:tools.map(t=>t.name),
  toolSnippets:Object.fromEntries(tools.map(t=>[t.name,t.promptSnippet])),
  promptGuidelines:tools.flatMap(t=>t.promptGuidelines ?? []),
 });
 const sys=configPath+'.system.txt';fs.writeFileSync(sys,base,{mode:0o600});args.push('--system-prompt',sys);
 return args;
}

/** Same SDK discovery as chat, with executable extensions disabled while inspecting resources. */
export async function discoverChatResources(role:string) {
 const home=ensureRoleHome(role);
 const loader=new DefaultResourceLoader({
  cwd:home.workspace,agentDir:home.dir,settingsManager:SettingsManager.inMemory(),
  noExtensions:true,noThemes:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,
  additionalSkillPaths:[home.skills],additionalPromptTemplatePaths:[home.prompts],
  agentsFilesOverride:()=>({agentsFiles:[{path:home.agents,content:fs.readFileSync(home.agents,'utf8')}]}),
 });
 await loader.reload();
 const currentKeys=new Set<string>();
 const register=(file:string,title:string,text:string,readOnly=false,modes=ROLE_RESOURCE_MODES)=>{
  const key=keyFor(file);currentKeys.add(key);
  registerInstructionBlock({key,title,group:'Контекст',scope:'role',roles:[role],modes,sourceKind:'file',originRef:file,readOnly},text);
 };
 for(const file of loader.getAgentsFiles().agentsFiles)register(file.path,path.basename(file.path),file.content);
 for(const source of [loader.getSystemPromptSource(),...loader.getAppendSystemPromptSources()].filter((x):x is {path:string}=>!!x))register(source.path,path.basename(source.path),fs.readFileSync(source.path,'utf8'),false,['chat']);
 const skills=loader.getSkills().skills;
 for(const skill of skills)register(skill.filePath,'Навык: '+skill.name,fs.readFileSync(skill.filePath,'utf8'));
 const prompts=loader.getPrompts().prompts;
 for(const prompt of prompts)register(prompt.filePath,'Шаблон Pi: '+prompt.name,prompt.content,true,['chat']);
 // Каталог динамический: удалённый файл больше не должен выглядеть действующим.
 for(let i=LAYER_CATALOG.length-1;i>=0;i--) {
  const spec=LAYER_CATALOG[i];
  if(spec.key.startsWith('resource.')&&spec.roles?.includes(role)&&!currentKeys.has(spec.key)) LAYER_CATALOG.splice(i,1);
 }
 registerInstructionBlock({key:'runtime.role_home.'+role,title:'Папка и инструментарий роли',group:'Контекст',scope:'role',roles:[role],modes:ROLE_RESOURCE_MODES,sourceKind:'code',originRef:home.dir,readOnly:true},roleHomeInstruction(role));
 return {skills,diagnostics:loader.getSkills().diagnostics,agentsFiles:loader.getAgentsFiles().agentsFiles,systemPromptSource:loader.getSystemPromptSource(),appendSources:loader.getAppendSystemPromptSources(),prompts};
}

/** Тот же набор файлов роли; cwd задачи не меняется, executable extensions отключены. */
export async function createTaskResourceLoader(role:string,cwd:string,systemPrompt:string):Promise<ResourceLoader & {disposeResources:()=>void}> {
 const home=ensureRoleHome(role);
 const discovered=await discoverChatResources(role);
 let snapshotDir:string|undefined;
 const skills=discovered.skills.map(skill=>{
  const effective=composeLayer(role,keyFor(skill.filePath))!.effective;
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
 const loader=new DefaultResourceLoader({
  cwd,agentDir:home.dir,settingsManager:SettingsManager.inMemory(),
  noExtensions:true,noThemes:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,
  systemPrompt:systemPrompt+'\n\n'+roleHomeInstruction(role),
  appendSystemPrompt:[],
  skillsOverride:()=>({skills,diagnostics:discovered.diagnostics}),
  agentsFilesOverride:()=>({agentsFiles:discovered.agentsFiles.map(f=>({path:f.path,content:composeLayer(role,keyFor(f.path))!.effective}))}),
 });
 await loader.reload();
 return Object.assign(loader,{disposeResources:()=>{if(snapshotDir)fs.rmSync(snapshotDir,{recursive:true,force:true});}});
}
