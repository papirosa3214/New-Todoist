import { ensureDirectRoom, ensurePersonalRoom } from "../lib/chatRooms.js";
import { postToRoleSession, startRoleSessionDelivery } from "./roleCrossSessionMessage.js";
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
  // Отдельных чатов «роль↔роль» больше нет (владелец 29.10.2026): вопрос
  // идёт в ПОСТОЯННУЮ сессию адресата — его личку, где владелец тоже
  // участник. Ничего лишнего не создаётся.
  const directChat = (recipientId: string) => recipientId===ownerAccountId() ? (ensurePersonalRoom(senderId) ?? ensureDirectRoom(senderId,recipientId)) : ensurePersonalRoom(recipientId) ?? ensureDirectRoom(senderId,recipientId);
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
      const sameSession=!!recipient && !!context.chatId && !!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(context.chatId,recipient.id);
      if(!chatId && sameSession) chatId=context.chatId;
      const recipientRole=recipient?.role_key;
      // Отдельных чатов «роль↔роль» больше нет (владелец 29.10.2026).
      // Вопрос идёт в постоянную сессию адресата — его личку, где владелец
      // тоже участник. В сессии отправителя появляется карточка обращения
      // («кто кому», вопрос, статус), само сообщение не дублируется.
      if(!chatId && recipient && recipient.id!==ownerAccountId()){
        // Адресат работает на нескольких этапах — адресовать нельзя:
        // вопрос ушёл бы непонятно куда (те же правила, что и раньше).
        if(recipientRole && listActiveInProcessRuns().filter(run=>run.role===recipientRole).length>1)
          throw new ToolError("У адресата несколько работающих этапов; используй тему задачи и slot_key");
        if(p.slot_key) throw new ToolError("slot_key задаётся в теме задачи");
        // Сессия отправителя: его личка (постоянная) — в ней живёт карточка.
        const senderSession=context.chatId??ensurePersonalRoom(senderId);
        if(!senderSession) throw new ToolError("Нет сессии отправителя для обращения");
        if(sentCount>=4) throw new ToolError("Лимит 4 сообщений за ход исчерпан; продолжи работу или зафиксируй препятствие");
        const posted=postToRoleSession({
          senderId, senderChatId:senderSession, recipientId:recipient.id, text:String(p.text),
        });
        sentCount++;
        void startRoleSessionDelivery({roomId:posted.roomId, recipientId:recipient.id, queueRowId:posted.queueRowId})
          .catch(error=>console.warn("[agent-messaging] ход адресата не поднялся:",error));
        return {id:posted.questionId,chat_id:posted.roomId,отправлено:String(p.text)};
      }
      if(!chatId && recipient) chatId=directChat(recipient.id);
      const chat=(await asRole(role,"GET",`/api/chats/${chatId}`)).chat;
      if(recipient && !chat.members.some((m:any)=>m.id===recipient.id)) throw new ToolError("Адресат не участвует в этом чате");
      let targetSlot:string|undefined;
      if(chat.parent_chat_id && recipientRole){
        const slots=db.prepare("SELECT id FROM subtasks WHERE task_id=? AND agent_id=? AND collaboration_plan_id IN (SELECT id FROM task_collaboration_plans WHERE status='approved')").all(chat.task_id,recipient.id);
        if(slots.length>1 && !p.slot_key) throw new ToolError("Укажи slot_key: у адресата несколько этапов");
        targetSlot=resolveTopicSlot(chat.task_id,recipientRole,p.slot_key)?.id;
        if(p.slot_key && !targetSlot) throw new ToolError("Этап адресата не найден");
      } else if(p.slot_key) throw new ToolError("slot_key задаётся в теме задачи");
      if(recipientRole && !targetSlot && listActiveInProcessRuns().filter(run=>run.role===recipientRole).length>1)
        throw new ToolError("У адресата несколько работающих этапов; используй тему задачи и slot_key");
      // Роль уже обратилась к адресату сама («@Разработчик» или «@builder») —
      // второй раз не добавляем, иначе в чате «@builder @Разработчик» (21.10.2026).
      const body=String(p.text), lowered=body.toLowerCase();
      const alreadyAddressed=!!recipientRole && [recipientRole,String(recipient?.name??"")].some(n=>n && lowered.includes("@"+n.toLowerCase()));
      const text=chat.kind!=="direct" && recipientRole && (!alreadyAddressed || p.slot_key) ? `@${recipientRole} ${p.slot_key?`[slot: ${p.slot_key}] `:""}${body}` : body;
      return write(chatId,{text,task_id:taskId,subtask_id:context.subtaskId,recipient_subtask_id:targetSlot});
    }),
    tool("taskflow_chat_reply","Ответить автору конкретного сообщения: message_id и короткий text. Ответ связан с вопросом и возвращается в сессию автора; не запускает рабочий этап. Максимум 4 сообщения за ход.",Type.Object({message_id:Type.String(),text:Type.String()}),async p=>{
      const original=db.prepare("SELECT m.*,u.role_key,u.name FROM chat_messages m JOIN users u ON u.id=m.from_user_id WHERE m.id=? AND m.chat_id IS NOT NULL").get(p.message_id) as any;
      if(!original) throw new ToolError("Сообщение не найдено");
      await asRole(role,"GET",`/api/chats/${original.chat_id}`);
      if(original.from_user_id===senderId) throw new ToolError("Не отвечай сам себе");
      return write(original.chat_id,{text:String(p.text),task_id:original.task_id,subtask_id:context.subtaskId,recipient_subtask_id:original.subtask_id,reply_to_message_id:original.id});
    }),
    tool("taskflow_chat_read","Прочитать личный или групповой чат. chat_id — конкретная переписка; без него список доступных чатов. task_id фильтрует контекст задачи. Возвращает id сообщений для taskflow_chat_reply.",Type.Object({chat_id:optional("Чат"),task_id:optional("Задача"),include_closed:Type.Optional(Type.Boolean({description:"Показать и закрытые сессии"})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))}),async p=>{
      const chatId=p.chat_id??context.chatId;
      if(chatId){
        const history=await asRole(role,"GET",`/api/chats/${chatId}/messages`);
        return {messages:history.messages.slice(-Math.max(1,Math.min(100,p.limit??20)))};
      }
      const list=await asRole(role,"GET",p.include_closed?"/api/chats?include_closed=1":"/api/chats");
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
    // Уборка чатов и тем задач (владелец 22.10.2026): «согласуй инструменты
    // у сервера и в каталоге, чтобы они все там были». До этого сервер умел
    // закрывать и убирать чат, а роли видели в каталоге только чтение и ответ —
    // и лезли в taskflow.db руками.
    tool("taskflow_chat_archive","Убрать чат-сессию или тему задачи в архив: из списка уходит, история остаётся, statistics целы. Только чаты, где у тебя есть право уборки; постоянные комнаты (личная, группа, общая) не убираются. Это штатный путь уборки — в базу данных не ходи.",Type.Object({chat_id:Type.String({description:"Чат или тема задачи"}),reason:optional("Коротко, почему убираем")}),async p=>{
      const data=await asRole(role,"POST",`/api/chats/${p.chat_id}/archive`) as any;
      return {archived:true,chat_id:p.chat_id,reason:p.reason??null,chat:data.chat};
    }),
    tool("taskflow_chats_cleanup_preview","Предпросмотр уборки: сколько пустых тем задач сервер считает мусором и какие именно (без сообщений, без очереди доставки, не тронуты два часа). Ничего не меняет — покажи список владельцу и дождись его «давай».",Type.Object({}),async()=>{
      return await asRole(role,"GET","/api/chats/cleanup/candidates");
    }),
    tool("taskflow_chats_cleanup","Уборка пустых тем задач: архивирует ровно то, что показал предпросмотр. Только после явного подтверждения владельца в этом ходе; без него не вызывай.",Type.Object({confirm:Type.Optional(Type.Boolean({description:"Подтверждение владельца"})),}),async p=>{
      if(p.confirm!==true) throw new ToolError("Сначала taskflow_chats_cleanup_preview, покажи список владельцу и дождись подтверждения");
      return await asRole(role,"POST","/api/chats/cleanup",{confirm:true});
    }),
    tool("taskflow_chat_close","Закрыть или вернуть сессию чата: закрытая уходит из списка в «Закрытые», история остаётся. Постоянные комнаты не закрываются. Закрывает владелец — если сервер отказал, так и скажи владельцу и предложи taskflow_chat_archive.",Type.Object({chat_id:Type.String(),closed:Type.Optional(Type.Boolean({description:"false — вернуть из закрытых"}))}),async p=>{
      const data=await asRole(role,"POST",`/api/chats/${p.chat_id}/close`,{closed:p.closed!==false}) as any;
      return {chat:data.chat};
    }),
  ];
}
