import db from "../db.js";
import {listActiveInProcessRuns,activeInProcessRun} from "./inProcessRun.js";
import {hasChatSteeringInput} from "./chatSteering.js";

/** Conservative: once any recipient started, the whole message stays. */
export function canWithdrawChatMessage(chatId: string, messageId: string): boolean {
  if (hasChatSteeringInput(messageId)) return false;
  if (listActiveInProcessRuns().some(run => activeInProcessRun(run.taskId,run.subtaskId)?.messengerMessages.has(messageId))) return false;
  if (db.prepare("SELECT 1 FROM slot_topic_inbox WHERE message_id=? AND delivered_at IS NOT NULL LIMIT 1").get(messageId)) return false;
  if (db.prepare(`SELECT 1 FROM chat_message_queue WHERE chat_id=? AND message_id=?
      AND (status IN ('picked','done') OR picked_at IS NOT NULL) LIMIT 1`).get(chatId,messageId)) return false;
  if (db.prepare("SELECT 1 FROM chat_messages WHERE chat_id=? AND reply_to_message_id=? AND COALESCE(message_type,'')!='system' LIMIT 1").get(chatId,messageId)) return false;
  // Coordination cards can live in the origin room, not this room.
  if (db.prepare(`SELECT 1 FROM chat_messages WHERE message_type='system'
      AND json_valid(steps) AND json_extract(steps,'$.coordination.question_id')=?
      AND json_extract(steps,'$.coordination.status') IN ('delivered','answered','working') LIMIT 1`).get(messageId)) return false;
  return true;
}
