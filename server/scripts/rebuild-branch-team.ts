import db from '../src/db.js';
import {branchCards,branchSnapshot,selectedCardPlan,branchAssignmentRole} from '../src/runtime/branchPlan.js';
import {createDraftPlan} from '../src/routes/task-collaboration-plans.js';
import {logEvent} from '../src/agentState.js';
const rootId=process.argv[2],apply=process.argv.includes('--apply');
if(!rootId)throw new Error('root task id required');
const root=selectedCardPlan(rootId);if(!root||root.status!=='draft')throw new Error('Only a draft branch can be rebuilt');
const snapshot=branchSnapshot(root.id),cards=branchCards(rootId);
const candidates=cards.filter(c=>c.id!==rootId&&!cards.some(child=>child.parent_id===c.id)).flatMap(card=>{
 const plan=selectedCardPlan(card.id);if(!plan||plan.status!=='draft'||plan.version>1||card.agent_state)return [];
 const nodes=db.prepare('SELECT origin,source_subtask_id FROM task_collaboration_plan_nodes WHERE plan_id=?').all(plan.id) as any[];
 if(!nodes.length||nodes.some(n=>n.origin!=='linear_import'||n.source_subtask_id))return [];
 if(db.prepare('SELECT 1 FROM subtasks WHERE collaboration_plan_id=?').get(plan.id))return [];
 return [{card,plan,role:branchAssignmentRole(card.title)}];
});
const work=()=>{
 if(branchSnapshot(root.id)!==snapshot)throw new Error('Branch changed during rebuild');
 const owner=(db.prepare('SELECT created_by FROM task_collaboration_plans WHERE id=?').get(root.id) as any).created_by;
 for(const {card,plan,role} of candidates){
  const replacement=createDraftPlan(card.id,owner,'single_executor','Поручение общей команды; сохраняется исходная постановка карточки.',null,{
   nodes:[{slot_key:'work',role_key:role,required:true,expected_result:card.title,output_artifact:{key:'card_result',type:'result_pack',format:'json',required_fields:['summary','evidence','document_refs']},source_subtask_id:null}],edges:[]});
  db.prepare("UPDATE task_collaboration_plan_nodes SET origin='branch_assignment',instructions=? WHERE plan_id=?").run(card.description,replacement.id);
  logEvent({taskId:card.id,actorId:owner,kind:'branch_team_rebuilt',field:root.id,fromValue:plan.id,toValue:replacement.id});
 }
 db.prepare('UPDATE task_collaboration_plans SET version=version+1 WHERE id=?').run(root.id);
};
if(apply && candidates.length)db.transaction(work)();
console.log(JSON.stringify({mode:apply?'applied':'preview',rootId,changed:candidates.map(c=>({id:c.card.id,title:c.card.title,role:c.role,previousPlan:c.plan.id})),snapshot:branchSnapshot(root.id)},null,2));
