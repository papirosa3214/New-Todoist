import db from '../db.js';
const norm=(s:string)=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
export function workChoices(planId:string):any[] {
 return db.prepare(`SELECT n.slot_key,n.source_subtask_id,n.expected_result,n.instructions,n.work_choice,n.original_title,
 s.title AS source_title FROM task_collaboration_plan_nodes n LEFT JOIN subtasks s ON s.id=n.source_subtask_id WHERE n.plan_id=? AND n.skipped_at IS NULL`).all(planId).map((n:any)=>{
 const original=n.original_title??n.source_title;
 const planned=n.instructions?.trim()||n.expected_result;
 return {...n,original_title:original??null,planned_work:planned,requires_choice:!!n.source_subtask_id&&!!original&&norm(original)!==norm(planned)};
 });
}
export function validateWorkChoices(planId:string):void {
 const unresolved=workChoices(planId).filter(n=>n.requires_choice&&!n.work_choice);
 if(unresolved.length)throw new Error('Выберите исходную или плановую работу для каждой подзадачи');
}
export function selectedWork(planId:string,slot:string):string {
 const n=workChoices(planId).find(n=>n.slot_key===slot);
 if(!n)throw new Error('Слот не найден');
 return n.work_choice==='original'?n.original_title:n.planned_work;
}
export function materializeWorkChoices(planId:string):void {
 validateWorkChoices(planId);
 for(const n of workChoices(planId)){
  if(!n.source_subtask_id)continue;
  db.prepare('UPDATE task_collaboration_plan_nodes SET original_title=COALESCE(original_title,?) WHERE plan_id=? AND slot_key=?').run(n.original_title,planId,n.slot_key);
  const chosen=selectedWork(planId,n.slot_key);
  db.prepare('UPDATE task_collaboration_plan_nodes SET instructions=? WHERE plan_id=? AND slot_key=?').run(chosen,planId,n.slot_key);
  // Original text remains in the plan snapshot; reuse the same execution row.
  db.prepare('UPDATE subtasks SET title=? WHERE id=? AND collaboration_plan_id IS NULL AND done=0').run(chosen,n.source_subtask_id);
 }
}
