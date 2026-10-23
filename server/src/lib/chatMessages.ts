import {compactChatReportMaterials} from "./chatReportMaterials.js";
import {coordinationCardData} from "../runtime/chatCoordination.js";
// Сообщение чата с ролями в том виде, в каком его видит клиент.
//
// Один формат на все пути доставки: история (GET /api/chats/:id/messages),
// ответ на отправку и событие `chat:new`. Раньше ответ роли уходил по сокету
// сырой строкой БД (шаги — JSON-строкой, is_session_marker — 0/1), и
// клиенту приходилось перечитывать всю ленту, чтобы показать готовый ответ.
// С одним форматом iPhone вставляет пузырь прямо из события — без
// перезапроса и без скачка ленты.
import db from "../db.js";
import {
  stepDetailFallback,
  type SavedSteps,
} from "../runtime/chatLiveTurn.js";
import { chatHandoff } from "./chatHandoff.js";
import { parseRoleContractV1 } from "./roleContractV1.js";
import { checklistStateOfMessage } from "./chatChecklist.js";

// Ленивая подготовка: db.prepare с колонкой chat_message_id не должен
// падать на импорте, если миграция 053 ещё не прошла (index.ts импортирует
// маршруты раньше, чем прогоняет миграции).
let attachmentsOf: import("better-sqlite3").Statement | null = null;

/** Шаги из БД; инструментам трекера без подписи — подпись по имени. */
function savedSteps(raw: string): SavedSteps {
  const steps = JSON.parse(raw) as SavedSteps;
  for (const it of steps.items ?? []) {
    if (it.kind === "step") it.detail = stepDetailFallback(it.tool, it.detail);
  }
  return steps;
}

/** Строку chat_messages (с join-полями автора) привести к формату клиента. */
export function formatChatMessage(message: any) {
  if (!message) return message;
  attachmentsOf ??= db.prepare(
    `SELECT id, file_name, mime, size FROM attachments
      WHERE chat_message_id = ? ORDER BY created_at`,
  );
  const event=message.message_type==='system' || !!db.prepare("SELECT 1 FROM plan_topic_events WHERE message_id=?").get(message.id);
  // Один разбор ответа роли на оба поля: конверт снимается с текста и,
  // если он был, уходит клиенту структурным полем (карточка 237d6f34,
  // JSON-контракт роли v1). Старый YAML-подобный вид даёт тот же конверт,
  // обычный ответ — null, то есть сообщение выходит ровно как раньше.
  const storedEnvelope = typeof message.role_envelope_json === "string"
    ? parseRoleContractV1(message.role_envelope_json)
    : null;
  const parsed = storedEnvelope?.structuredEnvelope
    ? storedEnvelope
    : typeof message.text === "string" ? parseRoleContractV1(message.text) : null;
  const { role_envelope_json: _roleEnvelopeJSON, ...messageFields } = message;
  let displayText = parsed ? parsed.text : message.text;
  if(typeof displayText==="string" && message.task_id) displayText=displayText.replace(/\[slot: ([^\]]+)\]/g,(_match:string,key:string)=>{
    const row=db.prepare("SELECT s.title FROM subtasks s WHERE s.task_id=? AND s.plan_node_key=? ORDER BY s.rowid DESC LIMIT 1").get(message.task_id,key) as {title:string}|undefined;
    return `[этап: ${row?.title ?? key}]`;
  });
  return {
    ...messageFields,
    sequence: (db.prepare("SELECT rowid AS sequence FROM chat_messages WHERE id=?").get(message.id) as {sequence:number}|undefined)?.sequence ?? null,
    kind:event?'system':message.message_type ?? message.kind,
    ...(event?{from_user_id:'taskflow_system',from_user_name:'Система',from_user_initials:'С',from_user_avatar_url:null}:{}),
    reply_to_sender_name: message.reply_to_message_id ? (db.prepare("SELECT u.name FROM chat_messages m JOIN users u ON u.id=m.from_user_id WHERE m.id=?").get(message.reply_to_message_id) as {name:string}|undefined)?.name : null,
    reactions: db.prepare("SELECT user_id,emoji FROM chat_message_reactions WHERE message_id=? ORDER BY user_id").all(message.id),
    // Отметки пунктов checklist-виджета (карточка 21842242): клиент рисует их
    // по этим данным, а taskflow_chat_read отдаёт то же самое роли. Пустой
    // массив — отметок не было; у сообщения без виджета поля тоже нет.
    checklist_state: checklistStateOfMessage(message.id),
    attachments: attachmentsOf.all(message.id),
    // Быстрые ответы (владелец 25.09.2026, docs/ПЛАН Супер Помощник владельца/) —
    // хранятся JSON-строкой (у SQLite нет своего типа массива).
    quick_replies: message.quick_replies ? JSON.parse(message.quick_replies) : null,
    // SQLite отдаёт 0/1 числом — iOS Decodable для Bool ждёт true/false.
    is_session_marker: Boolean(message.is_session_marker),
    // Шаги хода роли (владелец 27.09.2026) — JSON-строка в chat_messages.steps.
    steps: message.steps ? savedSteps(message.steps) : null,
    // Сдача этапа (14.10.2026): главное из отчёта роли — см. chatHandoff.ts.
    handoff: chatHandoff(message),
    // Конверт роли (JSON-контракт v1, 17.10.2026): нормализованные поля
    // `ok/output/artifacts/error/next_hint/needs_human` для клиента. У сообщений
    // без конверта поля нет — старые ответы приходят как приходили.
    role_envelope: parsed?.structuredEnvelope ? compactChatReportMaterials(parsed.structuredEnvelope).envelope : parsed?.envelope ?? null,
    // Конверт ok/output в ответе роли (01.10.2026) — показываем только output.
    text: displayText,
    ...(message.steps && JSON.parse(message.steps).coordination ? {kind:"coordination",coordination:coordinationCardData(message)} : {}),
  };
}

/** Одно сообщение чата по id — в формате клиента, null если его нет. */
export function loadChatMessage(id: string) {
  const row = db
    .prepare(
      `SELECT m.*, f.name as from_user_name, f.avatar_color as from_user_color,
              f.avatar_url as from_user_avatar_url, f.initials as from_user_initials,
              t.title as task_title
         FROM chat_messages m
         LEFT JOIN users f ON f.id = m.from_user_id
         LEFT JOIN tasks t ON t.id = m.task_id
        WHERE m.id = ?`,
    )
    .get(id);
  return row ? formatChatMessage(row) : null;
}

/** Compact legacy share cards only within the same author's answer to one request.
 * Stored history remains intact; unique cards and other conversations are preserved. */
export function formatChatHistory(rows:any[]) {
  const messages=rows.map(formatChatMessage);
  const answerKey=(message:any)=>JSON.stringify([message.chat_id,message.from_user_id,message.reply_to_message_id]);
  const reported=new Map<string,Set<string>>();
  for(const message of messages){
    if(!message.reply_to_message_id || !String(message.from_user_id).startsWith("role_"))continue;
    const envelope=message.role_envelope;
    if(!Array.isArray(envelope?.output))continue;
    const reports=envelope.output.filter((block:any)=>block.type==="report" && block.report_kind==="final");
    if(!reports.length)continue;
    const refs=reported.get(answerKey(message)) ?? new Set<string>();
    for(const material of [...reports.flatMap((block:any)=>block.sections.materials),...envelope.artifacts])
      if(typeof material?.ref==="string")refs.add(material.ref);
    reported.set(answerKey(message),refs);
  }
  return messages.filter(message=>{
    if(message.role_envelope || !message.reply_to_message_id)return true;
    const refs=reported.get(answerKey(message));
    if(!refs?.size || typeof message.text!=="string")return true;
    const match=/^\`\`\`widget\s*([\s\S]*?)\s*\`\`\`$/.exec(message.text.trim());
    if(!match)return true;
    try {
      const card=JSON.parse(match[1]);
      return !(card?.type==="card" && card.link?.title==="Открыть в TaskFlow" && refs.has(card.link?.url));
    } catch { return true; }
  });
}
