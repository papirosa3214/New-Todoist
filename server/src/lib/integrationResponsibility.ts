import db from '../db.js';
import type {FastifyInstance} from 'fastify';
import {authOrApiToken} from '../auth.js';
import {getTaskForRead,getTaskForWrite} from '../access.js';
import {logEvent} from '../agentState.js';
import {broadcastTaskEvent} from '../ws.js';

// Роли на интеграции нет (владелец 05.11.2026, `runtime/acceptedMerge.ts`). Поле живёт
// для замороженного веба: он читает и меняет его этими маршрутами, а режим
// `not_required` по-прежнему держит результат вне очереди слияния.
type Choice = {id:string;title:string;role:string};
type Stored = {id:string;integration_mode:string;integration_owner_id:string|null};
function root(taskId:string):string {
 const seen=new Set<string>();let id=taskId;
 while(!seen.has(id)&&seen.size<200){seen.add(id);const row=db.prepare('SELECT parent_id FROM tasks WHERE id=?').get(id) as {parent_id:string|null}|undefined;if(!row?.parent_id)return id;id=row.parent_id;}
 throw new Error('Повреждена иерархия задач');
}
export function integrationResponsibility(taskId:string) {
 const scopeId=root(taskId);
 const task=db.prepare('SELECT id,integration_mode,integration_owner_id FROM tasks WHERE id=?').get(scopeId) as Stored|undefined;
 if(!task)throw new Error('Карточка не найдена');
 const profile=(db.prepare("SELECT profile FROM task_collaboration_plans WHERE task_id=? AND status IN ('draft','approved') ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END,revision DESC LIMIT 1").get(scopeId) as {profile:string}|undefined)?.profile;
 if(profile==="result_review")return {scope_task_id:scopeId,mode:"not_required" as const,owner_id:null,owner_title:null,candidates:[] as Choice[],suggested_owner_id:null,valid:true};
 if(profile==="code_review"){
  const architect=db.prepare("SELECT u.id,COALESCE(r.title,u.name) title FROM users u JOIN roles r ON r.key='architect' WHERE u.id='role_architect' AND COALESCE(u.archived,0)=0 AND r.enabled=1").get() as {id:string;title:string}|undefined;
  const choice=architect?{...architect,role:"architect"}:null;
  return {scope_task_id:scopeId,mode:"auto" as const,owner_id:choice?.id??null,owner_title:choice?.title??null,candidates:choice?[choice]:[],suggested_owner_id:choice?.id??null,valid:!!choice};
 }

 const roles=db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_id=tree.id)
 SELECT DISTINCT n.role_key FROM task_collaboration_plan_nodes n JOIN task_collaboration_plans p ON p.id=n.plan_id JOIN tree ON tree.id=p.task_id
 WHERE p.id=(SELECT pp.id FROM task_collaboration_plans pp WHERE pp.task_id=p.task_id AND pp.status IN ('draft','approved') ORDER BY CASE pp.status WHEN 'draft' THEN 0 ELSE 1 END,pp.created_at DESC,pp.rowid DESC LIMIT 1) AND n.skipped_at IS NULL AND n.role_key<>'critic_verifier'`).all(scopeId) as {role_key:string}[];
 const candidates:Choice[]=[];
 for(const {role_key} of roles){const u=db.prepare("SELECT u.id,COALESCE(r.title,u.name) title FROM users u LEFT JOIN roles r ON r.key=? WHERE u.id=? AND COALESCE(u.archived,0)=0").get(role_key,role_key==='secretary'?'u-secretary':'role_'+role_key) as {id:string;title:string}|undefined;if(u)candidates.push({...u,role:role_key});}
 if(!candidates.length){const u=db.prepare("SELECT u.id,u.name title FROM users u JOIN tasks t ON t.assignee_id=u.id WHERE t.id=? AND COALESCE(u.archived,0)=0").get(scopeId) as {id:string;title:string}|undefined;if(u)candidates.push({...u,role:'executor'});}
 candidates.sort((a,b)=>a.title.localeCompare(b.title));
 const suggested=candidates.find(c=>c.role==='code_orchestrator'||c.role==='orchestrator')??candidates.find(c=>c.role==='architect')??candidates[0]??null;
 // Показать можно только участника команды. Сохранённый агент не из плана заменяется
 // на assigned ?? suggested; сохранённый человек даёт suggested и valid=false.
 const assigned=candidates.find(c=>c.id===task.integration_owner_id)??null;
 // План orchestrated: в очередь слияния результат ведёт шаг сборки оркестратора.
 if(db.prepare("SELECT 1 FROM task_collaboration_plans WHERE task_id=? AND profile='orchestrated' AND status IN ('draft','approved') LIMIT 1").get(scopeId))
  return {scope_task_id:scopeId,mode:'not_required' as const,owner_id:null,owner_title:null,candidates,suggested_owner_id:null,valid:true};
 const stored=task.integration_owner_id?db.prepare('SELECT type FROM users WHERE id=?').get(task.integration_owner_id) as {type:string}|undefined:undefined;
 const stray=task.integration_mode==='auto'&&!!task.integration_owner_id&&!assigned&&!!stored&&stored.type!=='ai';
 const owner=task.integration_mode==='not_required'?null:task.integration_mode==='manual'?assigned:(assigned??suggested);
 const valid=task.integration_mode==='not_required'||(!stray&&!!owner);
 return {scope_task_id:scopeId,mode:task.integration_mode,owner_id:owner?.id??null,owner_title:owner?.title??null,candidates,suggested_owner_id:suggested?.id??null,valid};
}
export function registerIntegrationResponsibilityRoutes(app:FastifyInstance):void {
 app.get<{Params:{id:string}}>('/api/tasks/:id/integration-responsibility',{preHandler:authOrApiToken},async(req:any,reply)=>{
 if(!getTaskForRead(req.params.id,req.userId))return reply.code(404).send({error:'Not found'});
 return integrationResponsibility(req.params.id);
 });
 app.patch<{Params:{id:string}}>('/api/tasks/:id/integration-responsibility',{preHandler:authOrApiToken},async(req:any,reply)=>{
 if(!getTaskForRead(req.params.id,req.userId))return reply.code(404).send({error:'Not found'});
 const state=integrationResponsibility(req.params.id);
 if(!getTaskForWrite(state.scope_task_id,req.userId))return reply.code(403).send({error:'Нет доступа к изменению карточки'});
 const mode=req.body?.mode,owner=req.body?.owner_id??null;
 if(!['auto','manual','not_required'].includes(mode))return reply.code(400).send({error:'Недопустимый способ назначения'});
 if(mode==='manual'&&owner!==null&&!state.candidates.some(c=>c.id===owner))return reply.code(400).send({error:'Выберите участника команды'});
 db.prepare('UPDATE tasks SET integration_mode=?,integration_owner_id=? WHERE id=?').run(mode,mode==='manual'?owner:null,state.scope_task_id);
 logEvent({taskId:state.scope_task_id,actorId:req.userId,kind:'integration_owner_changed',field:'integration_owner_id',toValue:mode==='not_required'?'Не требуется':owner??'Автоматически'});
 const t=getTaskForRead(state.scope_task_id,req.userId) as any;
 broadcastTaskEvent([t.creator_id,t.assignee_id],{type:'task:updated',taskId:state.scope_task_id});
 return integrationResponsibility(req.params.id);
 });
}

export function oneShotReviewInstruction(taskId:string):string|null {
 const plan=db.prepare("SELECT profile FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1").get(taskId) as {profile:string}|undefined;
 if(!plan || !["result_review","code_review"].includes(plan.profile))return null;
 return `Это разовая проверка (${plan.profile}) готового результата по карточке ${taskId}. Сопоставь поручение, предоставленный материал и доказательства. Не выполняй работу заново; дополнительные проверки — только при конкретном сомнении. Сдай один вердикт taskflow_review: approved, changes_requested или blocked. report_markdown — короткий: Принято: что соответствует поручению; либо Проблема: что и где не работает. Исправить: кому и что. Ожидается: проверяемый результат. По 2–3 предложения на проблему; без пяти обязательных разделов общего отчёта. Не вызывай rework и не добавляй циклы доработки. Сервер сохранит любой вердикт и разбудит запросившую роль в исходном чате. Отрицательный вердикт завершает эту проверку. Положительный result_review не требует Git; положительный code_review передаёт принятые коммиты архитектору через существующую интеграцию.`;
}
