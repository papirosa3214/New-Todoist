import db from "../db.js";
import {currentResultVersion} from "../resultVersions.js";
import {integrationResponsibility} from "../lib/integrationResponsibility.js";
import {enqueueMessageDelivery} from "./chatQueue.js";
import crypto from "node:crypto";
import {logEvent} from "../agentState.js";
import {MAX_PLAN_NODES} from "./planMutations.js";

type Handoff={chatId:string;roleId:string;deliveryId:string;messageId:string};
const PREFIX="integration-review:";
/** Called in the review transaction: receipt and outbox commit together. */
export function enqueueIntegrationHandoff(reviewId:string):Handoff|null {
 return db.transaction(()=>{
  const review=db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId) as any;
  if(!review || review.verdict!=="approved")return null;
  const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(review.task_id) as any;
  if(!task || task.parent_id || task.archived_at || task.status!=="active")return null;
  const responsibility=integrationResponsibility(task.id);
  if(!responsibility.valid || responsibility.mode==="not_required" || !responsibility.owner_id)return null;
  const version=currentResultVersion(task.id);
  if(!version || version.id!==review.version_id)return null;
  const recipient=db.prepare("SELECT id,role_key,type FROM users WHERE id=? AND COALESCE(archived,0)=0").get(responsibility.owner_id) as any;
  if(!recipient?.role_key || recipient.type!=="ai")return null;
  // Multiple reviewers may approve the same version: one continuation per
  // accepted version and designated owner, not merely per review HTTP receipt.
  const previous=db.prepare(`SELECT q.id,q.chat_id,q.role_id,q.message_id FROM chat_message_queue q
    JOIN chat_messages m ON m.id=q.message_id JOIN reviews r ON m.id='integration-review:'||r.id
    WHERE r.version_id=? AND r.verdict='approved' AND q.role_id=? ORDER BY q.rowid LIMIT 1`).get(version.id,recipient.id) as any;
  if(previous)return {chatId:previous.chat_id,roleId:previous.role_id,deliveryId:previous.id,messageId:previous.message_id};
  // A single channel per integrator serializes accepted versions across cards.
  const chatId="integration:"+recipient.id, messageId=PREFIX+review.id;
  db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES (?,'Передача принятых изменений','direct',?)").run(chatId,task.creator_id);
  for(const member of [task.creator_id,recipient.id])db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES (?,?)").run(chatId,member);
  const text=`Принят результат «${task.title}», версия ${version.id}. Вы назначены ответственным за интеграцию. Подтвердите получение, проверьте передачу коммитов и выполните интеграцию по действующим правилам. Результат и доказательства: ${version.result}\n${JSON.stringify(version.evidence)}`;
  db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,work_mode) VALUES (?,?,?,'chat',?,?,'work')").run(messageId,review.reviewer_id,text,chatId,task.id);
  db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chatId);
  const queued=enqueueMessageDelivery({chatId,roleId:recipient.id,deliveryId:messageId,messageId,payload:{mode:"work",hop:0,integrationReviewId:review.id}});
  return {chatId,roleId:recipient.id,deliveryId:queued.id,messageId};
 })();
}
/** Only a server-created receipt, for the still-current reviewed version, authorizes this continuation. */
export function integrationHandoffContext(messageId:string,roleId:string):string|null {
 if(!messageId.startsWith(PREFIX))return null;
 const review=db.prepare("SELECT r.* FROM reviews r JOIN chat_messages m ON m.id=? AND m.task_id=r.task_id WHERE r.id=? AND r.verdict='approved'").get(messageId,messageId.slice(PREFIX.length)) as any;
 if(!review)return null;
 const task=db.prepare("SELECT parent_id,status,archived_at FROM tasks WHERE id=?").get(review.task_id) as any;
 if(!task || task.parent_id || task.status!=="active" || task.archived_at)return null;
 const state=integrationResponsibility(review.task_id);
 if(state.mode==="not_required" || !state.valid || state.owner_id!==roleId || currentResultVersion(review.task_id)?.id!==review.version_id)return null;
 const queued=db.prepare("SELECT id FROM chat_message_queue WHERE message_id=? AND role_id=? AND delivery_id=?").get(messageId,roleId,messageId);
 if(!queued)return null;
 return `СЕРВЕРНАЯ ПЕРЕДАЧА ПРИНЯТОГО РЕЗУЛЬТАТА. Карточка ${review.task_id}; принятая версия ${review.version_id}; ревью ${review.id}. Вы — уже назначенный ответственный за интеграцию. Это продолжение существующего поручения, не новое назначение и не новый этап. Сначала подтвердите получение в этой переписке. Прочитайте карточку, принятую версию, отчёты и передачу: ветка/worktree, точные коммиты, проверки, миграции, ограничения. Перенос принятого в main делает система автоматически после вашей сдачи шага — от вас нужен разбор и вердикт, а не git-механика: не правьте main и не делайте merge вручную. Не выполняйте разработку повторно. После положительного ревью ваша задача — разбор и вердикт: сверьте принятые коммиты, миграции и совместимость. Сам перенос в main выполняет система (очередь автослияния: временная копия → слияние → тесты → перенос → уборка) после вашей сдачи шага. Не выполняйте merge вручную и не правьте main. Если перенос упёрся в конфликт, система вернёт конфликт вам в вашу же копию — почините и сдайте шаг снова. Для сервера дождитесь завершения очереди; не прерывайте работающих коллег. Перед изменением перепроверьте актуальность версии и своё назначение. При препятствии сохраните причину и контекст передачи в документах/переписке, не выдавайте ожидание за успех. По завершении укажите настоящий SHA main и проверки; выкладка только в рамках поручения. Не закрывайте карточку за владельца, не добавляйте новый обязательный слот или барьер сдачи.`;
}
export function isIntegrationHandoff(messageId:string):boolean{return messageId.startsWith(PREFIX);}

export const INTEGRATION_STEP_MARKER="[taskflow:integration]";
type IntegrationStep={subtaskId:string;planId:string;slotKey:string};
/**
 * Принятая проверка плана → шаг «Интеграция» в том же плане на назначенного
 * ответственного. Шаг идёт обычным запуском узла: строка в плане, отчёт в
 * ленте, артефакт. Вызывается в транзакции ревью, после закрытия шага
 * проверяющего. null — условий нет или плана нет: остаётся передача через чат.
 */
export function ensureIntegrationPlanStep(reviewId:string):IntegrationStep|null {
 return db.transaction(()=>{
  const review=db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId) as any;
  if(!review || review.verdict!=="approved")return null;
  const task=db.prepare("SELECT * FROM tasks WHERE id=?").get(review.task_id) as any;
  if(!task || task.parent_id || task.archived_at || task.status!=="active")return null;
  const responsibility=integrationResponsibility(task.id);
  if(!responsibility.valid || responsibility.mode==="not_required" || !responsibility.owner_id)return null;
  const version=currentResultVersion(task.id);
  if(!version || version.id!==review.version_id)return null;
  const recipient=db.prepare("SELECT id,role_key,type FROM users WHERE id=? AND COALESCE(archived,0)=0").get(responsibility.owner_id) as any;
  if(!recipient?.role_key || recipient.type!=="ai")return null;
  const plan=db.prepare("SELECT id FROM task_collaboration_plans WHERE task_id=? AND status='approved' ORDER BY revision DESC LIMIT 1").get(task.id) as {id:string}|undefined;
  if(!plan)return null;
  // Только для плана, уже сданного на проверку: иначе закрытие шага интеграции
  // выглядело бы как первая сдача плана и запустило бы проверку заново.
  if(task.agent_state!=="review")return null;
  const tag=`${INTEGRATION_STEP_MARKER} version=${version.id}`;
  // Одна принятая версия — один шаг интеграции, сколько бы проверяющих её ни одобрили.
  const existing=db.prepare(`SELECT s.id,s.plan_node_key FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.collaboration_plan_id=? AND n.instructions LIKE ?`).get(plan.id,tag+"%") as {id:string;plan_node_key:string}|undefined;
  if(existing)return {subtaskId:existing.id,planId:plan.id,slotKey:existing.plan_node_key};
  const reviewer=db.prepare(`SELECT s.plan_node_key,n.iteration FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
    WHERE s.collaboration_plan_id=? AND n.role_key='critic_verifier' AND s.done=1 ORDER BY s.position DESC LIMIT 1`).get(plan.id) as {plan_node_key:string;iteration:number|null}|undefined;
  if(!reviewer)return null;
  if((db.prepare("SELECT COUNT(*) AS n FROM task_collaboration_plan_nodes WHERE plan_id=?").get(plan.id) as {n:number}).n>=MAX_PLAN_NODES)return null;
  const slot=`integration_${crypto.randomUUID().slice(0,8)}`, title="Интеграция принятого результата в основную ветку";
  const contract=JSON.stringify({key:"integration_result",type:"result_pack",format:"json",required_fields:["summary","evidence","document_refs"]});
  db.prepare(`INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,output_artifact_json,instructions,origin,added_by,added_reason,iteration)
    VALUES(?,?,?,?,1,?,?,?,'role',?,?,?)`).run(`tcpn_${crypto.randomUUID()}`,plan.id,slot,recipient.role_key,title,contract,`${tag} review=${review.id}`,recipient.id,"Ответственный за интеграцию присоединился к плану после принятой проверки",reviewer.iteration??0);
  const position=(db.prepare("SELECT COALESCE(MAX(position),0)+1 AS n FROM subtasks WHERE task_id=?").get(task.id) as {n:number}).n;
  const subtaskId=crypto.randomUUID();
  db.prepare("INSERT INTO subtasks(id,task_id,title,position,collaboration_plan_id,plan_node_key,agent_id) VALUES(?,?,?,?,?,?,?)").run(subtaskId,task.id,title,position,plan.id,slot,recipient.id);
  db.prepare("INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition,artifact_key) VALUES(?,?,?,?,'submitted',NULL)").run(`tcpe_${crypto.randomUUID()}`,plan.id,reviewer.plan_node_key,slot);
  db.prepare("UPDATE task_collaboration_plans SET version=version+1 WHERE id=?").run(plan.id);
  logEvent({taskId:task.id,actorId:recipient.id,kind:"plan_integrator_joined",field:plan.id,toValue:slot});
  return {subtaskId,planId:plan.id,slotKey:slot};
 })();
}
function integrationStepNode(subtaskId:string):{instructions:string;task_id:string}|undefined {
 return db.prepare(`SELECT n.instructions,s.task_id FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
   WHERE s.id=? AND n.instructions LIKE ?`).get(subtaskId,INTEGRATION_STEP_MARKER+"%") as {instructions:string;task_id:string}|undefined;
}
export function isIntegrationPlanStep(subtaskId:string):boolean{return Boolean(integrationStepNode(subtaskId));}
/** Поручение шага «Интеграция» для задания роли; null — шаг не интеграционный. */
export function integrationStepContext(subtaskId:string):string|null {
 const node=integrationStepNode(subtaskId);
 if(!node)return null;
 const versionId=/version=(\S+)/.exec(node.instructions)?.[1]??"", reviewId=/review=(\S+)/.exec(node.instructions)?.[1]??"";
 if(currentResultVersion(node.task_id)?.id!==versionId)return `ШАГ ИНТЕГРАЦИИ УСТАРЕЛ. Принятая версия ${versionId} больше не актуальна: у карточки появился новый результат. Ничего не переносите в main; заблокируйте шаг с block_type=needs_input и объясните причину.`;
 return `СЕРВЕРНАЯ ПЕРЕДАЧА ПРИНЯТОГО РЕЗУЛЬТАТА. Карточка ${node.task_id}; принятая версия ${versionId}; ревью ${reviewId}. Вы — назначенный ответственный за интеграцию, этот шаг плана и есть интеграция. Прочитайте карточку, принятую версию, отчёты и передачу: ветка/worktree, точные коммиты, проверки, миграции, ограничения. Не выполняйте разработку повторно. ПЕРЕНОС В main ВЫПОЛНЯЕТ СИСТЕМА после вашей сдачи шага (очередь автослияния: временная копия, слияние, тесты, перенос в main, уборка). Ваша часть — судить, а не переносить: сверьте принятые коммиты с задачей, проверьте миграции и совместимость, и если всё в порядке — сдайте шаг обычной сдачей с настоящими SHA ролевых коммитов. Не правьте main и не делайте merge вручную. Если перенос упёрся в конфликт, система вернёт конфликт вам в эту же копию — чините его здесь и сдавайте шаг снова. Принцип «работа роли видна там же, где её сделали» сохраняется: всё, что вы считаете нужным, должно быть закоммичено в рабочую копию карточки (~/.local/state/taskflow-runs/worktrees/<id>). Проверка коммита поверх main для этого шага отключена.`;
}
