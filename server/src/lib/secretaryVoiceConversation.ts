import {chatExecutionMode,isCardHandoffCommand} from "../runtime/chatExecutionMode.js";
import { createHash } from "node:crypto";
import db from "../db.js";
import { isOwner } from "../access.js";
import { loadChatMessage } from "./chatMessages.js";
import { broadcastToUsers } from "../ws.js";

const SECRETARY = "u-secretary";

/** Голос предназначен для личного диалога владельца с Секретарём. */
export function assertVoiceChat(owner: string, chatId: unknown): asserts chatId is string {
  if (!isOwner(owner) || typeof chatId !== "string" || !chatId) throw new Error("нет доступа к голосовому чату");
  const chat = db.prepare("SELECT kind,closed_at FROM chats WHERE id=?").get(chatId) as any;
  const members = (db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(chatId) as {member_id:string}[]).map(m=>m.member_id);
  if (!chat || chat.kind !== "direct" || chat.closed_at || members.length !== 2 || !members.includes(owner) || !members.includes(SECRETARY)) {
    throw new Error("нужен открытый личный чат владельца с Помощником");
  }
}

export function voiceChatContext(owner: string, chatId: string) {
  assertVoiceChat(owner,chatId);
  const rows = db.prepare("SELECT id,from_user_id FROM chat_messages WHERE chat_id=? AND from_user_id IN (?,?) AND COALESCE(is_session_marker,0)=0 ORDER BY rowid DESC LIMIT 40").all(chatId,owner,SECRETARY) as {id:string;from_user_id:string}[];
  return rows.reverse().map(row=>{
    const message = loadChatMessage(row.id) as any;
    const files = (message?.attachments ?? []).map((a:any)=>a.file_name || a.name).filter(Boolean);
    return {id:row.id,role:row.from_user_id===owner ? "user" : "assistant",text:String(message?.text ?? "").slice(0,12000)+(files.length ? "\nВложения: "+files.join(", ") : "")};
  });
}

/** Не вызывает обработчик отправки чата: сохранение расшифровки не запускает вторую модель. */
export function saveVoiceMessage(owner: string, chatId: string, eventId: string, role: "user" | "assistant", text: string) {
  assertVoiceChat(owner,chatId);
  if (!["user","assistant"].includes(role) || typeof eventId!=="string" || !eventId || eventId.length>512 || typeof text!=="string" || !text.trim() || text.length>100000) {
    throw new Error("неверное голосовое сообщение");
  }
  const id = "voice-"+createHash("sha256").update(JSON.stringify([owner,chatId,eventId])).digest("hex");
  const inserted = db.transaction(()=>{
    const result = db.prepare("INSERT OR IGNORE INTO chat_messages(id,from_user_id,text,channel,chat_id,execution_mode) VALUES (?,?,?,'chat',?,?)").run(id,role==="user" ? owner : SECRETARY,text,chatId,role==="user" && isCardHandoffCommand(text) ? "card" : chatExecutionMode(chatId));
    if (result.changes) db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chatId);
    return result.changes>0;
  })();
  if (inserted) broadcastToUsers([owner,SECRETARY],{type:"chat:new",message:loadChatMessage(id)});
  return id;
}

/** Из результата общего инструмента берём пользовательский текст, не служебный JSON. */
export function voiceSummaryText(envelope: string): string | null {
  try {
    const result = JSON.parse(envelope);
    if (!result.ok) return null;
    for (const part of result.data?.content ?? []) {
      if (part.type !== "text") continue;
      const data = JSON.parse(part.text);
      if (typeof data.текст === "string" && data.текст.trim()) return data.текст;
    }
  } catch { /* ошибка инструмента озвучивается обычным путём */ }
  return null;
}
