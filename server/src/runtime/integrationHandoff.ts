import db from "../db.js";
import {currentResultVersion} from "../resultVersions.js";
import {integrationResponsibility} from "../lib/integrationResponsibility.js";
import {enqueueMessageDelivery} from "./chatQueue.js";

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
 return `СЕРВЕРНАЯ ПЕРЕДАЧА ПРИНЯТОГО РЕЗУЛЬТАТА. Карточка ${review.task_id}; принятая версия ${review.version_id}; ревью ${review.id}. Вы — уже назначенный ответственный за интеграцию. Это продолжение существующего поручения, не новое назначение и не новый этап. Сначала подтвердите получение в этой переписке. Прочитайте карточку, принятую версию, отчёты и передачу: ветка/worktree, точные коммиты, проверки, миграции, ограничения. Не выполняйте разработку повторно. После положительного ревью перенесите только принятые изменения в main, разрешите конфликты и проверьте совместный результат. Если уже интегрировано, проверьте SHA и не переносите повторно. Для сервера дождитесь безопасной очереди; не прерывайте работающих коллег. Перед изменением перепроверьте актуальность версии и своё назначение. При препятствии сохраните причину и контекст передачи в документах/переписке, не выдавайте ожидание за успех. По завершении укажите настоящий SHA main и проверки; выкладка только в рамках поручения. Не закрывайте карточку за владельца, не добавляйте новый обязательный слот или барьер сдачи.`;
}
export function isIntegrationHandoff(messageId:string):boolean{return messageId.startsWith(PREFIX);}
