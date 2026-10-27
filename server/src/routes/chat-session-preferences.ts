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
  if(row.kind!=="direct"||members.length!==2||!members.some(m=>m.member_id==="u-secretary")){reply.code(400).send({error:"Настройки доступны в личной сессии помощника"});return false;}
  return row;
 };
 app.get("/api/chats/:id/session-preferences",{preHandler:authOrApiToken},async(req:any,reply)=>{
  if(!access(req,reply))return;
  return readChatPreferences(req.params.id);
 });
 app.put("/api/chats/:id/session-preferences",{preHandler:authOrApiToken},async(req:any,reply)=>{
  const row=access(req,reply);if(!row)return;
  if(row.closed_at)return reply.code(409).send({error:"Сессия закрыта"});
  const catalog=await piRuntime.listModels();
  try{return writeChatPreferences(req.params.id,req.body??{},catalog,loadRoleRouting().models.secretary??null);}
  catch(error){return reply.code(400).send({error:(error as Error).message});}
 });
}
