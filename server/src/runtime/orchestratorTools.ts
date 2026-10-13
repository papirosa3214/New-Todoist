import {Type} from "typebox";
import db from "../db.js";
import {isOrchestrator} from "../access.js";
import {roleUserId} from "../roleRouting.js";
import {asRole,ToolError} from "./inProcessRun.js";
type Factory=(name:string,description:string,parameters:any,run:(p:any)=>Promise<any>)=>any;
/** Shared controls for work and chat; every call retains the actor's API permissions. */
export function orchestratorTools(role:string,T:Factory):any[]{
 if(!isOrchestrator(roleUserId(role))) return [];
 const id=Type.String({minLength:1});
 const task=Type.Object({task_id:id});
 // Граф плана — ТИПИЗИРОВАН, а не Type.Any. При `Type.Any` массивы в
 // аргументах приходили к серверу завёрнутыми в `{item:{item:{item:[...]}}}`,
 // и parseGraph честно отвечал «нужны от 1 до 16 nodes»: ломалось не тело,
 // а объявление параметра (владелец 12.10.2026, карточка 301196c7).
 const graphNode=Type.Object({
  slot_key:Type.String({description:"Ключ узла в графе, например designer_1"}),
  role_key:Type.String({description:"Роль-исполнитель узла"}),
  expected_result:Type.String({description:"Что узел должен сдать"}),
  required:Type.Optional(Type.Boolean()),
  output_artifact:Type.Optional(Type.Any()),
  source_subtask_id:Type.Optional(Type.String({description:"Уже написанная открытая подзадача, которую узел занимает вместо создания новой"})),
 });
 const graphEdge=Type.Object({
  from_slot_key:Type.String(),
  to_slot_key:Type.String(),
  start_condition:Type.Optional(Type.String({description:"submitted (по умолчанию) или approved"})),
  artifact_key:Type.Optional(Type.String()),
 });
 const graph=Type.Object({
  nodes:Type.Array(graphNode,{description:"1–16 узлов плана"}),
  edges:Type.Optional(Type.Array(graphEdge,{description:"Рёбра DAG между узлами"})),
 });
 const base=(p:any)=>"/api/tasks/"+encodeURIComponent(p.task_id)+"/collaboration-plans";
 const plan=(p:any)=>base(p)+"/"+encodeURIComponent(p.plan_id);
 const pair={task_id:id,plan_id:id};
 const allowed=async(method:"GET"|"POST"|"PATCH"|"PUT",url:string,body?:any)=>{
  if(!isOrchestrator(roleUserId(role)))throw new ToolError("Управление оркестратора отключено");
  return asRole(role,method,url,body);
 };
 return [
 T("taskflow_team_read","Прочитать роли, модели, доступность и реальные инструменты перед подключением исполнителей.",Type.Object({}),()=>allowed("GET","/api/roles")),
 T("taskflow_dependencies","Прочитать зависимости карточки; при явном depends_on_task_ids заменить их с серверной проверкой циклов. Не снимай реальные блокировки ради ширины графа.",Type.Object({task_id:id,depends_on_task_ids:Type.Optional(Type.Array(id)),policies:Type.Optional(Type.Record(Type.String(),Type.String()))}),p=>allowed(p.depends_on_task_ids===undefined?"GET":"PUT","/api/tasks/"+encodeURIComponent(p.task_id)+"/dependencies",p.depends_on_task_ids===undefined?undefined:{depends_on_task_ids:p.depends_on_task_ids,...(p.policies?{policies:p.policies}:{})})),
 T("taskflow_children","Прочитать прямые дочерние карточки с их состоянием и зависимостями. Повторяй для нужной ветви.",task,async p=>{
  await allowed("GET","/api/tasks/"+encodeURIComponent(p.task_id));
  const rows=db.prepare("SELECT id FROM tasks WHERE parent_id=? ORDER BY created_at,id").all(p.task_id) as {id:string}[];
  return Promise.all(rows.map(r=>allowed("GET","/api/tasks/"+encodeURIComponent(r.id))));
 }),
 T("taskflow_assign","Назначить исполнителя карточки. Назначение не запускает работу и не меняет статус.",Type.Object({task_id:id,assignee_id:Type.Union([id,Type.Null()])}),p=>allowed("PATCH","/api/tasks/"+encodeURIComponent(p.task_id),{assignee_id:p.assignee_id})),
 T("taskflow_plan_from_subtasks","Собрать draft-план из уже написанных открытых подзадач карточки: роль каждой подзадачи определяется автоматически, узлы плана ЗАЙМУТ эти строки, а не создадут дубли. Путь, когда список подзадач уже есть, а передать граф нечем. Не запускает. Эндпоинт существовал, но тула на него не было — оркестратор не мог собрать план из своих же подзадач (владелец 12.10.2026).",Type.Object({task_id:id}),p=>allowed("POST","/api/tasks/"+encodeURIComponent(p.task_id)+"/collaboration-plans/suggest-from-subtasks",{})),
 T("taskflow_plan_read","Прочитать планы, версии, граф и снимок ветви перед правкой или утверждением.",task,p=>allowed("GET",base(p))),
 T("taskflow_plan_create","Создать draft с независимыми nodes/edges. Не утверждает и не запускает; сервер валидирует граф.",Type.Object({task_id:id,graph}),p=>allowed("POST",base(p),p.graph)),
 T("taskflow_plan_propose","Предложить серверный draft. Не запускает. После проверь граф и реальные зависимости.",Type.Object({task_id:id,options:Type.Optional(Type.Any())}),p=>allowed("POST",base(p)+"/propose",p.options??{})),
 T("taskflow_plan_edit","Изменить draft по серверному контракту; действующий план меняется через ops.",Type.Object({...pair,graph}),p=>allowed("PATCH",plan(p),p.graph)),
 T("taskflow_plan_ops","Применить штатные операции графа. base_version и branch_snapshot бери из свежего чтения. Правка approved плана может запустить готовые узлы.",Type.Object({...pair,base_version:Type.Integer(),ops:Type.Array(Type.Any()),reason:Type.String(),branch_snapshot:Type.Optional(Type.String())}),p=>allowed("POST",plan(p)+"/ops",{base_version:p.base_version,ops:p.ops,reason:p.reason,...(p.branch_snapshot!==undefined?{branch_snapshot:p.branch_snapshot}:{})})),
 T("taskflow_plan_approve","Явно утвердить подготовленный план и запустить готовые узлы. Только в рамках разрешённой владельцем работы; сохраняет серверные gates, зависимости и branch_snapshot.",Type.Object({...pair,base_version:Type.Integer(),branch_snapshot:Type.Optional(Type.String())}),p=>allowed("POST",plan(p)+"/approve",{base_version:p.base_version,...(p.branch_snapshot!==undefined?{branch_snapshot:p.branch_snapshot}:{})})),
 T("taskflow_plan_proposal_decide","Решить по предложению роли изменить план (approve/reject). Доступно в плане режима «Оркестратор»: op_id, plan_id и task_id — из сообщения о заминке.",Type.Object({...pair,op_id:id,decision:Type.Union([Type.Literal("approve"),Type.Literal("reject")])}),p=>allowed("POST",plan(p)+"/proposals/"+encodeURIComponent(p.op_id)+"/"+p.decision)),
 T("taskflow_node_run","Явно запустить готовый узел существующего утверждённого плана. Сервер проверяет зависимости, попытку и лимиты.",Type.Object({subtask_id:id}),p=>allowed("POST","/api/subtasks/"+encodeURIComponent(p.subtask_id)+"/run",{}))
 ];
}
