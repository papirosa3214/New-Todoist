import type {FastifyInstance} from 'fastify';
import db from '../db.js';
import {authOrApiToken} from '../auth.js';
import {isOwner} from '../access.js';
import {roleUserId} from '../roleRouting.js';
import {taskflowTools} from '../runtime/inProcessRun.js';
import {instructionResources, discoverChatResources} from '../runtime/instructionResources.js';
import {applyOverride, compose, composeLayer, composeTeamText, getLayerSpec, globalVersionForRole, listHistory, LAYER_CATALOG, readHistoryEntry, revision, InstructionConflict, type ComposedLayer, type RunMode} from '../lib/roleContextResolver.js';
const MODES=new Set(['work','resume','reply','review','subtask','chat','voice','summary']);
function known(role:string) { return !!db.prepare('SELECT 1 FROM roles WHERE key=?').get(role); }
function json(l:ComposedLayer,role?:string,ownerId?:string) { return {layer:l.layer,effective:l.effective,source:l.source,origin:l.origin,version:l.version,role_version:l.roleVersion,command_version:l.commandVersion,team_text:role?composeTeamText(role,l.layer,ownerId):undefined,updated_at:l.updatedAt,updated_by:l.updatedBy,read_only:l.readOnly,modes:l.modes,title:l.title,group:l.group,default_text:l.defaultText,placeholders:l.placeholders}; }
function block(l:ComposedLayer,role:string,ownerId?:string) { return {id:l.layer,title:l.title ?? l.layer,group:l.group ?? 'Возможности',scope:l.source,source:l.origin.ref,editable:!l.readOnly,text:l.effective,teamText:composeTeamText(role,l.layer,ownerId),defaultText:l.defaultText,version:l.version,commandVersion:l.commandVersion,modes:l.modes,placeholders:l.placeholders,allowsTeam:getLayerSpec(l.layer)?.scope==='command'}; }
function version(req:any):number|null {
 const raw=req.headers['if-match']?.replace(/^"|"$/g,'') ?? req.body?.if_match ?? req.body?.expectedVersion;
 if (raw===undefined) return null;
 const n=Number(raw); return Number.isSafeInteger(n)&&n>=0?n:null;
}
export function registerRuntimeContextRoutes(app:FastifyInstance) {
 const owner=async(req:any,reply:any)=>{await authOrApiToken(req,reply); if(reply.sent)return; if(!isOwner(req.userId))return reply.code(403).send({error:'контекст ролей доступен только владельцу'});};
 const init=async(role:string)=>{taskflowTools(role,null); instructionResources(); await discoverChatResources();};
 app.get('/api/runtime/context/catalog',{preHandler:owner},async()=>{await init('builder');return {layers:LAYER_CATALOG};});
 app.get<{Querystring:{role?:string;mode?:string}}>('/api/runtime/context',{preHandler:owner},async(req,reply)=>{
  const role=req.query.role ?? ''; const mode=req.query.mode ?? 'work';
  if(!known(role))return reply.code(404).send({error:'роль не найдена'});
  if(!MODES.has(mode))return reply.code(422).send({error:'неизвестный режим'});
  await init(role); return {role,mode,version:globalVersionForRole(role),layers:compose(role,mode as RunMode).map(l=>json(l,role,(req as any).userId))};
 });
 app.get<{Params:{role:string}}>('/api/roles/:role/runtime-context',{preHandler:owner},async(req:any,reply)=>{
  const role=req.params.role;if(!known(role))return reply.code(404).send({error:'роль не найдена'});
  await init(role); const layers=LAYER_CATALOG.map(s=>composeLayer(role,s.key,(req as any).userId)).filter((l):l is ComposedLayer=>!!l);
  return {role,canEdit:true,blocks:layers.map(l=>block(l,role,(req as any).userId)),layers:layers.map(l=>({id:l.layer,title:l.title ?? l.layer,scope:l.modes.join(', '),source:l.origin.ref,editable:!l.readOnly,text:l.effective})),notice:'Правки действуют в следующем запуске. История сессии сохраняется и может содержать прежние инструкции. Текст не меняет права и схемы инструментов.'};
 });
 app.get<{Params:{role:string;layer:string};Querystring:{scope?:string}}>('/api/runtime/context/:role/:layer',{preHandler:owner},async(req,reply)=>{
  const {role,layer}=req.params;if(!known(role))return reply.code(404).send({error:'роль не найдена'});await init(role);
  const l=composeLayer(role,layer,(req as any).userId);if(!l)return reply.code(404).send({error:'слой не найден'});
  const scope=req.query.scope==='command'?'command':'role';return {...json(l),history:listHistory(scope,layer.startsWith("owner.")?"owner:"+(req as any).userId:role,layer)};
 });
 const mutate=async(req:any,reply:any,action:'set'|'reset'|'restore')=>{
  const {role,layer}=req.params;if(!known(role))return reply.code(404).send({error:'роль не найдена'});await init(role);
  const spec=getLayerSpec(layer);if(!spec || !composeLayer(role,layer,(req as any).userId))return reply.code(404).send({error:'слой не найден'});
  if(spec.readOnly)return reply.code(422).send({error:'слой только для просмотра'});
  const scope=req.body?.scope==='command' || req.body?.scope==='team'?'command':'role';
  if(req.body?.scope && !['role','command','team',`role:${role}`].includes(req.body.scope))return reply.code(422).send({error:'недопустимая область'});
  if(scope==='command'&&spec.scope!=='command')return reply.code(422).send({error:'слой только для роли'});
  const expected=version(req);if(expected===null)return reply.code(428).send({error:'If-Match / expectedVersion обязателен'});
  let text=req.body?.text;
  if(action==='reset') text='';
  if(action==='restore') {
   const v=req.body?.version ?? req.body?.historyVersion;
   if(!Number.isSafeInteger(v)||v<0)return reply.code(422).send({error:'нужна версия истории'});
   const entry=readHistoryEntry(scope,layer.startsWith("owner.")?"owner:"+req.userId:role,layer,v);if(!entry)return reply.code(404).send({error:'версия не найдена'});
   text=entry.text;
   if(entry.action==='reset')action='reset';
  }
  if(typeof text!=='string')return reply.code(422).send({error:'нужен текст инструкции'});
  try {
   const l=applyOverride({scope,roleKey:role,layer,text,action,expectedVersion:expected,sourceKind:spec.sourceKind,sourceRef:spec.originRef,createdBy:req.userId});
   return {...json(l),block:block(l,role,req.userId),scope_version:revision(scope,role,layer,req.userId)};
  } catch(error) {
   if(error instanceof InstructionConflict)return reply.code(409).send({error:error.message,current:json(composeLayer(role,layer,(req as any).userId)!),current_version:revision(scope,role,layer,req.userId)});
   return reply.code(422).send({error:(error as Error).message});
  }
 };
 app.patch('/api/runtime/context/:role/:layer',{preHandler:owner},async(req,reply)=>mutate(req,reply,'set'));
 app.post('/api/runtime/context/:role/:layer/reset',{preHandler:owner},async(req,reply)=>mutate(req,reply,'reset'));
 app.post('/api/runtime/context/:role/:layer/restore',{preHandler:owner},async(req,reply)=>mutate(req,reply,'restore'));
 // SDK internal snapshot: role can read only its own MCP descriptions/rules.
 app.get<{Params:{role:string}}>('/api/agent/instructions/:role',{preHandler:authOrApiToken},async(req:any,reply)=>{
  const role=req.params.role;if(!known(role))return reply.code(404).send({error:'роль не найдена'});
  if(req.userId!==roleUserId(role)&&!isOwner(req.userId))return reply.code(403).send({error:'чужая роль'});
  await init(role);return {role,rules:composeLayer(role,'rules')!.effective,blocks:compose(role,'chat').filter(l=>l.layer.startsWith('tool.')||l.layer==='mcp.initialize').map(l=>({id:l.layer,text:l.effective}))};
 });
}
