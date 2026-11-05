import {canWithdrawChatMessage} from "../runtime/chatMessageWithdrawal.js";
import { projectStepsForList, type Projection } from "./windowProjection.js";
import {isQuietSystemMessage} from "./serviceNoise.js";
import { chatBlocksCached, withTextBlocks } from "./chatBlocks.js";
import {compactChatReportMaterials} from "./chatReportMaterials.js";
import {coordinationCardData} from "../runtime/chatCoordination.js";
import {isSlotResumable,numberedSlotLabel} from "./slotResolution.js";
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
import { parseRoleContractV1, structuredOutputText, type StructuredRoleEnvelopeV1 } from "./roleContractV1.js";
import { checklistStateOfMessage } from "./chatChecklist.js";
import { questionEnvelope } from "./chatQuestions.js";

// Ленивая подготовка: db.prepare с колонкой chat_message_id не должен
// падать на импорте, если миграция 053 ещё не прошла (index.ts импортирует
// маршруты раньше, чем прогоняет миграции).
let attachmentsOf: import("better-sqlite3").Statement | null = null;
let planTopicEventOf: import("better-sqlite3").Statement | null = null;
let slotTitleOf: import("better-sqlite3").Statement | null = null;
let messageSequenceOf: import("better-sqlite3").Statement | null = null;
let replySenderNameOf: import("better-sqlite3").Statement | null = null;
let reactionsOf: import("better-sqlite3").Statement | null = null;
let roleKeyOfUser: import("better-sqlite3").Statement | null = null;
let deliveryRowsOf: import("better-sqlite3").Statement | null = null;
let roleMemberOf: import("better-sqlite3").Statement | null = null;
let questionOf: import("better-sqlite3").Statement | null = null;
let questionLookupTried = false;

/** Подпись по имени для шагов из БД; инструментам трекера без подписи. */
function stepDetails(steps: SavedSteps): SavedSteps {
  for (const it of steps.items ?? []) {
    if (it.kind === "step") it.detail = stepDetailFallback(it.tool, it.detail);
  }
  return steps;
}

/**
 * К клиенту — только объект SavedSteps `{duration_ms, items, …}`.
 * Черновик после рестарта раньше писал в `chat_messages.steps` голый
 * массив items (chatLiveDraft): телефон ждал объект и падал на всей
 * ленте («The data couldn’t be read…»). Нормализуем здесь — разбор
 * формы на сервере, не на телефоне (владелец 03.11.2026 / 29.10.2026).
 */
export function normalizeSavedSteps(raw: unknown): SavedSteps | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return { duration_ms: 0, items: raw as SavedSteps["items"] };
  }
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.items)) {
    return {
      duration_ms: typeof obj.duration_ms === "number" && Number.isFinite(obj.duration_ms) ? obj.duration_ms : 0,
      items: obj.items as SavedSteps["items"],
      ...(obj.usage !== undefined ? { usage: obj.usage as SavedSteps["usage"] } : {}),
      ...(obj.code_changes !== undefined ? { code_changes: obj.code_changes as SavedSteps["code_changes"] } : {}),
    };
  }
  return null;
}

/** Шаги из БД; битая JSON-строка не должна ронять всю историю — null. */
function savedSteps(raw: string): SavedSteps | null {
  try {
    const normalized = normalizeSavedSteps(JSON.parse(raw));
    return normalized ? stepDetails(normalized) : null;
  } catch {
    return null;
  }
}

/** Строку chat_messages (с join-полями автора) привести к формату клиента.
 *
 * `projection` — «full» (по умолчанию) или «list»: в лёгкой проекции из
 * шагов убираются вывод инструмента и аргументы вызова (29.10.2026,
 * «телефон — чисто окошко»). Полные тела телефон берёт по шагу, когда
 * владелец раскрывает его: GET /api/chats/:id/messages/:messageId/steps/:stepId.
 */
export function formatChatMessage(message: any, projection: Projection = "full") {
  if (!message) return message;
  // Две одинаковые роли в плане различаются номером и для владельца (05.11.2026).
  const slotName = message.subtask_id ? numberedSlotLabel(message.subtask_id) : null;
  if (slotName) message = { ...message, from_user_name: slotName };
  message = { ...message, slot_resumable: isSlotResumable(message) };
  attachmentsOf ??= db.prepare(
    `SELECT id, file_name, mime, size FROM attachments
      WHERE chat_message_id = ? ORDER BY created_at`,
  );
  planTopicEventOf ??= db.prepare("SELECT 1 FROM plan_topic_events WHERE message_id=?");
  slotTitleOf ??= db.prepare("SELECT s.title FROM subtasks s WHERE s.task_id=? AND s.plan_node_key=? ORDER BY s.rowid DESC LIMIT 1");
  messageSequenceOf ??= db.prepare("SELECT rowid AS sequence FROM chat_messages WHERE id=?");
  replySenderNameOf ??= db.prepare("SELECT u.name FROM chat_messages m JOIN users u ON u.id=m.from_user_id WHERE m.id=?");
  reactionsOf ??= db.prepare("SELECT user_id,emoji FROM chat_message_reactions WHERE message_id=? ORDER BY user_id");
  roleKeyOfUser ??= db.prepare("SELECT role_key FROM users WHERE id=?");
  deliveryRowsOf ??= db.prepare("SELECT status FROM chat_message_queue WHERE chat_id=? AND message_id=? ORDER BY created_at DESC");
  roleMemberOf ??= db.prepare(
    "SELECT 1 FROM chat_members m JOIN users u ON u.id=m.member_id WHERE m.chat_id=? AND u.role_key IS NOT NULL LIMIT 1",
  );
  // Таблица вопросов появляется миграцией 180. До её прогона (или на старой
  // БД без неё) лента не должна падать — вопрос просто не показываем.
  if (!questionLookupTried) {
    questionLookupTried = true;
    try {
      questionOf = db.prepare("SELECT * FROM chat_questions WHERE message_id = ?");
    } catch {
      questionOf = null;
    }
  }
  const event = message.message_type === "system" || !!planTopicEventOf.get(message.id);
  // role_envelope_json — уже нормализованный конверт (JSON.stringify при записи):
  // парсим напрямую, а не через parseRoleContractV1 (там регекс + полная валидация
  // на уже проверенном конверте).
  let storedEnvelope: StructuredRoleEnvelopeV1 | null = null;
  if (typeof message.role_envelope_json === "string") {
    try {
      const raw = JSON.parse(message.role_envelope_json);
      if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.schema_version === 1) {
        storedEnvelope = raw as StructuredRoleEnvelopeV1;
      }
    } catch { /* битый конверт — ниже отдадим text как раньше */ }
  }
  // Конверта нет — пробуем снять его со старого text (plain/legacy ответы).
  const parsed = storedEnvelope
    ? null
    : typeof message.text === "string" ? parseRoleContractV1(message.text) : null;
  const { role_envelope_json: _roleEnvelopeJSON, ...messageFields } = message;
  let displayText = storedEnvelope
    ? structuredOutputText(storedEnvelope.output)
    : parsed ? parsed.text : message.text;
  if (typeof displayText === "string" && message.task_id) {
    displayText = displayText.replace(/\[slot: ([^\]]+)\]/g, (_match: string, key: string) => {
      const row = slotTitleOf!.get(message.task_id, key) as { title: string } | undefined;
      return `[этап: ${row?.title ?? key}]`;
    });
  }
  // JSON-строки из БД: одна битая / чужая форма не должны ронять всю историю.
  let rawSteps: unknown = null;
  if (typeof message.steps === "string") {
    try { rawSteps = JSON.parse(message.steps); } catch { rawSteps = null; }
  } else if (message.steps && typeof message.steps === "object") {
    rawSteps = message.steps;
  }
  const parsedSteps = normalizeSavedSteps(rawSteps);
  const coordination = rawSteps
    && typeof rawSteps === "object"
    && !Array.isArray(rawSteps)
    && Boolean((rawSteps as { coordination?: unknown }).coordination);
  const memoryUpdateRaw = rawSteps
    && typeof rawSteps === "object"
    && !Array.isArray(rawSteps)
    && (rawSteps as { memory_update?: unknown }).memory_update;
  const memoryUpdate = memoryUpdateRaw && typeof memoryUpdateRaw === "object" && !Array.isArray(memoryUpdateRaw)
    ? memoryUpdateRaw as { title?: string | null; kind?: string | null; confidence?: number | null }
    : null;
  let quickReplies: any = null;
  if (typeof message.quick_replies === "string") {
    try { quickReplies = JSON.parse(message.quick_replies); } catch { quickReplies = null; }
  }
  // Различение «сообщение сохранено» и «передано исполнителю» (карточка
  // b504958a, контракт §10): считается по очереди доставки, отдельного
  // хранилища нет.
  //
  // Признак несёт СООБЩЕНИЕ ВЛАДЕЛЬЦА, которому роль должна ответить: у
  // ответа роли доставки «исполнителю» нет вовсе, и прежний код навешивал
  // на каждый ответ роли «Сохранено» — владелец читал это как «мой запрос
  // ещё не дошёл». Очередь доставки живёт на сообщении владельца: в
  // chat_message_queue роль-получатель лежит в role_id, а сообщение — в
  // message_id. Имя поля не `delivery_state`: так уже называется колонка
  // chat_messages про доставку адресного сообщения человеку (миграция 130) —
  // это другое.
  let deliveryState: string | undefined;
  const senderIsRole = Boolean(
    (roleKeyOfUser!.get(message.from_user_id) as { role_key: string | null } | undefined)?.role_key,
  );
  if (message.chat_id && !senderIsRole && roleMemberOf!.get(message.chat_id)) {
    const statuses = (deliveryRowsOf!.all(message.chat_id, message.id) as Array<{ status: string }>).map(
      (row) => row.status,
    );
    deliveryState = statuses.includes("picked") || statuses.includes("done")
      ? "accepted"
      : statuses.includes("pending")
        ? "queued"
        : statuses.length
          ? "stale"
          : "saved";
  }
  return {
    ...messageFields,
    sequence: message.sequence ?? (messageSequenceOf!.get(message.id) as { sequence: number } | undefined)?.sequence ?? null,
    kind: event ? "system" : message.message_type ?? message.kind,
    ...(event ? { from_user_id: "taskflow_system", from_user_name: "Система", from_user_initials: "С", from_user_avatar_url: null } : {}),
    reply_to_sender_name: message.reply_to_message_id ? (replySenderNameOf!.get(message.reply_to_message_id) as { name: string } | undefined)?.name : null,
    reactions: reactionsOf!.all(message.id),
    ...(deliveryState ? { queue_delivery_state: deliveryState } : {}),
    can_withdraw: !senderIsRole && !event && canWithdrawChatMessage(message.chat_id, message.id),
    checklist_state: checklistStateOfMessage(message.id),
    attachments: attachmentsOf.all(message.id),
    quick_replies: quickReplies,
    // Уточнение роли у владельца (26.10.2026): вопрос виден в ленте как
    // карточка. Поля — как читает iOS-клиент (ChatQuestion.swift): дата
    // `created_at`, варианты `multiSelect`, ответ — массив записей.
    question: questionEnvelope(questionOf ? (questionOf.get(message.id) as any) : undefined),
    is_session_marker: Boolean(message.is_session_marker),
    // Прерванный ответ помечен явно: почему прерван и сохранён ли частично
    // (карточка 252c400e, §2.1). Поля аддитивные — старый клиент их игнорирует.
    stop_reason: message.stop_reason ?? null,
    partial: Boolean(message.partial),
    steps: parsedSteps
      ? stepDetails(
          (projection === "list" ? projectStepsForList(parsedSteps) : parsedSteps) as SavedSteps,
        )
      : null,
    handoff: withTextBlocks(chatHandoff(message), ["summary"]),
    role_envelope: withTextBlocks(storedEnvelope
      ? compactChatReportMaterials(storedEnvelope).envelope
      : parsed?.structuredEnvelope ? compactChatReportMaterials(parsed.structuredEnvelope).envelope : parsed?.envelope ?? null, ["output"]),
    text: displayText,
    // Ответ готовыми блоками: клиент рисует их, сам текст не разбирает (lib/chatBlocks.ts).
    blocks: typeof displayText === "string" && displayText ? chatBlocksCached(displayText) : [],
    ...(coordination ? { kind: "coordination", coordination: withTextBlocks(coordinationCardData(message), ["question", "answer"]) } : {}),
    ...(memoryUpdate ? {
      kind: "memory_update",
      memory_update: {
        title: typeof memoryUpdate.title === "string" ? memoryUpdate.title : null,
        kind: typeof memoryUpdate.kind === "string" ? memoryUpdate.kind : null,
        confidence: typeof memoryUpdate.confidence === "number" ? memoryUpdate.confidence : null,
      },
    } : {}),
  };
}

/** Одно сообщение чата по id — в формате клиента, null если его нет. */
export function loadChatMessage(id: string) {
  const row = db
    .prepare(
      `SELECT m.*, m.rowid AS sequence, f.name as from_user_name, f.avatar_color as from_user_color,
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
export function formatChatHistory(rows:any[], projection: Projection = "full") {
  const messages=rows.map((row:any)=>formatChatMessage(row,projection)).filter(message=>!isQuietSystemMessage(message));
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
