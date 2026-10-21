import { ensureDirectRoom, ensurePersonalRoom } from "../lib/chatRooms.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import db from "../db.js";
import { getTaskForRead } from "../access.js";
import { roleUserId } from "../roleRouting.js";
import { COMMON_CHAT_ID, ensureCommonChat } from "../lib/chatCommon.js";
import { composeLayer, registerInstructionBlock } from "../lib/roleContextResolver.js";
import { resolveTopicSlot } from "./slotSession.js";
import { asRole, asText, ToolError, listActiveInProcessRuns } from "./inProcessRun.js";

const ownerAccountId = () => (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1").get() as {id:string}|undefined)?.id;

type Context = { taskId?: string; subtaskId?: string; chatId?: string; messageId?:string };
const optional = (description: string) => Type.Optional(Type.String({ description }));

/** One messenger for both working and conversational roles; all writes use the ordinary chat route. */
export function agentMessagingTools(role: string, context: Context = {}) {
  let sentCount = 0;
  const senderId = roleUserId(role);
  const tool = (name: string, description: string, parameters: any, execute: (p: any) => Promise<unknown>) => {
    const key = "tool.runtime." + name;
    registerInstructionBlock({key,title:name,group:"Возможности",scope:"command",modes:["work","resume","reply","review","subtask"],sourceKind:"code",originRef:"agentMessaging.ts:"+name,readOnly:false},description);
    return defineTool({name,label:name,description:composeLayer(role,key)?.effective ?? description,parameters,
      execute:async (_id: string,p: any) => asText(await execute(p))} as any);
  };
  const write = async (chatId: string, body: Record<string, unknown>) => {
    if (sentCount >= 4) throw new ToolError("Лимит 4 сообщений за ход исчерпан; продолжи работу или зафиксируй препятствие");
    const result = await asRole(role,"POST",`/api/chats/${chatId}/messages`,{...body,work_mode:"work",coordination_parent_message_id:body.reply_to_message_id??context.messageId});
    sentCount++;
    return {id:result.message.id,chat_id:chatId,отправлено:result.message.text};
  };
  // Личка роль↔роль — постоянная переписка пары (21.10.2026). Владелец —
  // в своей личной комнате с ролью; служебные чаты сюда не подбираются.
  const directChat = (recipientId: string) => recipientId===ownerAccountId() ? (ensurePersonalRoom(senderId) ?? ensureDirectRoom(senderId,recipientId)) : ensureDirectRoom(senderId,recipientId);
  return [
    tool("taskflow_chat_send","Написать коллеге. Без chat_id: если коллега участник текущего чата — сообщение уходит в этот чат (в группе с @), иначе в личку. to: имя, id или role_key; всем — контекст группы, без автоматического вызова всех. В личке @ не нужен; в группе адресный вызов добавляет @. Работающий коллега получает вопрос в свою сессию; свободный отвечает разговорным ходом. chat_id задаёт конкретную группу, task_id — контекст задачи; slot_key нужен при нескольких этапах адресата. Максимум 4 сообщения за ход.",Type.Object({to:Type.String(),text:Type.String(),chat_id:optional("Личный или групповой чат"),task_id:optional("Контекст задачи"),slot_key:optional("Конкретный этап адресата")}),async p=>{
      const raw=String(p.to??"").trim().toLowerCase();
      if(!raw) throw new ToolError("Укажи адресата");
      const all=["all","всем","*"].includes(raw);
      const agents=await asRole(role,"GET","/api/agents") as any[];
      const recipient=all ? null : agents.find(a=>[a.id,a.name,a.role_key].some(v=>String(v??"").trim().toLowerCase()===raw));
      if(!all && (!recipient || recipient.archived)) throw new ToolError("Адресат не найден");
      if(recipient?.id===senderId) throw new ToolError("Не адресуй сообщение самому себе");
      const taskId=p.task_id??context.taskId;
      if(taskId){
        await asRole(role,"GET",`/api/tasks/${taskId}`);
        if(recipient && !getTaskForRead(taskId,recipient.id)) throw new ToolError("Адресату недоступен контекст этой задачи");
      }
      let chatId=p.chat_id;
      if(!chatId && all) chatId=context.chatId??ensureCommonChat()??COMMON_CHAT_ID;
      // Владелец 21.10.2026: если коллега уже участник чата, где идёт ход, —
      // говорим здесь же, при всех (в группе с @). В личку — только когда в
      // этом чате его нет: «завёл группу и сказал решать — решайте в ней».
      if(!chatId && recipient && context.chatId && db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(context.chatId,recipient.id))
        chatId=context.chatId;
      if(!chatId && recipient) chatId=directChat(recipient.id);
      const chat=(await asRole(role,"GET",`/api/chats/${chatId}`)).chat;
      if(recipient && !chat.members.some((m:any)=>m.id===recipient.id)) throw new ToolError("Адресат не участвует в этом чате");
      const recipientRole=recipient?.role_key;
      let targetSlot:string|undefined;
      if(chat.parent_chat_id && recipientRole){
        const slots=db.prepare("SELECT id FROM subtasks WHERE task_id=? AND agent_id=? AND collaboration_plan_id IN (SELECT id FROM task_collaboration_plans WHERE status='approved')").all(chat.task_id,recipient.id);
        if(slots.length>1 && !p.slot_key) throw new ToolError("Укажи slot_key: у адресата несколько этапов");
        targetSlot=resolveTopicSlot(chat.task_id,recipientRole,p.slot_key)?.id;
        if(p.slot_key && !targetSlot) throw new ToolError("Этап адресата не найден");
      } else if(p.slot_key) throw new ToolError("slot_key задаётся в теме задачи");
      if(recipientRole && !targetSlot && listActiveInProcessRuns().filter(run=>run.role===recipientRole).length>1)
        throw new ToolError("У адресата несколько работающих этапов; используй тему задачи и slot_key");
      const text=chat.kind!=="direct" && recipientRole ? `@${recipientRole} ${p.slot_key?`[slot: ${p.slot_key}] `:""}${p.text}` : String(p.text);
      return write(chatId,{text,task_id:taskId,subtask_id:context.subtaskId,recipient_subtask_id:targetSlot});
    }),
    tool("taskflow_chat_reply","Ответить автору конкретного сообщения: message_id и короткий text. Ответ связан с вопросом и возвращается в сессию автора; не запускает рабочий этап. Максимум 4 сообщения за ход.",Type.Object({message_id:Type.String(),text:Type.String()}),async p=>{
      const original=db.prepare("SELECT m.*,u.role_key,u.name FROM chat_messages m JOIN users u ON u.id=m.from_user_id WHERE m.id=? AND m.chat_id IS NOT NULL").get(p.message_id) as any;
      if(!original) throw new ToolError("Сообщение не найдено");
      await asRole(role,"GET",`/api/chats/${original.chat_id}`);
      if(original.from_user_id===senderId) throw new ToolError("Не отвечай сам себе");
      return write(original.chat_id,{text:String(p.text),task_id:original.task_id,subtask_id:context.subtaskId,recipient_subtask_id:original.subtask_id,reply_to_message_id:original.id});
    }),
    tool("taskflow_chat_read","Прочитать личный или групповой чат. chat_id — конкретная переписка; без него список доступных чатов. task_id фильтрует контекст задачи. Возвращает id сообщений для taskflow_chat_reply.",Type.Object({chat_id:optional("Чат"),task_id:optional("Задача"),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))}),async p=>{
      const chatId=p.chat_id??context.chatId;
      if(chatId){
        const history=await asRole(role,"GET",`/api/chats/${chatId}/messages`);
        return {messages:history.messages.slice(-Math.max(1,Math.min(100,p.limit??20)))};
      }
      const list=await asRole(role,"GET","/api/chats");
      return p.task_id ? {chats:list.chats.filter((c:any)=>c.task_id===p.task_id)} : list;
    }),
    tool("taskflow_checklist_state","Что владелец отметил в виджетах checklist этого чата: подпись пункта, ключ и done. chat_id — переписка (без него текущий чат хода); only_done — только отмеченные. Отвечай по подписям пунктов: они соответствуют задачам, которые владелец закрывает.",Type.Object({chat_id:optional("Чат"),only_done:Type.Optional(Type.Boolean({description:"Только отмеченные пункты"}))}),async p=>{
      const chatId=p.chat_id??context.chatId;
      if(!chatId) throw new ToolError("Укажи chat_id: операция читает отметки конкретного чата");
      const data=await asRole(role,"GET",`/api/chats/${chatId}/checklist${p.only_done?"?only_done=1":""}`) as any;
      const messages:any[]=data.checklists??[];
      let done=0,total=0;
      const list=messages.map(m=>({message_id:m.message_id,task_id:m.task_id,widgets:m.widgets.map((w:any)=>({widget_key:w.widget_key,title:w.title,items:w.items.map((i:any)=>{total++;if(i.done)done++;return {item_key:i.key,label:i.label,done:Boolean(i.done)};})}))}));
      if(!messages.length) return {отмечено:0,всего:0,пункты:[],подсказка:"В этом чате пока никто не отмечал пункты checklist-виджетов"};
      return {отмечено:done,всего:total,сообщения:list};
    }),
  ];
}
