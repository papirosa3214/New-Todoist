import { renderInstruction } from "./roleContextResolver.js";
import { loadChatMessage } from "./chatMessages.js";
// Единая сводка из фактической БД для звонка и чата Секретаря.
import { stopReasonPolicy } from "../stopReasons.js";
import crypto from "node:crypto";
import db from "../db.js";
import { isOwner } from "../access.js";
import { callUnifiedAi } from "../routes/ai.js";
import { broadcastToUsers } from "../ws.js";

const GROUPS = ["assigned_waiting", "blocked", "in_progress", "review", "completed", "overdue", "future", "stuck", "unassigned", "all"] as const;
type Group = typeof GROUPS[number];
export interface SummaryFilter {
  is_summary: boolean;
  assignee_id: string | null;
  groups: Group[];
  from: string | null;
  to: string | null;
  date_field: "due_date" | "completed_at" | "auto";
  question: string | null;
}
export function summaryClock(now = new Date()) {
  const timezone = process.env.TASKFLOW_TIMEZONE || "Europe/Moscow";
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const part = (kind:string) => parts.find(p=>p.type===kind)!.value;
  return {today:`${part("year")}-${part("month")}-${part("day")}`,timezone};
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !isNaN(date.getTime()) && date.toISOString().slice(0,10)===value;
}
export function validateSummaryFilter(raw:any): SummaryFilter {
  if (!raw || typeof raw!=="object") throw new Error("неверный разбор запроса сводки");
  const question = typeof raw.question==="string" && raw.question.trim() ? raw.question.trim() : null;
  const groups = Array.isArray(raw.groups) ? raw.groups : ["all"];
  if (!groups.length || groups.some((g:any)=>!GROUPS.includes(g))) throw new Error("неизвестный раздел сводки");
  if ((raw.from!=null && !validDate(raw.from)) || (raw.to!=null && !validDate(raw.to))) throw new Error("неверный период сводки");
  if (raw.from && raw.to && raw.from>raw.to) throw new Error("начало периода позже конца");
  const assignee = raw.assignee_id ?? null;
  if (assignee!==null && (typeof assignee!=="string" || !db.prepare("SELECT id FROM users WHERE id=?").get(assignee))) throw new Error("неизвестный исполнитель");
  if (raw.date_field!=null && !["due_date","completed_at","auto"].includes(raw.date_field)) throw new Error("неверное поле даты");
  return {is_summary:raw.is_summary===true,assignee_id:assignee,groups:[...new Set(groups)] as Group[],from:raw.from??null,to:raw.to??null,date_field:raw.date_field??"auto",question};
}
// Готовые относительные периоды считает сервер, а не голосовая модель.
export function summaryPeriods(today:string) {
  const start=new Date(today+"T00:00:00Z");
  const date=(d:Date)=>d.toISOString().slice(0,10);
  const add=(d:Date,days:number)=>{const next=new Date(d);next.setUTCDate(next.getUTCDate()+days);return next;};
  const week=add(start,-((start.getUTCDay()+6)%7));
  const month=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1));
  const nextMonth=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  const lastNextMonth=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+2,0)).getUTCDate();
  const rollingEnd=add(new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,Math.min(start.getUTCDate(),lastNextMonth))),-1);
  const range=(from:Date,to:Date)=>({from:date(from),to:date(to)});
  return {today:range(start,start),yesterday:range(add(start,-1),add(start,-1)),tomorrow:range(add(start,1),add(start,1)),
    rolling_week:range(start,add(start,6)),rolling_month:range(start,rollingEnd),
    current_week:range(week,add(week,6)),next_week:range(add(week,7),add(week,13)),
    current_month:range(month,add(nextMonth,-1)),next_month:range(nextMonth,new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+2,0)))};
}
export async function parseSummaryRequest(text:string, now = new Date()): Promise<SummaryFilter> {
  const {today,timezone}=summaryClock(now);
  const users=db.prepare("SELECT id,name,role_key FROM users WHERE role='owner' OR type='ai'").all();
  const content=await callUnifiedAi({temperature:0,predictTokens:1024,systemPrompt:
    renderInstruction("secretary", "secretary.summary", {today, timezone, periods: JSON.stringify(summaryPeriods(today)), users: JSON.stringify(users)}),userPrompt:text});
  const clean=content.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  const parsed=JSON.parse(clean);
  if(parsed.period!=null){
    const periods=summaryPeriods(today);
    if(!Object.hasOwn(periods,parsed.period))throw new Error("неизвестный относительный период");
    Object.assign(parsed,periods[parsed.period as keyof typeof periods]);
  }
  return validateSummaryFilter(parsed);
}
// Предварительный фильтр: обычный разговор и постановки не запускают разбор сводки.
export function mayRequestSummary(text:string) {
  return /(?:покажи|пришли|скинь|отправь|расскажи).*?(?:задач|рол|исполнител)|сводк|отч[её]т|завис|просроч|заблок|на стопе|какие.*задач|что.*(?:у |задач|работ|сдела)|задач.*(?:недел|месяц|заверш|назнач|выполн|срок)|чем.*занят/i.test(text)
    && !/^\s*(?:создай|создать|добавь|поставь)(?=\s|$)/i.test(text);
}
export function collectTaskSummary(ownerId:string, filter:SummaryFilter, now = new Date()) {
  if (!isOwner(ownerId)) throw new Error("сводка доступна только владельцу");
  const {today,timezone}=summaryClock(now);
  const tasks=db.prepare(`SELECT t.id,t.title,t.status,t.agent_state,t.assignee_id,t.due_date,t.start_time,
    t.completed_at,t.run_at,t.ready_for_pickup,t.blocked_reason,t.block_type,t.blocked_at,
    u.name AS assignee_name,u.role_key AS assignee_role,
    (SELECT c.text FROM comments c WHERE c.task_id=t.id ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1) AS last_comment,
    (SELECT j.last_error FROM role_run_jobs j WHERE j.task_id=t.id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) AS queue_error
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id ORDER BY t.due_date,t.created_at,t.id`).all() as any[];
  const mode=(db.prepare("SELECT task_intake_mode FROM users WHERE id=?").get(ownerId) as any).task_intake_mode;
  const localDate=(value:string|null) => value ? (value.includes("T") ? summaryClock(new Date(value.endsWith("Z")||/[+-]\d\d:\d\d$/.test(value) ? value : value+"Z")).today : value.length>10 ? summaryClock(new Date(value.replace(" ","T")+"Z")).today : value) : null;
  const selected=tasks.filter(t=>{
    if(filter.assignee_id && t.assignee_id!==filter.assignee_id)return false;
    const date=(filter.date_field==="completed_at" || (filter.date_field==="auto" && t.status==="completed")) ? localDate(t.completed_at) : t.due_date?.slice(0,10);
    return (!filter.from || (date && date>=filter.from)) && (!filter.to || (date && date<=filter.to));
  });
  const active=(t:any)=>t.status==="active";
  const waiting=(t:any)=>active(t)&&!!t.assignee_id&&!t.agent_state;
  const predicates:Record<Group,(t:any)=>boolean>={
    assigned_waiting:waiting, blocked:t=>active(t)&&t.agent_state==="blocked",
    in_progress:t=>active(t)&&t.agent_state==="in_progress", review:t=>active(t)&&t.agent_state==="review",
    completed:t=>t.status==="completed", overdue:t=>active(t)&&!!t.due_date&&t.due_date.slice(0,10)<today,
    future:t=>active(t)&&!!t.due_date&&t.due_date.slice(0,10)>today,
    unassigned:t=>active(t)&&!t.assignee_id,
    stuck:t=>waiting(t)||(active(t)&&t.agent_state==="blocked"), all:()=>true,
  };
  const describe=(t:any)=>({id:t.id,title:t.title,status:t.status,agent_state:t.agent_state,assignee:t.assignee_name??"Не назначен",role:t.assignee_role,
    due_date:t.due_date,start_time:t.start_time,completed_at:t.completed_at,run_at:t.run_at,
    reason:t.agent_state==="blocked" ? (stopReasonPolicy(t.blocked_reason)?.label || t.blocked_reason || (t.last_comment ? `Причина блокировки не записана; последний комментарий: ${t.last_comment}` : "Причина блокировки не записана")) : waiting(t) ?
      (t.queue_error || (t.run_at&&new Date(t.run_at.replace(" ","T")+(t.run_at.includes("Z")?"":"Z"))>now ? `Запуск запланирован: ${t.run_at}` :
        t.assignee_id===ownerId ? "Личная задача владельца; агент её не подхватывает" : mode==="manual" ? "Автоматика выключена; доступен ручной запуск" : !t.ready_for_pickup ? "Не допущена к автоматическому подхвату" : "Причина ожидания не записана")) : null});
  const names:Record<Group,string>={assigned_waiting:"Назначены, но не взяты",blocked:"Заблокированы",in_progress:"В работе",review:"На проверке",completed:"Завершены",overdue:"Просрочены",future:"Будущие сроки",stuck:"Зависшие: не взяты или заблокированы",unassigned:"Без исполнителя",all:"Все задачи"};
  const wanted=filter.groups.includes("all") ? ["assigned_waiting","blocked","in_progress","review","completed","unassigned","overdue","future"] as Group[] : filter.groups;
  const sections=wanted.map(group=>{const rows=selected.filter(predicates[group]);return {group,name:names[group],count:rows.length,tasks:rows.slice(0,30).map(describe),omitted:Math.max(0,rows.length-30)};});
  const assignee=filter.assignee_id ? (db.prepare("SELECT name FROM users WHERE id=?").get(filter.assignee_id) as any).name : "все исполнители";
  const period=filter.from||filter.to ? `${filter.from??"без начала"} — ${filter.to??"без конца"} (${filter.date_field==="completed_at"?"дата завершения":filter.date_field==="auto"?"завершённые по завершению, остальные по сроку":"срок задачи"})` : "без ограничения периода";
  const lines=[`Сводка задач: ${assignee}.`, `На ${today}, ${timezone}; ${period}.`, "Просроченные и будущие сроки могут пересекаться с рабочими статусами; числа этих разделов не складываются."];
  for(const section of sections){
    lines.push(`\n${section.name}: ${section.count}.`);
    for(const task of section.tasks)lines.push(`• ${task.title} — ${task.assignee}${task.due_date?`; срок ${task.due_date}${task.start_time?" "+task.start_time:""}`:""}${task.reason?`; ${task.reason}`:""} [${task.id}]`);
    if(section.omitted)lines.push(`Ещё ${section.omitted} задач не показаны.`);
  }
  return {today,timezone,filter,sections,text:lines.join("\n"),spoken_text:`Сводка: ${assignee}, ${period}. `+sections.map(s=>`${s.name}: ${s.count}`).join(". ")+". Подробности можно прислать в чат."};
}
export function sendSummaryToSecretaryChat(ownerId:string,text:string) {
  if(!isOwner(ownerId))throw new Error("только владелец");
  const chatId="chat-secretary";
  if(!db.prepare("SELECT 1 FROM chat_members WHERE chat_id=? AND member_id=?").get(chatId,ownerId)) throw new Error("владелец не участник чата Секретаря");
  const id=crypto.randomUUID();
  db.transaction(()=>{
    db.prepare("INSERT INTO chat_messages (id,from_user_id,text,channel,chat_id) VALUES (?,'u-secretary',?,'chat',?)").run(id,text,chatId);
    db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(chatId);
  })();
  const row=loadChatMessage(id);
  const members=(db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(chatId) as {member_id:string}[]).map(m=>m.member_id);
  broadcastToUsers(members,{type:"chat:new",message:row});
  return id;
}
export async function requestTaskSummary(ownerId:string,text:string,sendToChat=false) {
  if(!isOwner(ownerId))throw new Error("только владелец");
  const filter=await parseSummaryRequest(text);
  if(!filter.is_summary)return {question:"Какую сводку задач нужно собрать?"};
  if(filter.question)return {question:filter.question};
  const summary=collectTaskSummary(ownerId,filter);
  const message_id=sendToChat ? sendSummaryToSecretaryChat(ownerId,summary.text) : null;
  return {...summary,message_id};
}
