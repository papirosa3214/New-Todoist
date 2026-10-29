import db from "../db.js";
import {roleUserId} from "../roleRouting.js";
import {enqueueMessageDelivery} from "./chatQueue.js";

/** Same durable message/outbox mechanism as the integration handoff. Called
 * inside the review transaction: a negative verdict must wake its requester too. */
export function enqueueReviewReturn(reviewId:string):{chatId:string;roleId:string;queueRowId:string;messageId:string}|null {
 const review=db.prepare("SELECT r.*,t.title FROM reviews r JOIN tasks t ON t.id=r.task_id WHERE r.id=?").get(reviewId) as any;
 if(!review)return null;
 const launch=db.prepare("SELECT l.* FROM chat_work_launches l JOIN task_collaboration_plans p ON p.id=l.plan_id WHERE l.task_id=? AND l.status='started' AND p.profile IN ('result_review','code_review') ORDER BY l.rowid DESC LIMIT 1").get(review.task_id) as any;
 if(!launch)return null;
 const roleId=roleUserId(launch.role_key);
 if(!db.prepare("SELECT 1 FROM chat_members m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=? AND m.member_id=? AND c.archived_at IS NULL").get(launch.chat_id,roleId))return null;
 const steps=JSON.parse(launch.steps_json) as {message_id?:string}[];
 const original=steps.find(s=>s.message_id)?.message_id;
 const replyTo=original && db.prepare("SELECT 1 FROM chat_messages WHERE id=? AND chat_id=?").get(original,launch.chat_id)?original:null;
 const messageId="review-return:"+reviewId;
 const text=`@${launch.role_key} Разовая проверка «${review.title}» завершена. Вердикт: ${review.verdict}. ${review.findings??""}\nПроверь замечания и обсуди итог с владельцем в этом разговоре. Автоматическую доработку или повторную проверку не запускай. Положительное ревью кода разрешает отдельный этап интеграции; сам вердикт ещё не означает завершённого слияния.`;
 db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id,task_id,reply_to_message_id,work_mode) VALUES(?,?,?,'chat',?,?,?,'work')").run(messageId,review.reviewer_id,text,launch.chat_id,review.task_id,replyTo);
 db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(launch.chat_id);
 const q=enqueueMessageDelivery({chatId:launch.chat_id,roleId,deliveryId:messageId,messageId,payload:{mode:"work",hop:0,chatOnly:true}});
 return {chatId:launch.chat_id,roleId,queueRowId:q.id,messageId};
}

