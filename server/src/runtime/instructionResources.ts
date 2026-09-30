import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getAgentDir, createCodingTools, createReadOnlyTools, DefaultResourceLoader} from '@earendil-works/pi-coding-agent';
import {registerInstructionBlock, composeLayer} from '../lib/roleContextResolver.js';
import {INSTRUCTION_DEFAULTS} from './instructionDefaults.js';
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
 registerInstructionBlock({key:'runtime.boundaries',title:'Программные ограничения',group:'Возможности',scope:'role',modes:['work','chat','voice','summary'],sourceKind:'code',originRef:'auth/access/agentState + Pi SDK',readOnly:true},'Разрешения API, allowlist MCP, схемы инструментов и переходы состояний проверяются кодом. Текст инструкции не меняет эти ограничения. В задачах skills/extensions/AGENTS не загружаются. В чате навыки, расширения и prompt templates Pi загружаются из configured global/project resources; расширения могут добавлять правила через SDK hooks. Их программный код меняется в источнике и не заменяется текстом.');
 return specs;
}
/** Freeze the exact text sources once per chat turn, leave SDK tool schema and extensions intact. */
export async function chatInstructionArgs(role:string, configPath:string):Promise<string[]> {
 instructionResources();
 const dir=path.dirname(configPath);const prefix=path.basename(configPath);
 const discovered=await discoverChatResources();
 const append=discovered.agentsFiles.map(x=>'# '+x.path+'\n'+composeLayer(role,keyFor(x.path))!.effective);
 for(const source of discovered.appendSources)append.push(composeLayer(role,keyFor(source.path))!.effective);
 append.push(composeLayer(role,'rules')!.effective);
 const file=path.join(dir,prefix+'.prompt.txt');
 fs.writeFileSync(file,append.join('\n\n'),{mode:0o600});
 const args=['--no-context-files','--append-system-prompt',file];
 // Snapshot skills without modifying external/global files. Original base directories are explicit.
 if(discovered.skills.length) {
  args.push('--no-skills');
  const skillDir=configPath+'.skills';fs.mkdirSync(skillDir,{recursive:true,mode:0o700});
  for(const skill of discovered.skills) {
   const snapshot=path.join(skillDir,path.basename(skill.filePath)+'-'+crypto.createHash('sha256').update(skill.filePath).digest('hex').slice(0,12)+'.md');
   fs.writeFileSync(snapshot,composeLayer(role,keyFor(skill.filePath))!.effective+'\n\nReference files resolve relative to original directory: '+skill.baseDir,{mode:0o600});
   args.push('--skill',snapshot);
  }
 }
 const descriptionMap=Object.fromEntries(builtinTools(process.cwd()).map(t=>[t.name,composeLayer(role,'tool.builtin.'+t.name)!.effective]));
 const extension=configPath+'.tools.mjs';
 fs.writeFileSync(extension,`import * as sdk from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
 export default function(api) { const descriptions=${JSON.stringify(descriptionMap)};
 for (const make of [sdk.createReadToolDefinition,sdk.createBashToolDefinition,sdk.createEditToolDefinition,sdk.createWriteToolDefinition,sdk.createGrepToolDefinition,sdk.createFindToolDefinition,sdk.createLsToolDefinition]) {
  const tool=make(process.cwd()); api.registerTool({...tool,description:descriptions[tool.name] ?? tool.description});
 }}
`,{mode:0o600});
 args.push('--extension',extension);
 const custom=discovered.systemPromptSource;
 if(custom){const sys=configPath+'.system.txt';fs.writeFileSync(sys,composeLayer(role,keyFor(custom.path))!.effective,{mode:0o600});args.push('--system-prompt',sys);}
 return args;
}

/** Same SDK discovery as chat, with executable extensions disabled while inspecting resources. */
export async function discoverChatResources() {
 const loader=new DefaultResourceLoader({cwd:process.cwd(),agentDir:getAgentDir(),noExtensions:true,noThemes:true});
 await loader.reload();
 for(const file of loader.getAgentsFiles().agentsFiles)registerInstructionBlock({key:keyFor(file.path),title:path.basename(file.path),group:'Контекст',scope:'command',modes:['chat'],sourceKind:'file',originRef:file.path,readOnly:false},file.content);
 for(const source of [loader.getSystemPromptSource(),...loader.getAppendSystemPromptSources()].filter((x):x is {path:string}=>!!x))registerInstructionBlock({key:keyFor(source.path),title:path.basename(source.path),group:'Контекст',scope:'command',modes:['chat'],sourceKind:'file',originRef:source.path,readOnly:false},fs.readFileSync(source.path,'utf8'));
 const skills=loader.getSkills().skills;
 for(const skill of skills)registerInstructionBlock({key:keyFor(skill.filePath),title:'Навык: '+skill.name,group:'Контекст',scope:'command',modes:['chat'],sourceKind:'file',originRef:skill.filePath,readOnly:false},fs.readFileSync(skill.filePath,'utf8'));
 for(const prompt of loader.getPrompts().prompts)registerInstructionBlock({key:keyFor(prompt.filePath),title:'Шаблон Pi: '+prompt.name,group:'Контекст',scope:'command',modes:['chat'],sourceKind:'file',originRef:prompt.filePath,readOnly:true},prompt.content);
 return {skills,diagnostics:loader.getSkills().diagnostics,agentsFiles:loader.getAgentsFiles().agentsFiles,systemPromptSource:loader.getSystemPromptSource(),appendSources:loader.getAppendSystemPromptSources()};
}
