import db from "../db.js";
export const AGENT_VISIBLE_TEXT_MAX = 800;
export const AGENT_BLOCK_TEXT_MAX = 400;
export function agentVisibleTextError(userId:string,text:unknown,max=AGENT_VISIBLE_TEXT_MAX):string|null {
  if(typeof text !== "string" || (db.prepare("SELECT type FROM users WHERE id=?").get(userId) as any)?.type !== "ai") return null;
  const words=text.trim().split(/\s+/u).filter(Boolean).length;
 const wordMax=max===AGENT_BLOCK_TEXT_MAX?50:100;
 return words>wordMax || Array.from(text).length>max ? `Ответ агента: максимум ${wordMax} слов и ${max} символов. Напиши суть и нужное действие; подробности вынеси в артефакт.` : null;
}
