import { beforeSlots, parentPrepResults } from "./branchPhase.js";
import {hasOnlyBranchCoordination} from "./branchCoordination.js";
import { materializeWorkChoices } from "../lib/planWorkSelection.js";
import { settlePreparationOnApproval } from "../lib/preparationGate.js";
import crypto from "node:crypto";
import {getTaskForRead} from "../access.js";
import {applyPlanOps,PlanOpError,type PlanOp} from "./planMutations.js";
import db from "../db.js";
import { roleUserId, roleTitle } from "../roleRouting.js";
import { bumpContextVersion } from "./taskContextVersion.js";
import { logEvent } from "../agentState.js";
import { ensureTaskRoom } from "../lib/projectTopics.js";

type Card = {id:string;title:string;description:string|null;needs_clarification:number;current_revision:number;parent_id:string|null;status:string;agent_state:string|null;project_id:string|null;created_at:string};
type Plan = {id:string;task_id:string;status:string;revision:number;version:number};
type Node = {slot_key:string;role_key:string;origin:string;skipped_at:string|null;source_subtask_id:string|null;expected_result:string};
export function branchRoot(taskId:string):string {
  let id=taskId;const seen=new Set<string>();
  while(true){
    if(seen.has(id) || seen.size>200) throw new Error("Повреждена иерархия задач");seen.add(id);
    const row=db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(id) as {parent_id:string|null}|undefined;
    if(!row?.parent_id) return id;id=row.parent_id;
  }
}
export function branchCards(rootId:string):Card[] {
  return db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN tree ON t.parent_id=tree.id)
    SELECT t.id,t.title,t.description,t.needs_clarification,t.current_revision,t.parent_id,t.status,t.agent_state,t.project_id,t.created_at FROM tasks t JOIN tree ON tree.id=t.id ORDER BY t.id`).all(rootId) as Card[];
}
/** Imported child cards are already work packages, not complete product features. */
export function branchAssignmentRole(title:string):string {
  const text=title.toLowerCase();
  if(/^проверить|^протест|тестирован/.test(text))return 'qa';
  if(/исслед|источник|собрать факт/.test(text))return 'researcher';
  if(/определить|описать|стандарт|правил|руководств|документ/.test(text))return 'analyst';
  if(/внедр|подключ|показать|реализ|исправ|разработ/.test(text))return 'builder';
  return 'analyst';
}

/** Shared bookmark order: root, then breadth-first children newest first. */
export function branchCardNumbers(rootId:string):Map<string,number> {
  const cards=branchCards(rootId),order=[rootId];
  for(let i=0;i<order.length;i++){
    const children=cards.filter(c=>c.parent_id===order[i]).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
    order.push(...children.map(c=>c.id));
  }
  return new Map(order.map((id,index)=>[id,index]));
}

export function selectedCardPlan(taskId:string):Plan|undefined {
  return db.prepare("SELECT * FROM task_collaboration_plans WHERE task_id=? AND status IN ('draft','approved') ORDER BY revision DESC LIMIT 1").get(taskId) as Plan|undefined;
}
function planNodes(planId:string):Node[] {
  return db.prepare("SELECT * FROM task_collaboration_plan_nodes WHERE plan_id=? AND skipped_at IS NULL ORDER BY rowid").all(planId) as Node[];
}
export function responsibleRole(planId:string,root=false):string {
  const nodes=planNodes(planId).filter(n=>n.role_key!=="critic_verifier");
  const edges=db.prepare("SELECT from_slot_key,to_slot_key FROM task_collaboration_plan_edges WHERE plan_id=?").all(planId) as Array<{from_slot_key:string;to_slot_key:string}>;
  const terminals=nodes.filter(n=>!edges.some(e=>e.from_slot_key===n.slot_key && nodes.some(x=>x.slot_key===e.to_slot_key)));
  if(root) return "architect";
  if(terminals.length!==1) throw new Error("У карточки несколько конечных исполнителей — добавьте этап сборки результата");
  return terminals[0].role_key;
}
/** Fill a missing card owner from the final non-review stage; keep explicit assignments. */
export function ensureCardResponsible(taskId:string,planId:string):string|null {
  const task=db.prepare("SELECT assignee_id FROM tasks WHERE id=?").get(taskId) as {assignee_id:string|null}|undefined;
  if(!task || task.assignee_id) return task?.assignee_id??null;
  let role:string;
  try { role=responsibleRole(planId,branchCards(taskId).length>1 && branchRoot(taskId)===taskId); }
  catch { return null; }
  const account=roleUserId(role);
  if(!db.prepare("SELECT 1 FROM users WHERE id=?").get(account)) return null;
  return account;
}
export function branchSnapshot(rootPlanId:string):string {
  const root=db.prepare("SELECT task_id FROM task_collaboration_plans WHERE id=?").get(rootPlanId) as {task_id:string};
  const cards=branchCards(root.task_id);
  const value=cards.map(card=>({card,plan:selectedCardPlan(card.id),
    nodes:selectedCardPlan(card.id) ? db.prepare("SELECT * FROM task_collaboration_plan_nodes WHERE plan_id=? ORDER BY slot_key").all(selectedCardPlan(card.id)!.id) : [],
    edges:selectedCardPlan(card.id) ? db.prepare("SELECT * FROM task_collaboration_plan_edges WHERE plan_id=? ORDER BY from_slot_key,to_slot_key").all(selectedCardPlan(card.id)!.id) : [],
    preparation:db.prepare("SELECT input_version,status,plan_id,snapshot FROM task_preparation_jobs WHERE task_id=? ORDER BY id DESC LIMIT 1").get(card.id),
    dependencies:db.prepare("SELECT depends_on_task_id,policy FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id").all(card.id)}));
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function branchMembership(taskId:string):{root_plan_id:string;root_task_id:string;responsible_role:string}|undefined {
  const member=db.prepare(`SELECT b.root_plan_id,p.task_id root_task_id,b.responsible_role FROM branch_plan_members b
    JOIN task_collaboration_plans p ON p.id=b.root_plan_id JOIN tasks t ON t.id=b.task_id JOIN tasks root ON root.id=p.task_id WHERE t.project_id IS root.project_id AND b.task_id=? AND p.status='approved' ORDER BY p.revision DESC LIMIT 1`).get(taskId) as {root_plan_id:string;root_task_id:string;responsible_role:string}|undefined;
  return member && branchRoot(taskId)===member.root_task_id ? member : undefined;
}

/** One atomic authorization; per-card plans remain the execution/artifact adapters. */
export function approveBranch(rootPlanId:string,ownerId:string,snapshot:string):Array<{id:string;task_id:string}> {
  return db.transaction(()=>{
    const root=db.prepare("SELECT * FROM task_collaboration_plans WHERE id=?").get(rootPlanId) as Plan;
    if(root.status!=="draft") throw new Error("Общий план уже согласован");
    if(branchRoot(root.task_id)!==root.task_id) throw new Error("План ветки согласуется в корневой карточке");
    if(snapshot!==branchSnapshot(root.id)) throw new Error("Состав ветки или планы изменились — просмотрите общий план заново");
    const cards=branchCards(root.task_id);
    validateBranchOrder(root.task_id);
    if(cards.length>200) throw new Error("Ветка превышает 200 карточек");
    const selected=cards.map(card=>({card,plan:card.id===root.task_id ? root : selectedCardPlan(card.id)}));
    for(const {card,plan} of selected){
      if(!plan) throw new Error(`Для «${card.title}» ещё не подготовлен план`);
      if(card.project_id!==cards.find(c=>c.id===root.task_id)!.project_id) throw new Error("Карточки ветки должны находиться в одном проекте");
      const coordinating=card.id===root.task_id && hasOnlyBranchCoordination(card.id);
      const queued=db.prepare("SELECT 1 FROM role_run_jobs WHERE task_id=? AND status IN ('queued','running','retry_wait')").get(card.id);
      if(card.status!=="completed" && ((!coordinating && (card.agent_state || queued)) || plan.status!=="draft")) throw new Error(`«${card.title}» уже работает отдельно — требуется явное объединение`);
      if(!planNodes(plan.id).length) throw new Error(`План «${card.title}» пуст`);
      responsibleRole(plan.id,card.id===root.task_id);
    }
    const teamRoles=new Set(selected.flatMap(x=>planNodes(x.plan!.id).map(n=>n.role_key)));
    teamRoles.add('architect');teamRoles.add('critic_verifier');
    if(teamRoles.size>6)throw new Error('В общей команде больше шести участников, включая Критика. Пересмотрите назначения перед согласованием.');
    // Parent assembly nodes are explicit architects in the agreed root plan.
    const rootNodes=planNodes(root.id).filter(n=>n.role_key!=="critic_verifier");
    if(rootNodes.length===1 && ['linear_import','auto_template','auto_preparation'].includes(rootNodes[0].origin)) db.prepare("UPDATE task_collaboration_plan_nodes SET role_key='architect' WHERE plan_id=? AND slot_key=?").run(root.id,rootNodes[0].slot_key);
    // Архитектора в плане корня может не быть: он подключается сам, когда вся работа ветки
    // закрыта — как итоговый проверяющий (владелец 07.10.2026, planReviewLifecycle.ensureBranchAssembler).
    for(const {card,plan:maybePlan} of selected){
      const plan=maybePlan!;const role=responsibleRole(plan.id,card.id===root.task_id);
      settlePreparationOnApproval(card.id); // подготовка и вопрос модели владельца не блокируют (lib/preparationGate.ts)
      db.prepare("INSERT INTO branch_plan_members(root_plan_id,task_id,plan_id,responsible_role,approved_snapshot) VALUES(?,?,?,?,?)").run(root.id,card.id,plan.id,role,snapshot);
      if(card.status==='completed') continue;
      db.prepare("UPDATE tasks SET current_revision=COALESCE(current_revision,1)+1 WHERE id=?").run(card.id);
      bumpContextVersion(card.id);
      logEvent({taskId:card.id,actorId:ownerId,kind:'branch_card_authorized',field:root.id,toValue:role});
      if(db.prepare("SELECT 1 FROM subtasks WHERE collaboration_plan_id=?").get(plan.id)) throw new Error(`Слоты «${card.title}» уже существуют`);
      let position=(db.prepare("SELECT COALESCE(MAX(position),0) n FROM subtasks WHERE task_id=?").get(card.id) as {n:number}).n;
      materializeWorkChoices(plan.id);
      for(const node of planNodes(plan.id)){
        if(node.source_subtask_id){
          const changed=db.prepare("UPDATE subtasks SET collaboration_plan_id=?,plan_node_key=?,agent_id=? WHERE id=? AND task_id=? AND done=0 AND collaboration_plan_id IS NULL").run(plan.id,node.slot_key,roleUserId(node.role_key),node.source_subtask_id,card.id);
          if(changed.changes!==1) throw new Error("Исходный рабочий слот уже изменился");
        }else db.prepare("INSERT INTO subtasks(id,task_id,title,position,agent_id,collaboration_plan_id,plan_node_key) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(),card.id,node.expected_result,++position,roleUserId(node.role_key),plan.id,node.slot_key);
      }
      db.prepare("UPDATE task_collaboration_plans SET status='superseded' WHERE task_id=? AND status='approved'").run(card.id);
      db.prepare("UPDATE task_collaboration_plans SET status='approved',approved_by=?,approved_at=datetime('now') WHERE id=?").run(ownerId,plan.id);
    }
    for(const {card} of selected) ensureTaskRoom(card.id);
    return selected.filter(x=>x.card.status!=='completed').map(x=>({id:x.plan!.id,task_id:x.card.id}));
  })();
}

export function branchTeamContext(taskId:string):string {
  const root=branchRoot(taskId),cards=branchCards(root);
  if(cards.length<2) return "";
  return ["Общая ветка работы. Архитектор отвечает за итог корневой задачи; порядок запуска определяет сервер.",
    ...cards.map(card=>{
      const member=branchMembership(card.id);
      const binding=member ? db.prepare("SELECT plan_id FROM branch_plan_members WHERE root_plan_id=? AND task_id=?").get(member.root_plan_id,card.id) as {plan_id:string}|undefined : undefined;
      const plan=binding ? db.prepare("SELECT * FROM task_collaboration_plans WHERE id=?").get(binding.plan_id) as Plan : selectedCardPlan(card.id);let responsible="пока не определён";
      if(member) responsible=roleTitle(member.responsible_role);
      else if(plan) try{responsible=roleTitle(responsibleRole(plan.id,card.id===root));}catch{}
      const topic=db.prepare("SELECT id FROM chats WHERE task_id=? AND room_kind='task'").get(card.id) as {id:string}|undefined;
      return `${card.id}: ${card.title}; ответственный: ${responsible}; состояние: ${card.agent_state??card.status}; тема: ${topic?.id??"ещё не создана"}\n`+
        (plan ? planNodes(plan.id).map(n=>`@${n.role_key} [slot: ${n.slot_key}] — ${n.expected_result}`).join("\n") : "План готовится");
    }),
    ...(()=>{const prep=parentPrepResults(taskId);return prep.length ? ["Вводные от родительской карточки (её подготовительные шаги уже сделаны):\n"+prep.map(p=>`@${p.role_key} — ${p.expected_result}: ${(p.result??"результат не записан").slice(0,1500)}`).join("\n")] : [];})(),
    "Недостающий документ запроси у исполнителя предыдущего этапа в его теме, с указанием task_id и slot_key. Ответственный карточки собирает её результат; противоречия между карточками адресуй Архитектору. Переписка и консультации не заменяют сдачу и приёмку артефактов."].join("\n");
}

export function validateBranchOrder(rootId:string):void {
  const cards=branchCards(rootId),ids=new Set(cards.map(c=>c.id));
  const links:Array<[string,string]>=cards.filter(c=>c.parent_id && ids.has(c.parent_id)).map(c=>[c.id,c.parent_id!]);
  for(const card of cards){
    const deps=db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?").all(card.id) as Array<{depends_on_task_id:string}>;
    for(const dep of deps) if(ids.has(dep.depends_on_task_id)) links.push([dep.depends_on_task_id,card.id]);
  }
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(id:string)=>{if(visiting.has(id)) throw new Error("Зависимости ветки образуют цикл: родитель не может предшествовать своему результату");if(done.has(id))return;visiting.add(id);for(const [,to] of links.filter(([from])=>from===id))visit(to);visiting.delete(id);done.add(id);};
  for(const id of ids)visit(id);
}

/** UI projection only; compound keys never enter the executable per-card DAGs. */
export function branchPresentation(rootPlan:any,base:any,presentOne:(p:any)=>any):any {
  const cards=branchCards(rootPlan.task_id);
  if(cards.length<2 || branchRoot(rootPlan.task_id)!==rootPlan.task_id) return base;
  const approved=db.prepare("SELECT task_id,plan_id,responsible_role FROM branch_plan_members WHERE root_plan_id=?").all(rootPlan.id) as Array<{task_id:string;plan_id:string;responsible_role:string}>;
  const views=cards.map(card=>{
    const binding=approved.find(b=>b.task_id===card.id);
    const plan=card.id===rootPlan.task_id ? rootPlan : binding ? db.prepare("SELECT * FROM task_collaboration_plans WHERE id=?").get(binding.plan_id) : selectedCardPlan(card.id);
    let responsible:string|null=binding?.responsible_role??null;
    if(plan&&!responsible)try{responsible=responsibleRole(plan.id,card.id===rootPlan.task_id);}catch{}
    return {card,plan,view:plan ? presentOne(plan) : null,responsible};
  });
  const key=(id:string,slot:string)=>`${id}:${slot}`;
  const nodes=views.flatMap(({card,plan,view,responsible})=>view ? view.nodes.map((n:any)=>{
    const step=db.prepare("SELECT done,agent_state,result FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key=?").get(plan.id,n.slot_key) as {done:number;agent_state:string|null;result:string|null}|undefined;
    const execution=step?.done ? (step.result?.startsWith('changes_requested:') ? 'returned' : 'accepted') : step?.agent_state==='in_progress' ? 'active' : step?.agent_state==='blocked' ? 'blocked' : 'waiting';
    const role=card.id===rootPlan.task_id && rootPlan.status==='draft' && view.nodes.length===1 ? 'architect' : n.role_key;
    return {...n,slot_key:key(card.id,n.slot_key),role_key:role,task_id:card.id,task_title:card.title,execution_state:n.execution_state??execution,source_plan_id:plan.id,source_plan_version:plan.version,source_plan_status:plan.status,source_slot_key:n.slot_key,responsible:role===responsible,rework_of_key:n.rework_of_key ? key(card.id,n.rework_of_key) : null};
  }) : []);
  const edges=views.flatMap(({card,view})=>view ? view.edges.map((e:any)=>({...e,from_slot_key:key(card.id,e.from_slot_key),to_slot_key:key(card.id,e.to_slot_key)})) : []);
  const roots=(id:string)=>{
    const pending=nodes.filter((n:any)=>n.task_id===id&&!['accepted','returned','skipped'].includes(n.execution_state));
    const pool=pending.length?pending:nodes.filter((n:any)=>n.task_id===id);
    return pool.filter((n:any)=>!edges.some((e:any)=>e.to_slot_key===n.slot_key&&pool.some((p:any)=>p.slot_key===e.from_slot_key)));
  };
  const terminals=(id:string)=>nodes.filter((n:any)=>n.task_id===id&&!edges.some((e:any)=>e.from_slot_key===n.slot_key));
  const links:Array<[string,string]>=cards.filter(c=>c.parent_id).map(c=>[c.id,c.parent_id!]);
  for(const card of cards)for(const dep of db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?").all(card.id) as Array<{depends_on_task_id:string}>)links.push([dep.depends_on_task_id,card.id]);
  const cardRoots=new Map(cards.map(c=>[c.id,roots(c.id)])),cardEnds=new Map(cards.map(c=>[c.id,terminals(c.id)]));
  // Подготовительные шаги родителя (branchPhase.ts) стоят ПЕРЕД дочерними:
  // от них идут связи в начало каждой дочерней, а дочерние сходятся уже в
  // итоговые шаги родителя, не в подготовительные.
  const rootId=rootPlan.task_id,before=beforeSlots(rootPlan.id);
  const isPrep=(n:any)=>n.task_id===rootId&&before.has(n.source_slot_key);
  const rootLive=nodes.filter((n:any)=>n.task_id===rootId&&!n.skipped_at);
  const prepPool=rootLive.filter(isPrep),finalPool=rootLive.filter((n:any)=>!isPrep(n));
  const prepEnds=prepPool.filter((n:any)=>!edges.some((e:any)=>e.from_slot_key===n.slot_key&&prepPool.some((p:any)=>p.slot_key===e.to_slot_key)));
  const finalRoots=finalPool.filter((n:any)=>!edges.some((e:any)=>e.to_slot_key===n.slot_key&&finalPool.some((p:any)=>p.slot_key===e.from_slot_key)));
  const link=(a:any,b:any)=>{if(!edges.some((e:any)=>e.from_slot_key===a.slot_key&&e.to_slot_key===b.slot_key))edges.push({from_slot_key:a.slot_key,to_slot_key:b.slot_key,start_condition:'submitted',artifact_key:null});};
  for(const [from,to] of links)for(const a of cardEnds.get(from)??[])for(const b of (before.size&&to===rootId ? finalRoots : cardRoots.get(to)??[]))link(a,b);
  if(before.size)for(const card of cards.filter(c=>c.parent_id===rootId))for(const a of prepEnds)for(const b of cardRoots.get(card.id)??[])link(a,b);
  for(const link of db.prepare("SELECT from_slot,to_task_id,to_slot FROM branch_rework_links WHERE root_plan_id=?").all(rootPlan.id) as Array<{from_slot:string;to_task_id:string;to_slot:string}>) edges.push({from_slot_key:key(rootPlan.task_id,link.from_slot),to_slot_key:key(link.to_task_id,link.to_slot),start_condition:'submitted',artifact_key:null});
  const numbers=branchCardNumbers(rootPlan.task_id);
  const priority=['blocked','returned','active','review','ready','waiting','accepted','skipped'];
  const roles=[...new Set(nodes.filter((n:any)=>!n.skipped_at).map((n:any)=>n.role_key))] as string[];
  const order=['researcher','analyst','designer','builder','qa','architect','critic_verifier'];
  roles.sort((a,b)=>order.indexOf(a)-order.indexOf(b)||a.localeCompare(b));
  const team=roles.map(role=>{
    const work=nodes.filter((n:any)=>n.role_key===role&&!n.skipped_at);
    const ids=[...new Set(work.map((n:any)=>n.task_id))] as string[];
    const states=work.map((n:any)=>n.execution_state);
    return {role_key:role,slot_keys:work.map((n:any)=>n.slot_key),task_ids:ids,
      task_numbers:ids.map(id=>numbers.get(id)!).sort((a,b)=>a-b),
      responsible_numbers:ids.filter(id=>work.some((n:any)=>n.task_id===id&&n.responsible)).map(id=>numbers.get(id)!).sort((a,b)=>a-b),
      execution_state:priority.find(state=>states.includes(state))??'waiting'};
  });
  return {...base,nodes,edges,branch_team:team,branch_root_task_id:rootPlan.task_id,branch_snapshot:branchSnapshot(rootPlan.id),branch_cards:views.map(({card,plan,responsible})=>({...card,tab_number:numbers.get(card.id),plan_id:plan?.id??null,responsible_role:responsible}))};
}

/** Resolve root critic addresses without flattening executable slot identities. */
export function branchReworkRequest(taskId:string,targets:string[]):{rootTargets:string[]|undefined;cards:Array<{taskId:string;slots:string[]}>}|null {
  const member=branchMembership(taskId);
  if(!member || member.root_task_id!==taskId || !targets.some(t=>t.includes(':'))) return null;
  const cards=branchCards(taskId),ids=new Set(cards.map(c=>c.id));
  const links:Array<[string,string]>=cards.filter(c=>c.parent_id).map(c=>[c.id,c.parent_id!]);
  for(const card of cards)for(const dep of db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?").all(card.id) as Array<{depends_on_task_id:string}>)if(ids.has(dep.depends_on_task_id))links.push([dep.depends_on_task_id,card.id]);
  const requested=new Map<string,string[]>();
  for(const target of targets){
    const split=target.indexOf(':'),id=split<0?taskId:target.slice(0,split),slot=split<0?target:target.slice(split+1);
    const binding=branchMembership(id);
    if(!binding || binding.root_plan_id!==member.root_plan_id) throw new Error('Адрес доработки вне согласованной ветки');
    const plan=db.prepare('SELECT plan_id FROM branch_plan_members WHERE root_plan_id=? AND task_id=?').get(member.root_plan_id,id) as {plan_id:string};
    const productive=planNodes(plan.plan_id).filter(n=>n.role_key!=='critic_verifier') as Array<Node&{iteration:number}>;
    const cycle=Math.max(0,...productive.map(n=>n.iteration??0));
    if(!productive.some(n=>n.slot_key===slot&&(n.iteration??0)===cycle))throw new Error('Указан нерабочий этап доработки');
    requested.set(id,[...(requested.get(id)??[]),slot]);
  }
  const reachable=(start:string)=>{const seen=new Set<string>(),queue=[start];for(const id of queue){if(seen.has(id))continue;seen.add(id);for(const [from,to] of links)if(from===id)queue.push(to);}return seen;};
  for(const a of requested.keys())for(const b of requested.keys())if(a!==b&&reachable(a).has(b))throw new Error('Последовательные карточки нельзя возвращать параллельно: выберите первый этап ветки');
  const affected=new Set<string>();for(const id of requested.keys())for(const next of reachable(id))affected.add(next);
  const rework=cards.filter(c=>affected.has(c.id)&&c.id!==taskId).map(card=>{
    const binding=db.prepare('SELECT plan_id FROM branch_plan_members WHERE root_plan_id=? AND task_id=?').get(member.root_plan_id,card.id) as {plan_id:string};
    const nodes=planNodes(binding.plan_id).filter(n=>n.role_key!=='critic_verifier') as Array<Node&{iteration:number}>;
    const latest=Math.max(...nodes.map(n=>n.iteration??0));
    const current=nodes.filter(n=>(n.iteration??0)===latest),edge=db.prepare('SELECT from_slot_key,to_slot_key FROM task_collaboration_plan_edges WHERE plan_id=?').all(binding.plan_id) as Array<{from_slot_key:string;to_slot_key:string}>;
    const slots=requested.get(card.id)??current.filter(n=>!edge.some(e=>e.to_slot_key===n.slot_key&&current.some(p=>p.slot_key===e.from_slot_key))).map(n=>n.slot_key);
    return {taskId:card.id,slots};
  });
  return {rootTargets:requested.get(taskId),cards:rework};
}

/** Edit one projected node atomically against the whole draft snapshot. */
export function editBranchDraft(rootTaskId:string,rootPlanId:string,snapshot:string,ops:PlanOp[],actorId:string){
 return db.transaction(()=>{
  const root=db.prepare("SELECT * FROM task_collaboration_plans WHERE id=? AND task_id=?").get(rootPlanId,rootTaskId) as Plan|undefined;
  if(!root || root.status!=='draft' || branchRoot(rootTaskId)!==rootTaskId)throw new PlanOpError('Общий план уже согласован или недоступен для изменения',409);
  if(snapshot!==branchSnapshot(rootPlanId))throw new PlanOpError('Ветка изменилась — обновите план и повторите изменение',409);
  if(!Array.isArray(ops)||ops.length!==1)throw new PlanOpError('Изменяйте один этап за раз');
  const op=ops[0];if(!op || typeof op!=='object')throw new PlanOpError('Некорректная операция');
  if(op.op!=='update_step' && op.op!=='skip_step' && op.op!=='remove_step')throw new PlanOpError('В общем черновике доступны изменение, пропуск и удаление');
  const address=String(op.slot_key??''),split=address.indexOf(':'),taskId=address.slice(0,split),slot=address.slice(split+1);
  const cards=branchCards(rootTaskId),card=cards.find(c=>c.id===taskId),rootCard=cards.find(c=>c.id===rootTaskId);
  if(split<1 || !card || card.project_id!==rootCard?.project_id || !getTaskForRead(taskId,actorId))throw new PlanOpError('Этап находится вне доступной ветки',403);
  const target=taskId===rootTaskId ? root : selectedCardPlan(taskId);
  if(!target || target.status!=='draft')throw new PlanOpError('Исходный этап уже согласован',409);
  const actual={...op,slot_key:slot};
  if(actual.op==='update_step' && actual.after!==undefined) {
   if(!Array.isArray(actual.after))throw new PlanOpError('after должен быть списком этапов');
   actual.after=actual.after.map(key=>{
   if(!key.startsWith(taskId+':'))throw new PlanOpError('Межкарточные зависимости изменяются отдельно');
   return key.slice(taskId.length+1);
  });
  }
  if((op.op==='skip_step'||op.op==='remove_step') && planNodes(target.id).filter(n=>n.role_key!=='critic_verifier').length<=1)throw new PlanOpError('У карточки должен остаться хотя бы один рабочий этап');
  const result=applyPlanOps(target.id,[actual],{kind:'owner',id:actorId},{baseVersion:target.version});
  if(!planNodes(target.id).length)throw new PlanOpError('У карточки должен остаться хотя бы один рабочий этап');
  return {result,sourcePlanId:target.id,sourceTaskId:taskId};
 })();
}
