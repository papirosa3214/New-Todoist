import {roleInstructionText} from './roleHome.js';
import {chatExecutionMode,chatExecutionInstruction} from "./chatExecutionMode.js";
import { assertVoiceChat, voiceChatContext, saveVoiceMessage, voiceSummaryText } from "../lib/secretaryVoiceConversation.js";
import { randomUUID } from "node:crypto";
import { NonTaskInputError } from "../lib/taskPreparation.js";
import { composeLayer, instructionManifest } from "../lib/roleContextResolver.js";
// Закрытый канал Python-воркера к живому серверу. Никаких TCP-маршрутов
// или постоянных api_token: только Unix socket владельца процесса (0600).
import type { FastifyInstance } from "fastify";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import db from "../db.js";
import { requestTaskSummary } from "../lib/secretaryTaskSummary.js";
import { submitOwnerTaskText } from "../lib/ownerDraft.js";
import { VOICE_TOOLS_GUIDE, lookupTaskDetails, roleLoadNow, voiceToolManifest, runVoiceTool, closeVoiceTools, closeAllVoiceTools } from "../lib/secretaryVoiceTools.js";
import { sendSummaryToSecretaryChat } from "../lib/secretaryTaskSummary.js";
import { registerVoiceCall, clearVoiceCall } from "../lib/voiceCallRegistry.js";
import { readVoiceJob } from "./secretaryVoiceBranch.js";

export const secretaryVoiceSocket = () => join(
  process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`,
  "taskflow-secretary", "voice.sock",
);

export async function startSecretaryVoiceBridge(app: FastifyInstance, socketPath = secretaryVoiceSocket()) {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  // После остановки процесса может остаться только его socket-файл.
  try {
    if (!lstatSync(socketPath).isSocket()) throw new Error("voice bridge path is not a socket");
    unlinkSync(socketPath);
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && new URL(req.url || "/","http://localhost").pathname === "/secretary/instructions") {
      const query = new URL(req.url!,"http://localhost").searchParams;
      const chatId = query.get("chat_id"), ownerId=query.get("owner_id");
      if (chatId) {try {assertVoiceChat(ownerId || "",chatId);} catch {send(403,{error:"нет доступа к исходному чату"});return;}}
      send(200,{instructions:(composeLayer("secretary","secretary.voice")?.effective ?? "")+"\n\n"+roleInstructionText("secretary")+"\n\n"+VOICE_TOOLS_GUIDE+"\n\n"+chatExecutionInstruction(chatExecutionMode(chatId ?? undefined)),greeting:composeLayer("secretary","secretary.greeting")?.effective ?? "",manifest:instructionManifest("secretary","voice")}); return;
    }
    if (req.method === "GET" && new URL(req.url || "/", "http://localhost").pathname === "/secretary/voice-job") {
      const questionId = new URL(req.url!, "http://localhost").searchParams.get("question_id");
      if (!questionId) { send(400, { error: "нужен question_id" }); return; }
      send(200, readVoiceJob(questionId));
      return;
    }
    if (req.method === "GET" && new URL(req.url || "/", "http://localhost").pathname === "/secretary/tools") {
      try {
        const query = new URL(req.url!, "http://localhost").searchParams;
        const ownerId = query.get("owner_id") || "u-secretary";
        const chatId = query.get("chat_id") || undefined;
        if (chatId) assertVoiceChat(ownerId, chatId);
        send(200,{tools:await voiceToolManifest(ownerId,{chatId,sessionId:query.get("session_id") || undefined})});
      } catch (error) { app.log.error({err:error},"не собран список инструментов голосового Помощника владельца"); send(500,{error:"сбой списка инструментов"}); }
      return;
    }
    if (req.method !== "POST" || !["/secretary/tasks", "/secretary/summary", "/secretary/task", "/secretary/roles", "/secretary/tool", "/secretary/owner-chat", "/secretary/conversation", "/secretary/transcript", "/secretary/tools-close"].includes(req.url || "")) {
      send(404, { error: "неизвестный инструмент" }); return;
    }
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 1048576) { send(413, {error:"слишком большой запрос"}); return; }
      }
      let body: any;
      try { body = JSON.parse(raw); } catch { send(400, {error:"неверный JSON"}); return; }
      const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as {id:string} | undefined;
      if (!owner || body.owner_id !== owner.id) {
        send(403, {error:"только владелец голосовой комнаты"}); return;
      }
      let chatId: string | undefined;
      if (body.chat_id !== undefined || req.url === "/secretary/conversation" || req.url === "/secretary/transcript") {
        try { assertVoiceChat(owner.id,body.chat_id); chatId=body.chat_id; }
        catch { send(403,{error:"нет доступа к исходному чату"}); return; }
      }
      if (req.url === "/secretary/conversation") { send(200,{messages:voiceChatContext(owner.id,chatId!),execution_mode:chatExecutionMode(chatId),instructions:chatExecutionInstruction(chatExecutionMode(chatId))}); return; }
      if (req.url === "/secretary/transcript") {
        if (!["user","assistant"].includes(body.role) || typeof body.event_id!=="string" || !body.event_id || typeof body.text!=="string" || !body.text.trim() || body.text.length>100000) {
          send(400,{error:"неверная расшифровка"}); return;
        }
        send(200,{message_id:saveVoiceMessage(owner.id,chatId!,body.event_id,body.role,body.text)}); return;
      }
      if (req.url === "/secretary/tools-close") {
        if (chatId) clearVoiceCall(chatId);
        await closeVoiceTools(owner.id,{chatId,sessionId:body.session_id});
        send(200,{ok:true}); return;
      }
      if (req.url === "/secretary/roles") { send(200,roleLoadNow(owner.id)); return; }
      if (req.url === "/secretary/tool") {
        if (typeof body.name !== "string") { send(400,{error:"нужно имя инструмента"}); return; }
        if (chatId && typeof body.call_id === "string" && body.call_id) registerVoiceCall(chatId, body.call_id);
        const messageId = chatId ? (db.prepare("SELECT id FROM chat_messages WHERE chat_id=? AND from_user_id=? ORDER BY rowid DESC LIMIT 1").get(chatId,owner.id) as {id:string}|undefined)?.id : undefined;
        const result = await runVoiceTool(owner.id,body.name,body.arguments,{chatId,messageId,sessionId:body.session_id,callId:body.call_id});
        if (chatId && body.name==="taskflow_task_summary") {
          const text = voiceSummaryText(JSON.stringify({ok:true,data:{content:[{type:"text",text:result.result}]}}));
          if (text) saveVoiceMessage(owner.id,chatId,"summary:"+(body.arguments.request_id || randomUUID()),"assistant",text);
        }
        send(200,result); return;
      }
      const text = body.text;
      if (typeof text !== "string" || !text.trim() || text.length > 6000) {
        send(400,{error:"нужен полный текст поручения, до 6000 символов"}); return;
      }
      if (req.url === "/secretary/task") { send(200,lookupTaskDetails(owner.id,text)); return; }
      if (req.url === "/secretary/owner-chat") { send(200,{message_id:chatId ? saveVoiceMessage(owner.id,chatId,"message:"+randomUUID(),"assistant",text) : sendSummaryToSecretaryChat(owner.id,text)}); return; }
      if (req.url === "/secretary/summary") {
        if (body.send_to_chat !== undefined && typeof body.send_to_chat !== "boolean") {
          send(400,{error:"send_to_chat должен быть boolean"}); return;
        }
        const result = await requestTaskSummary(owner.id,text,!chatId && body.send_to_chat===true);
        if (chatId && "text" in result && typeof result.text==="string") {
          send(200,{...result,message_id:saveVoiceMessage(owner.id,chatId,"summary:"+randomUUID(),"assistant",result.text)}); return;
        }
        send(200,result); return;
      }
      if (chatExecutionMode(chatId) === "chat") {send(403,{error:"В режиме «В чате» карточки не создаются. Владелец может выбрать «По карточке»."});return;}
      const mode = (db.prepare("SELECT task_intake_mode FROM users WHERE id=?").get(owner.id) as any).task_intake_mode;
      const intake = await submitOwnerTaskText(text,owner.id,mode);
      const row = db.prepare("SELECT t.id,t.title,t.creator_id,t.due_date,t.start_time,t.priority,t.assignee_id,t.ready_for_pickup,u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?").get(intake.parentId) as Record<string,unknown>;
      const labels = db.prepare("SELECT l.id,l.name FROM labels l JOIN task_labels tl ON tl.label_id=l.id WHERE tl.task_id=?").all(intake.parentId);
      const task = {...row,labels};
      send(200,{task,child_ids:intake.childIds,questions:intake.questions,
        requires_plan_approval:intake.requiresPlanApproval,dispatched:intake.dispatched,queued:intake.queued});
    } catch (error) {
      if (error instanceof NonTaskInputError) { send(422,{error:error.message,intent:error.intent,task:null}); return; }
      app.log.error({err:error}, "ошибка локального инструмента голосового Помощника владельца");
      if (!res.headersSent) send(500, {error: error instanceof Error ? error.message : "сбой инструмента Помощника владельца"});
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
  });
  return async () => {
    await closeAllVoiceTools();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { unlinkSync(socketPath); } catch (error:any) { if (error.code !== "ENOENT") throw error; }
  };
}
