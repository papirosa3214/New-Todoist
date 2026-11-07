import type {FastifyInstance} from "fastify";
import db from "../db.js";
import {authOrApiToken} from "../auth.js";
import {isOwner} from "../access.js";
import {piRuntime} from "../runtime/PiRuntimeAdapter.js";
import {loadRoleRouting} from "../roleRouting.js";
import {readChatPreferences,writeChatPreferences} from "../lib/chatSessionPreferences.js";
export function registerChatSessionPreferenceRoutes(app:FastifyInstance){
 const access=(req:any,reply:any)=>{
  if(!isOwner(req.userId)||(db.prepare("SELECT type FROM users WHERE id=?").get(req.userId) as any)?.type!=="human") {reply.code(403).send({error:"только владелец"});return false;}
  const row=db.prepare("SELECT c.kind,c.closed_at FROM chats c JOIN chat_members m ON m.chat_id=c.id AND m.member_id=? WHERE c.id=?").get(req.userId,req.params.id) as any;
  if(!row){reply.code(404).send({error:"Чат не найден"});return false;}
  const members=db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(req.params.id) as any[];
  // Роль в личном чате: владелец и одна роль. Раньше правило было «только
  // Помощник» — и в чате с любой другой ролью выбор модели и уровня
  // рассуждений был недоступен (владелец 29.10.2026: «с другими всеми
  // ролями должна быть именно та схема — мозг и папка»).
  const other=members.map((m:any)=>String(m.member_id)).find((id:string)=>id!==String(req.userId))??"";
  const roleKey=other.startsWith("role_")?other.slice(5):other==="u-secretary"?"secretary":null;
  if(row.kind!=="direct"||members.length!==2||!roleKey){reply.code(400).send({error:"Настройки доступны в личном чате с ролью"});return false;}
  return {...row,roleKey};
 };
 app.get("/api/chats/:id/session-preferences",{preHandler:authOrApiToken},async(req:any,reply)=>{
  if(!access(req,reply))return;
  return readChatPreferences(req.params.id);
 });
 app.put("/api/chats/:id/session-preferences",{preHandler:authOrApiToken},async(req:any,reply)=>{
  const row=access(req,reply);if(!row)return;
  if(row.closed_at)return reply.code(409).send({error:"Сессия закрыта"});
  const catalog=await piRuntime.listModels();
  // Модель по умолчанию — из маршрутизации той роли, с которой владелец
  // говорит в этом чате (у Помощника это secretary, как и раньше).
  try{return writeChatPreferences(req.params.id,req.body??{},catalog,loadRoleRouting().models[row.roleKey]??null);}
  catch(error){return reply.code(400).send({error:(error as Error).message});}
 });
}
