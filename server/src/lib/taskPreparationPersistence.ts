// Адаптер записи: отдельно от анализа и отдельно от допуска/исполнения.
import db from "../db.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { createDraftPlan } from "../routes/task-collaboration-plans.js";
import { validatePreparation, type TaskPreparation } from "./taskPreparation.js";

export function persistPreparedPlan(taskId:string,actorId:string,raw:TaskPreparation):void {
  const preparation=validatePreparation(raw,ROLE_NAMES);
  if (preparation.question) db.prepare("UPDATE tasks SET needs_clarification=1,clarification_question=? WHERE id=?").run(preparation.question,taskId);
  if (preparation.representation==="checklist") {
    const stream=preparation.workstreams[0];
    if (stream.role) db.prepare("UPDATE tasks SET machine_selected_role=? WHERE id=? AND assignee_id IS NULL AND owner_selected_role IS NULL").run(stream.role,taskId);
    const row=db.prepare("SELECT description FROM tasks WHERE id=?").get(taskId) as {description:string|null};
    const criterion=`✅ РЕЗУЛЬТАТ: ${stream.result}`;
    if (!row.description?.includes(criterion)) db.prepare("UPDATE tasks SET description=? WHERE id=?").run([row.description,criterion].filter(Boolean).join("\n\n"),taskId);
  }
  if (preparation.representation!=="role_plan") return;
  const subtasks=db.prepare("SELECT id,title FROM subtasks WHERE task_id=? AND done=0 AND collaboration_plan_id IS NULL ORDER BY position,rowid").all(taskId) as Array<{id:string;title:string}>;
  if (subtasks.length!==preparation.workstreams.length || subtasks.some((s,i)=>s.title!==preparation.workstreams[i].title)) throw new Error("Подзадачи не совпадают с подготовленным планом");
  const nodes=preparation.workstreams.map((w,i)=>({slot_key:w.key,role_key:w.role!,required:true,expected_result:w.result,output_artifact:null,source_subtask_id:subtasks[i].id}));
  const edges=preparation.workstreams.flatMap(w=>w.depends_on.map(dep=>({from_slot_key:dep,to_slot_key:w.key,start_condition:"submitted",artifact_key:null})));
  const plan=createDraftPlan(taskId,actorId,"manual",preparation.reason,null,{nodes,edges});
  // Умная параллелизация (30.09.2026): «наша» подзадача становится слотом
  // плана. По умолчанию используем planned_work (новое описание работы
  // из постановки), а не original (старое название подзадачи) — иначе
  // validateWorkChoices() блокирует approve 409 «Выберите исходную или
  // плановую работу для каждой подзадачи» (5 красных в группе
  // «Intake / preparation», 12.10.2026).
  //
  // Но если у подготовки остался вопрос (например, про совместимость
  // независимых потоков) — default «planned» обходит 409 approve там,
  // где владелец ещё не разрешил уточнение. Поэтому работает выбор
  // «planned» ТОЛЬКО когда вопросов нет.
  if(!preparation.question){
    db.prepare("UPDATE task_collaboration_plan_nodes SET work_choice='planned' WHERE plan_id=? AND source_subtask_id IS NOT NULL").run(plan.id);
  }
  for (const w of preparation.workstreams) db.prepare("UPDATE task_collaboration_plan_nodes SET origin='task_preparation',instructions=? WHERE plan_id=? AND slot_key=?").run(JSON.stringify(w),plan.id,w.key);
  // Поле для веба (lib/integrationResponsibility): code_orchestrator/architect, иначе
  // первый исполнитель. Пока у плана остался вопрос, не назначаем.
  if(!preparation.question){
    const roles=db.prepare(`SELECT DISTINCT role_key FROM task_collaboration_plan_nodes WHERE plan_id=?`).all(plan.id) as Array<{role_key:string}>;
    const userIdForRole=(role:string):string|null=>{
      if(role==='secretary')return 'u-secretary';
      return 'role_'+role;
    };
    const pick=roles.find(r=>r.role_key==='code_orchestrator'||r.role_key==='architect')??(roles[0]??null);
    if(pick){
      db.prepare("UPDATE tasks SET integration_owner_id=? WHERE id=?").run(userIdForRole(pick.role_key),taskId);
    }
  }
}
