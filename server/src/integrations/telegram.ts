import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "../db.js";
import { DB_PATH } from "../db.js";
import { SECRETARY_CHAT_ID } from "../lib/secretaryReply.js";
import { enqueueMessageDelivery } from "../runtime/chatQueue.js";
import { resolveTelegramCommandText } from "../lib/telegramCommands.js";
import { bindTopic, knownThreadOfRoom, normalizeThreadId, parseTopicCommand, telegramTopicsEnabled, topicReplyText, topicTargetChat } from "../lib/telegramTopics.js";
import { normalizeTelegramTables, splitTelegramText, telegramRichHtml, envelopePlainText, TELEGRAM_PART_LIMIT, TELEGRAM_PART_PAUSE_MS, TELEGRAM_MAX_PARTS } from "../lib/telegramRich.js";
import type { StructuredRoleEnvelopeV1 } from "../lib/roleContractV1.js";

export const TELEGRAM_MAX_BYTES = 15 * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), "uploads");
const SECRETARY_USER_ID = "u-secretary";

type AttachmentInput = {
  file_name: string;
  mime: string;
  data_base64: string;
  kind?: "photo" | "document" | "voice" | "audio";
  transcript?: string;
};

export type TelegramInbound = {
  bot_id: string;
  update_id: number;
  chat_id: number;
  user_id: number;
  chat_type: string;
  message_id: number;
  /**
   * Топик (этап 7): `message_thread_id` входящего — часть адреса беседы
   * `{channel, account, chat, thread, principal}`. Адресация в личном чате
   * именно `message_thread_id` (живой факт 06.11.2026), `direct_messages_topic_id`
   * там не доставляет. Не пришёл — NULL: общий топик, прежнее поведение.
   */
  thread_id?: number | null;
  text?: string;
  caption?: string;
  /** Текст для роли: явный вызов команды уже разрешён на сервере (этап 2). */
  role_text?: string;
  attachments?: AttachmentInput[];
};

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} не задан`);
  return value;
}

export function telegramConfig() {
  return {
    secret: requiredEnv("TASKFLOW_TELEGRAM_INTEGRATION_SECRET"),
    botId: requiredEnv("TASKFLOW_TELEGRAM_BOT_ID"),
    chatId: requiredEnv("TASKFLOW_TELEGRAM_OWNER_CHAT_ID"),
    userId: requiredEnv("TASKFLOW_TELEGRAM_OWNER_USER_ID"),
  };
}

export function isLoopback(ip: string | undefined): boolean {
  const value = String(ip ?? "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1";
}

export function secureSecretEqual(actual: unknown, expected: string): boolean {
  const a = Buffer.from(String(actual ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeAttachment(input: AttachmentInput): { name: string; mime: string; bytes: Buffer } {
  const name = path.basename(String(input.file_name || "файл")).slice(0, 200);
  const mime = String(input.mime || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const bytes = Buffer.from(String(input.data_base64 || ""), "base64");
  if (!bytes.length) throw new Error("empty_attachment");
  if (bytes.length > TELEGRAM_MAX_BYTES) throw new Error("attachment_too_large");
  if (/^(application\/(zip|x-7z-compressed|x-rar-compressed|x-tar|gzip)|application\/x-)/.test(mime)) throw new Error("unsafe_attachment_type");
  if (/\.(exe|dll|com|bat|cmd|ps1|app|apk|jar|msi|dmg|pkg|zip|7z|rar|tar|gz)$/i.test(name)) throw new Error("unsafe_attachment_name");
  const allowed = /^(image\/|audio\/|text\/|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.|json|xml|yaml|x-yaml|octet-stream))/.test(mime);
  if (!allowed) throw new Error("unsupported_attachment_type");
  return { name, mime, bytes };
}

function normalizedHash(input: TelegramInbound): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    bot_id: input.bot_id,
    update_id: input.update_id,
    chat_id: input.chat_id,
    user_id: input.user_id,
    message_id: input.message_id,
    text: input.text ?? "",
    caption: input.caption ?? "",
    attachments: (input.attachments ?? []).map((a) => [a.file_name, a.mime, Buffer.byteLength(a.data_base64 ?? "", "base64")]),
  })).digest("hex");
}

export async function transcribeTelegramAudio(bytes: Buffer, mime: string): Promise<string | null> {
  const base = String(process.env.ASR_BASE_URL || "http://192.168.1.110:1235").replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/asr`, {
      method: "POST",
      headers: { "content-type": mime || "audio/ogg" },
      body: new Blob([Uint8Array.from(bytes)]),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { text?: unknown };
    return typeof data.text === "string" && data.text.trim() ? data.text.trim() : null;
  } catch {
    return null;
  }
}

function ownerId(): string {
  const row = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
  if (!row) throw new Error("owner_not_found");
  return row.id;
}

function validateInbound(input: TelegramInbound): void {
  const cfg = telegramConfig();
  if (String(input.bot_id) !== cfg.botId) throw new Error("bot_not_allowed");
  if (String(input.chat_id) !== cfg.chatId || String(input.user_id) !== cfg.userId) throw new Error("principal_not_allowed");
  if (input.chat_type !== "private" || input.chat_id !== input.user_id) throw new Error("private_chat_required");
  if (!Number.isSafeInteger(input.update_id) || !Number.isSafeInteger(input.message_id)) throw new Error("invalid_telegram_id");
  const pending = db.prepare("SELECT COUNT(*) AS n FROM telegram_inbound_ledger WHERE bot_id=? AND chat_id=? AND state IN ('received','authorized','materializing')").get(input.bot_id, String(input.chat_id)) as { n: number };
  if (pending.n >= 3) throw new Error("conversation_queue_full");
  const recent = db.prepare("SELECT COUNT(*) AS n FROM telegram_inbound_ledger WHERE bot_id=? AND user_id=? AND received_at >= datetime('now','-1 minute')").get(input.bot_id, String(input.user_id)) as { n: number };
  if (recent.n >= 10) throw new Error("rate_limited");
}

function createAttachment(owner: string, input: AttachmentInput): string {
  const file = safeAttachment(input);
  const id = crypto.randomUUID();
  const storedName = `${id}${path.extname(file.name).slice(0, 12)}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), file.bytes, { flag: "wx" });
  db.prepare(`INSERT INTO attachments(id,task_id,comment_id,chat_message_id,kind,user_id,file_name,mime,size,stored_name)
    VALUES(?,NULL,NULL,NULL,'comment',?,?,?,?,?)`).run(id, owner, file.name, file.mime, file.bytes.length, storedName);
  return id;
}

// Контракт outbox (этап 0 плана note://a2475482): `kind` — категория политики
// (что делать при провале), `payload.method` — транспорт Bot API. Смешивать оси
// без таблицы соответствия нельзя, поэтому она здесь и является единственным
// источником правды: неизвестный метод gateway помечает `abandoned` с логом,
// а не падает. Новых колонок нет — `payload_json` свободный JSON (миграции нет).
export type TelegramDeliveryKind = "ack" | "progress" | "final" | "error";

export const TELEGRAM_METHOD_POLICY = {
  sendMessage: { kinds: ["ack", "progress", "final", "error"] },
  // Rich-сообщение (Bot API 10.1, проверено живьём 06.11.2026): текст, разметка
  // и таблицы одним блоком. Сбой метода — откат на sendMessage в gateway.
  sendRichMessage: { kinds: ["final"] },
  editMessageText: { kinds: ["progress", "final"] },
  editMessageReplyMarkup: { kinds: ["progress"] },
  setMessageReaction: { kinds: ["progress", "final", "error"] },
  sendMessageDraft: { kinds: ["progress"] },
  // Топики (этап 7): Bot API дёргает только gateway, сервер ставит намерение.
  // `createForumTopic` возвращает id треда — тема привязки к комнате появляется
  // при ответе сервера на `/topic` (см. lib/telegramTopics.ts).
  createForumTopic: { kinds: ["ack"] },
  editForumTopic: { kinds: ["ack"] },
} as const;

export type TelegramMethod = keyof typeof TELEGRAM_METHOD_POLICY;
export const TELEGRAM_KNOWN_METHODS: string[] = Object.keys(TELEGRAM_METHOD_POLICY);

export function isKnownTelegramMethod(method: unknown): method is TelegramMethod {
  return typeof method === "string" && TELEGRAM_KNOWN_METHODS.includes(method);
}

/**
 * Поставить намерение в outbox.
 *
 * `payload` — свободный объект: аргументы Bot API плюс служебные поля
 * (`reply_to_message_id`, `disable_notification`, `draft`, `reaction`).
 * Транспорт берётся из `payload.method`; без метода доставка уходит
 * `sendMessage` — так прежние вызовы (progress/final) сохраняют поведение.
 */
export function enqueueTelegramDelivery(args: {
  kind: TelegramDeliveryKind;
  chatId: string;
  payload: Record<string, unknown>;
  replyToMessageId?: number | null;
  sourceMessageId?: string | null;
  /** Топик беседы (этап 7): в него адресуется доставка и по нему же
   *  отличается строка статуса — у общих и разных топиков она своя. */
  threadId?: number | null;
}): string {
  const id = crypto.randomUUID();
  // Метод сохраняем как есть: неизвестный транспорт — забота gateway (он
  // помечает доставку abandoned с логом). Подставляем sendMessage только когда
  // метода нет вовсе — так прежние вызовы (progress/final) не меняют поведение.
  const rawMethod = args.payload.method;
  const method = typeof rawMethod === "string" && rawMethod.trim() ? rawMethod.trim() : "sendMessage";
  const threadId = Number(args.threadId ?? 0);
  const payload = {
    ...args.payload,
    method,
    reply_to_message_id: args.replyToMessageId ?? (args.payload.reply_to_message_id as number | null | undefined) ?? null,
    ...(Number.isSafeInteger(threadId) && threadId > 0 ? { message_thread_id: threadId } : {}),
  };
  db.prepare(`INSERT INTO telegram_delivery_outbox(delivery_id,bot_id,chat_id,kind,payload_json,state,next_attempt_at,source_message_id,thread_id)
    VALUES(?,?,?,?,?,'pending',datetime('now'),?,?)`).run(id, telegramConfig().botId, args.chatId, args.kind, JSON.stringify(payload), args.sourceMessageId ?? null, Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null);
  return id;
}

/** Реакции выключены по умолчанию (как `telegram.reactions` у Hermes). */
export function telegramReactionsEnabled(): boolean {
  const value = String(process.env.TASKFLOW_TELEGRAM_REACTIONS ?? "").trim().toLowerCase();
  return value === "1" || value === "on" || value === "true" || value === "yes";
}

/** Транспорт живого потока: `auto` — черновик с безусловным откатом на правку. */
export function telegramStreamMode(): "auto" | "draft" | "edit" | "off" {
  const value = String(process.env.TASKFLOW_TELEGRAM_STREAM ?? "").trim().toLowerCase();
  return value === "draft" || value === "edit" || value === "off" ? value : "auto";
}

/** `draft_id` стабилен на ход и не равен нулю — требование Bot API. */
export function telegramDraftId(triggerMessageId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < triggerMessageId.length; index++) {
    hash ^= triggerMessageId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const value = (hash >>> 0) % 2_000_000_000;
  return value === 0 ? 1 : value;
}

/** Одна реакция на сообщение: 👀 в начале, 👍 на финале, 👎 на ошибке. */
export function enqueueTelegramReaction(args: {
  kind: TelegramDeliveryKind;
  chatId: string;
  messageId: number;
  emoji: string;
  sourceMessageId?: string | null;
}): string | null {
  if (!telegramReactionsEnabled()) return null;
  return enqueueTelegramDelivery({
    kind: args.kind,
    chatId: args.chatId,
    payload: { method: "setMessageReaction", message_id: args.messageId, reaction: [{ type: "emoji", emoji: args.emoji }] },
    sourceMessageId: args.sourceMessageId ?? null,
  });
}

// Статус-сообщение в Telegram (владелец 06.11.2026): вместо мгновенного
// «Принял.» — как в Hermes, одна обновляемая строка, и только если ход реально
// затянулся. Пузырь один на ход: повторно не шлём, финальный ответ уходит
// обычной доставкой `final`.
export function captureTelegramProgress(triggerMessageId: string, tool?: string): number {
  const links = db.prepare(`SELECT chat_id,message_id,thread_id FROM telegram_inbound_ledger
    WHERE taskflow_message_id=? AND state='posted'`).all(triggerMessageId) as Array<{ chat_id: string; message_id: number; thread_id: number | null }>;
  if (!links.length) return 0;
  const already = db.prepare("SELECT 1 FROM telegram_delivery_outbox WHERE kind='progress' AND source_message_id=?").get(triggerMessageId);
  if (already) return 0;
  const answered = db.prepare("SELECT 1 FROM chat_messages WHERE reply_to_message_id=? AND from_user_id=?").get(triggerMessageId, SECRETARY_USER_ID);
  if (answered) return 0;
  const label = tool ? `Работаю: ${tool}` : "Работаю над ответом…";
  // В режиме черновика строку статуса не заводим: черновик и есть статус
  // (этап 4 плана). При откате gateway на правку пузырь создастся первым тиком.
  if (telegramStreamMode() === "auto" || telegramStreamMode() === "draft") return 0;
  for (const link of links) {
    // Прогресс идёт без звука (владелец 06.11.2026): звенит только финал.
    enqueueTelegramDelivery({ kind: "progress", chatId: link.chat_id, payload: { text: label, disable_notification: true }, replyToMessageId: link.message_id, sourceMessageId: triggerMessageId, threadId: link.thread_id });
  }
  return links.length;
}

const PROGRESS_DELAY_MS = 10_000;
const progressTimers = new Map<string, NodeJS.Timeout>();

/** Заводит единственное статус-сообщение, если ход не уложился в 10 секунд. */
export function scheduleTelegramProgress(triggerMessageId: string): void {
  if (progressTimers.has(triggerMessageId)) return;
  const timer = setTimeout(() => {
    progressTimers.delete(triggerMessageId);
    try { captureTelegramProgress(triggerMessageId); } catch { /* статус — не повод ломать ход */ }
  }, PROGRESS_DELAY_MS);
  timer.unref?.();
  progressTimers.set(triggerMessageId, timer);
}

export function cancelTelegramProgress(triggerMessageId: string): void {
  const timer = progressTimers.get(triggerMessageId);
  if (timer) { clearTimeout(timer); progressTimers.delete(triggerMessageId); }
  const stream = streamTimers.get(triggerMessageId);
  if (stream) { clearInterval(stream); streamTimers.delete(triggerMessageId); }
}

const STREAM_INTERVAL_MS = 2_000;
const STREAM_MAX = 3_800;
const streamTimers = new Map<string, NodeJS.Timeout>();

/** Живой поток ответа в Telegram, как у Hermes: та же одна строка статуса
 *  правится и наполняется текстом по мере генерации. Финал заменяет её целиком. */
export function startTelegramStream(triggerMessageId: string, readText: () => string): void {
  if (telegramStreamMode() === "off") return;
  let last = "";
  const tick = () => {
    try {
      let text = String(readText() || "").trim();
      if (!text) return;
      if (text.length > STREAM_MAX) text = "…" + text.slice(-STREAM_MAX);
      if (text === last) return;
      last = text;
      const links = db.prepare(`SELECT chat_id,message_id,thread_id FROM telegram_inbound_ledger
        WHERE taskflow_message_id=? AND state='posted'`).all(triggerMessageId) as Array<{ chat_id: string; message_id: number; thread_id: number | null }>;
      const draft = telegramStreamMode() === "auto" || telegramStreamMode() === "draft"
        ? { draft_id: telegramDraftId(triggerMessageId) }
        : null;
      for (const link of links) {
        enqueueTelegramDelivery({
          kind: "progress",
          chatId: link.chat_id,
          payload: draft
            ? { method: "sendMessageDraft", text, draft, disable_notification: true }
            : { text, disable_notification: true },
          replyToMessageId: link.message_id,
          sourceMessageId: null,
          threadId: link.thread_id,
        });
      }
    } catch { /* поток — не повод ломать ход */ }
  };
  if (streamTimers.has(triggerMessageId)) return;
  const timer = setInterval(tick, STREAM_INTERVAL_MS);
  timer.unref?.();
  streamTimers.set(triggerMessageId, timer);
}

export async function acceptTelegramInbound(input: TelegramInbound): Promise<{ duplicate: boolean; ledger_id: string; message_id: string | null; ack_delivery_id: string | null; queue_row_id: string | null; chat_id: string; role_id: string; thread_id: number | null; topic_action: "created" | "renamed" | "pending" | null; topic_title: string | null }> {
  const existing = db.prepare("SELECT id,taskflow_message_id,ack_delivery_id FROM telegram_inbound_ledger WHERE bot_id=? AND update_id=?").get(String(input.bot_id), input.update_id) as { id: string; taskflow_message_id: string | null; ack_delivery_id: string | null } | undefined;
  if (existing) return { duplicate: true, ledger_id: existing.id, message_id: existing.taskflow_message_id, ack_delivery_id: existing.ack_delivery_id, queue_row_id: null, chat_id: SECRETARY_CHAT_ID, role_id: SECRETARY_USER_ID, thread_id: null, topic_action: null, topic_title: null };
  // Тред — часть адреса беседы (этап 7). Выключенные топики его не читают:
  // прежнее поведение один в один (все сообщения — в комнату Секретаря).
  const threadId = telegramTopicsEnabled() ? normalizeThreadId(input.thread_id) : null;
  const ledgerId = crypto.randomUUID();
  const hash = normalizedHash(input);
  db.prepare(`INSERT INTO telegram_inbound_ledger(id,bot_id,update_id,chat_id,user_id,message_id,payload_hash,state,thread_id)
    VALUES(?,?,?,?,?,?,?,'received',?)`).run(ledgerId, String(input.bot_id), input.update_id, String(input.chat_id), String(input.user_id), input.message_id, hash, threadId);
  try {
    validateInbound(input);
    db.prepare("UPDATE telegram_inbound_ledger SET state='authorized',authorized_at=datetime('now') WHERE id=?").run(ledgerId);
    const owner = ownerId();
    const attachmentIds: string[] = [];
    db.prepare("UPDATE telegram_inbound_ledger SET state='materializing' WHERE id=?").run(ledgerId);
    for (const item of input.attachments ?? []) attachmentIds.push(createAttachment(owner, item));
    const text = [String(input.text ?? "").trim(), String(input.caption ?? "").trim()].filter(Boolean).join("\n").trim() || (attachmentIds.length ? "[Вложение из Telegram]" : "");
    if (!text) throw new Error("empty_message");
    // Владелец видит в чате то, что написал; роли уходит разрешённый вызов
    // команды, если сервер его разобрал (иначе тот же текст).
    let roleText = String(input.role_text ?? "").trim() || text;
    const messageId = crypto.randomUUID();
    // Выбор команды в меню бота исполняется существующим путём: `/имя` из
    // реестра переводится в `/skill:имя` или `/mcp:имя` и проверяется тем же
    // resolveSlashCommand. Неизвестная команда — обычный текст, без догадок.
    const command = await resolveTelegramCommandText(text).catch(() => null);
    if (command && !command.ok) throw new Error("unknown_command");
    if (command?.ok) roleText = command.role_text;
    // `/topic <имя>` — своя команда рабочего пространства (этап 7): она не ход
    // роли, а привязка топика к комнате. Распознаётся до маршрутизации хода.
    const topicCommand = telegramTopicsEnabled() ? parseTopicCommand(text) : null;
    if (topicCommand && !topicCommand.ok) {
      // Топик без имени — не ошибка сервера, а подсказка владельцу: команда
      // не должна превращаться в ход роли.
      enqueueTelegramDelivery({ kind: "ack", chatId: String(input.chat_id), payload: { text: "Назовите топик: /topic Работа", disable_notification: true }, replyToMessageId: input.message_id, threadId });
      db.prepare("UPDATE telegram_inbound_ledger SET state='posted',posted_at=datetime('now') WHERE id=?").run(ledgerId);
      return { duplicate: false, ledger_id: ledgerId, message_id: null, ack_delivery_id: null, queue_row_id: null, chat_id: SECRETARY_CHAT_ID, role_id: SECRETARY_USER_ID, thread_id: threadId, topic_action: null, topic_title: null };
    }
    let topicTarget = SECRETARY_CHAT_ID;
    let topicRole = SECRETARY_USER_ID;
    let topicThread: number | null = threadId;
    let topicAction: "created" | "renamed" | "pending" | null = null;
    let topicTitle: string | null = null;
    if (topicCommand?.ok) {
      let requested;
      try {
        requested = requestTopic(topicCommand.action, topicCommand.title, {
          botId: String(input.bot_id), chatId: String(input.chat_id), threadId,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "topic_failed";
        enqueueTelegramDelivery({ kind: "ack", chatId: String(input.chat_id), payload: { text: `Топик не переименован: ${code === "topic_required" ? "сначала создайте топик командой /topic Название" : "попробуйте ещё раз"}`, disable_notification: true }, replyToMessageId: input.message_id, threadId });
        db.prepare("UPDATE telegram_inbound_ledger SET state='posted',posted_at=datetime('now') WHERE id=?").run(ledgerId);
        return { duplicate: false, ledger_id: ledgerId, message_id: null, ack_delivery_id: null, queue_row_id: null, chat_id: SECRETARY_CHAT_ID, role_id: SECRETARY_USER_ID, thread_id: threadId, topic_action: null, topic_title: null };
      }
      topicAction = requested.action;
      topicTitle = requested.title;
      topicTarget = requested.chatId;
      topicRole = requested.roleId;
      topicThread = requested.threadId ?? threadId;
    } else if (threadId) {
      const target = topicTargetChat(input.bot_id, input.chat_id, threadId);
      topicTarget = target.chatId;
      topicRole = target.roleId;
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,work_mode,execution_mode)
        VALUES(?,?,?,'chat',?,'work','chat')`).run(messageId, owner, text, topicTarget);
      const attach = db.prepare("UPDATE attachments SET chat_message_id=? WHERE id=? AND user_id=? AND chat_message_id IS NULL");
      for (const id of attachmentIds) attach.run(messageId, id, owner);
      db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(topicTarget);
      db.prepare("UPDATE telegram_inbound_ledger SET state='posted',posted_at=datetime('now'),taskflow_message_id=? WHERE id=?").run(messageId, ledgerId);
    })();
    // `/topic` — служебная команда: ход роли не поднимаем. На создание ответ
    // придёт после ответа Bot API (id треда известен только тогда), на
    // переименование — сразу, топик уже известен.
    if (topicCommand?.ok) {
      if (topicAction !== "pending") {
        enqueueTelegramDelivery({
          kind: "ack",
          chatId: String(input.chat_id),
          payload: { text: topicReplyText(topicAction, topicTitle, topicThread), disable_notification: true },
          replyToMessageId: input.message_id,
          threadId: topicThread,
        });
      }
      return { duplicate: false, ledger_id: ledgerId, message_id: messageId, ack_delivery_id: null, queue_row_id: null, chat_id: topicTarget, role_id: topicRole, thread_id: topicThread, topic_action: topicAction, topic_title: topicTitle };
    }
    const durable = enqueueMessageDelivery({ chatId: topicTarget, roleId: topicRole, deliveryId: `tg:${input.bot_id}:${input.update_id}`, messageId, payload: { hop: 0, mode: "work", text: roleText } });
    // Немедленного «Принял.» нет: Telegram получает статус только если ход
    // тянется дольше 10 секунд (scheduleTelegramProgress в чат-рантайме).
    // Реакция 👀 — сразу после успешного inbound: владелец видит, что запрос
    // принят, не дожидаясь статуса (выключатель TASKFLOW_TELEGRAM_REACTIONS).
    enqueueTelegramReaction({ kind: "progress", chatId: String(input.chat_id), messageId: input.message_id, emoji: "👀", sourceMessageId: null });
    scheduleTelegramProgress(messageId);
    return { duplicate: false, ledger_id: ledgerId, message_id: messageId, ack_delivery_id: null, queue_row_id: durable.id, chat_id: topicTarget, role_id: topicRole, thread_id: topicThread, topic_action: null, topic_title: null };
  } catch (error) {
    const code = error instanceof Error ? error.message : "inbound_failed";
    db.prepare("UPDATE telegram_inbound_ledger SET state='rejected',error_code=?,finished_at=datetime('now') WHERE id=?").run(code, ledgerId);
    throw error;
  }
}

export function telegramOutbox(limit = 20) {
  db.prepare("UPDATE telegram_delivery_outbox SET state='ambiguous',last_error='sending lease expired',updated_at=datetime('now') WHERE state='sending' AND updated_at < datetime('now','-2 minutes')").run();
  return db.prepare(`SELECT delivery_id,chat_id,thread_id,kind,payload_json,attempts,state,next_attempt_at FROM telegram_delivery_outbox
    WHERE state IN ('pending','retry_wait','ambiguous') AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now')) ORDER BY created_at LIMIT ?`).all(limit);
}

export function markTelegramSending(id: string): boolean {
  return db.prepare("UPDATE telegram_delivery_outbox SET state='sending',attempts=attempts+1,updated_at=datetime('now') WHERE delivery_id=? AND state IN ('pending','retry_wait','ambiguous')").run(id).changes === 1;
}

export function settleTelegramDelivery(id: string, result: { ok?: boolean; permanent?: boolean; ambiguous?: boolean; retryAfterSeconds?: number; telegramMessageId?: number; error?: string; parts?: Array<{ index: number; sent: boolean }>; threadId?: number }) {
  // Части одной доставки: gateway отмечает отправленные, чтобы после сбоя
  // середины повторялась только она, без дубля первой (DoD этапа 5).
  // Запись «только прогресс частей» приходит без ok и состояние не меняет.
  if (Array.isArray(result.parts) && result.parts.length) {
    try {
      const row = db.prepare("SELECT payload_json FROM telegram_delivery_outbox WHERE delivery_id=?").get(id) as { payload_json: string } | undefined;
      if (row) {
        const payload = JSON.parse(row.payload_json) as { parts?: Array<{ index?: number; sent?: boolean }> };
        if (Array.isArray(payload.parts)) {
          for (const part of result.parts) {
            const target = payload.parts.find((item) => Number(item.index) === Number(part.index));
            if (target) target.sent = part.sent === true;
          }
          db.prepare("UPDATE telegram_delivery_outbox SET payload_json=?,updated_at=datetime('now') WHERE delivery_id=?").run(JSON.stringify(payload), id);
        }
      }
    } catch { /* прогресс частей не должен ломать расчёт исхода доставки */ }
    if (result.ok === undefined) return;
  }
  if (result.ok) {
    db.prepare("UPDATE telegram_delivery_outbox SET state='delivered',telegram_message_id=?,delivered_at=datetime('now'),updated_at=datetime('now'),last_error=NULL WHERE delivery_id=?").run(result.telegramMessageId ?? null, id);
    settleTelegramTopicDelivery(id, result);
    return;
  }
  const row = db.prepare("SELECT attempts FROM telegram_delivery_outbox WHERE delivery_id=?").get(id) as { attempts: number } | undefined;
  if (!row) return;
  if (result.permanent || row.attempts >= 4) {
    db.prepare("UPDATE telegram_delivery_outbox SET state='abandoned',last_error=?,updated_at=datetime('now') WHERE delivery_id=?").run(result.error ?? "delivery failed", id);
    return;
  }
  if (result.ambiguous) {
    db.prepare("UPDATE telegram_delivery_outbox SET state='ambiguous',last_error=?,next_attempt_at=datetime('now','+120 seconds'),updated_at=datetime('now') WHERE delivery_id=?").run(result.error ?? "ambiguous send", id);
    return;
  }
  const delays = [5, 30, 120];
  const seconds = result.retryAfterSeconds ?? delays[Math.max(0, Math.min(delays.length - 1, row.attempts - 1))];
  db.prepare("UPDATE telegram_delivery_outbox SET state='retry_wait',last_error=?,next_attempt_at=datetime('now',?),updated_at=datetime('now') WHERE delivery_id=?").run(result.error ?? "delivery failed", `+${seconds} seconds`, id);
}

/**
 * Вопрос роли → Telegram с inline-кнопками (этап 3 плана note://a2475482).
 *
 * Отдельная доставка от финала: у финала свой уникальный индекс
 * `(source_message_id, kind='final')`, а вопрос — своё сообщение с клавиатурой.
 * Подпись — `renderQuestionText`, уже готовая для Telegram, плюс строка про
 * номер/текст: кнопки не единственный путь ответа.
 */
export function captureQuestionToTelegram(questionId: string): number {
  const question = db
    .prepare("SELECT id,chat_id,message_id,payload_json,created_at FROM chat_questions WHERE id=?")
    .get(questionId) as { id: string; chat_id: string; message_id: string | null; payload_json: string; created_at: string } | undefined;
  if (!question || !question.message_id) return 0;
  // Ledger связывает входящее из Telegram с сообщением чата; вопрос — ответ на
  // это входящее, поэтому ищем ответ на сообщение-вопрос (как captureTelegramFinal).
  const questionMessage = db
    .prepare("SELECT reply_to_message_id FROM chat_messages WHERE id=?")
    .get(question.message_id) as { reply_to_message_id: string | null } | undefined;
  if (!questionMessage?.reply_to_message_id) return 0;
  let payload: { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }> }> } = {};
  try { payload = JSON.parse(question.payload_json); } catch { return 0; }
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const keyboard = telegramQuestionKeyboard(question.id, { questions: questions.map((q) => ({ options: (q.options ?? []).map((o) => ({ label: String(o.label ?? "") })) })) });
  if (!keyboard) return 0;
  const links = db.prepare(`SELECT chat_id,message_id,thread_id FROM telegram_inbound_ledger
    WHERE taskflow_message_id=? AND state='posted'`).all(questionMessage.reply_to_message_id) as Array<{ chat_id: string; message_id: number; thread_id: number | null }>;
  let count = 0;
  for (const link of links) {
    // kind='ack': вопрос — не финал хода. Иначе gateway погасил бы «печатает…»
    // (для kind='final' он это делает), а ход ещё ждёт ответа.
    enqueueTelegramDelivery({
      kind: "ack",
      chatId: link.chat_id,
      payload: { text: renderTelegramQuestionText(questions), reply_markup: keyboard },
      replyToMessageId: link.message_id,
      sourceMessageId: question.message_id,
      threadId: link.thread_id,
    });
    count++;
  }
  return count;
}

/** Текст вопроса для Telegram: нумерованный список вариантов — ответ номером
 *  работает и тогда, когда кнопки уже погашены по TTL. */
function renderTelegramQuestionText(questions: Array<{ question?: string; header?: string; options?: Array<{ label?: string; description?: string }> }>): string {
  const lines: string[] = [];
  questions.slice(0, TELEGRAM_QUESTION_MAX_ROWS).forEach((question, questionIndex) => {
    if (questionIndex === 0) lines.push("Нужен ответ на вопрос.");
    const header = question.header ? `${question.header}: ` : "";
    lines.push(`${questionIndex + 1}. ${header}${String(question.question ?? "")}`);
    (question.options ?? []).forEach((option, optionIndex) => {
      if (optionIndex >= 4) return;
      lines.push(`   ${questionIndex + 1}.${optionIndex + 1} — ${String(option.label ?? "")}${option.description ? ` (${option.description})` : ""}`);
    });
  });
  lines.push("Нажми кнопку или ответь номером/текстом.");
  return lines.join("\n").slice(0, 4000);
}

/** Убрать клавиатуру у сообщения вопроса (отвечен или истёк срок кнопок).
 *  `source_message_id` — сообщение вопроса: по нему видно, что клавиатура уже
 *  снята, и повторная проверка срока не ставит вторую такую доставку. */
export function releaseTelegramQuestionKeyboard(questionMessageId: string, chatId: string, messageId: number, threadId?: number | null): string | null {
  return enqueueTelegramDelivery({
    kind: "progress",
    chatId,
    payload: { method: "editMessageReplyMarkup", message_id: messageId, reply_markup: { inline_keyboard: [] } },
    sourceMessageId: questionMessageId,
    threadId: threadId ?? null,
  });
}

/**
 * Истёк срок кнопок: у вопросов старше TELEGRAM_QUESTION_TTL_SECONDS и без
 * клавиатуры снимаем её. Статус вопроса не меняется: ход ждёт ответ 30 мин
 * (questionWait.QUESTION_WAIT_MS), а текстовый ответ работает всегда.
 * Вызывается из /api/integrations/telegram/outbox — систему таймеров не заводим.
 */
export function expireTelegramQuestionKeyboards(): number {
  let links: Array<{ chat_id: string; message_id: number; question_id: string; question_message_id: string; thread_id: number | null }> = [];
  try {
    links = db.prepare(`SELECT q.id AS question_id, q.message_id AS question_message_id, l.chat_id AS chat_id, l.message_id AS message_id, l.thread_id AS thread_id
        FROM chat_questions q
        JOIN chat_messages m ON m.id = q.message_id
        JOIN telegram_inbound_ledger l
          ON l.taskflow_message_id = m.reply_to_message_id AND l.state = 'posted'
       WHERE q.created_at <= datetime('now', ?)
         AND EXISTS (
           SELECT 1 FROM telegram_delivery_outbox d
            WHERE d.source_message_id = q.message_id AND d.kind = 'ack'
              AND d.payload_json LIKE '%inline_keyboard%'
              AND d.state = 'delivered'
         )
         AND NOT EXISTS (
           SELECT 1 FROM telegram_delivery_outbox d
            WHERE d.source_message_id = q.message_id AND d.kind = 'progress'
              AND d.payload_json LIKE '%editMessageReplyMarkup%'
         )`).all(`-${TELEGRAM_QUESTION_TTL_SECONDS} seconds`) as Array<{ chat_id: string; message_id: number; question_id: string; question_message_id: string; thread_id: number | null }>;
  } catch {
    return 0;
  }
  let count = 0;
  for (const link of links) {
    releaseTelegramQuestionKeyboard(link.question_message_id, link.chat_id, link.message_id, link.thread_id);
    count++;
  }
  return count;
}

export function captureTelegramFinal(messageId: string): number {
  const reply = db.prepare("SELECT id,text,role_envelope_json,reply_to_message_id,from_user_id,stop_reason,partial FROM chat_messages WHERE id=?").get(messageId) as { id: string; text: string; role_envelope_json: string | null; reply_to_message_id: string | null; from_user_id: string; stop_reason: string | null; partial: number | null } | undefined;
  if (!reply || reply.from_user_id !== SECRETARY_USER_ID || !reply.reply_to_message_id) return 0;
  const links = db.prepare(`SELECT l.chat_id,l.message_id,l.thread_id FROM telegram_inbound_ledger l
    WHERE l.taskflow_message_id=? AND l.state='posted'`).all(reply.reply_to_message_id) as Array<{ chat_id: string; message_id: number; thread_id: number | null }>;
  // Конверт ответа роли — источник rich-версии; его plain-текст — основа
  // обычного текста (в `text` может лежать сам JSON-конверт).
  const { text, envelope } = telegramFinalBody(reply);
  const parts = splitTelegramText(text, TELEGRAM_PART_LIMIT).slice(0, TELEGRAM_MAX_PARTS);
  const hasAttachment = Boolean(db.prepare("SELECT 1 FROM attachments WHERE chat_message_id=? LIMIT 1").get(reply.id));
  const richHtml = parts.length === 1 && !hasAttachment ? telegramRichHtml(envelope, TELEGRAM_PART_LIMIT) : null;
  let count = 0;
  for (const link of links) {
    const exists = db.prepare("SELECT 1 FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply.id);
    if (exists) continue;
    // Одно намерение — один delivery_id: либо rich-сообщение, либо части.
    // Двух путей доставки одного ответа нет (DoD этапа 6).
    const payload: Record<string, unknown> = richHtml
      ? { method: "sendRichMessage", rich_message: { html: richHtml }, plain_text: text, link_preview_options: { is_disabled: true } }
      : parts.length > 1
        ? { parts: parts.map((part, index) => ({ index: index + 1, total: parts.length, text: part, sent: false })), part_pause_ms: TELEGRAM_PART_PAUSE_MS }
        : { text: parts[0] ?? "" };
    // Финал идёт со звуком: disable_notification не ставим (критерий владельца).
    // Тред — часть адреса ответа: финал в топик уходит в тот же топик.
    enqueueTelegramDelivery({ kind: "final", chatId: link.chat_id, payload, replyToMessageId: link.message_id, sourceMessageId: reply.id, threadId: link.thread_id });
    // Прерванный ход или ошибка — 👎 на сообщении-триггере, успех — 👍.
    // source_message_id не заполняем: уникальный индекс (source_message_id,kind='final')
    // принадлежит самой доставке финала, а реакция — отдельное намерение.
    const failed = Boolean(reply.stop_reason) || Boolean(reply.partial);
    enqueueTelegramReaction({ kind: failed ? "error" : "final", chatId: link.chat_id, messageId: link.message_id, emoji: failed ? "👎" : "👍", sourceMessageId: null });
    count++;
  }
  return count;
}

/** Тело финала: plain-текст для Telegram и конверт для rich-версии. */
function telegramFinalBody(reply: { text: string; role_envelope_json: string | null }): { text: string; envelope: StructuredRoleEnvelopeV1 | null } {
  let envelope: StructuredRoleEnvelopeV1 | null = null;
  if (typeof reply.role_envelope_json === "string") {
    try {
      const raw = JSON.parse(reply.role_envelope_json) as { schema_version?: unknown; output?: unknown };
      if (raw && raw.schema_version === 1 && Array.isArray(raw.output)) envelope = raw as StructuredRoleEnvelopeV1;
    } catch { /* битый конверт — остаётся прежний текст */ }
  }
  const fromEnvelope = envelope ? envelopePlainText(envelope).trim() : "";
  const source = fromEnvelope || String(reply.text ?? "");
  // Таблицы-«палки» в моноширинный блок: без rich Telegram не рисует таблицу.
  return { text: normalizeTelegramTables(source), envelope };
}

/**
 * Кнопки ответа на вопрос роли (этап 3 плана note://a2475482).
 *
 * Числа — из Bot API, а не «на глаз»:
 *  • `callback_data` — 1–64 байта (core.telegram.org/bots/api#inlinekeyboardbutton),
 *    поэтому в кнопку идёт `q:<8 hex id>:<индекс варианта>` — 12 байт, а полный
 *    id вопроса живёт на сервере;
 *  • `reply_markup.inline_keyboard` — ряды по кнопкам, один ряд на вопрос
 *    (те же ограничения, что у обычной inline-клавиатуры);
 *  • TTL кнопок 3600 с — как у Hermes (hermes-agent.nousresearch.com/docs/
 *    user-guide/messaging/telegram: «buttons expire after an hour»).
 */
export const TELEGRAM_QUESTION_TTL_SECONDS = 3600;

/** Сколько вопросов в Telegram-клавиатуре имеет смысл показывать: у пакета
 *  вопросов максимум 4 (chatQuestions.MAX_QUESTIONS), столько и рядов. */
const TELEGRAM_QUESTION_MAX_ROWS = 4;

export function telegramQuestionShortId(questionId: string): string {
  return questionId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function telegramQuestionCallbackData(questionId: string, optionIndex: number): string {
  return `q:${telegramQuestionShortId(questionId)}:${optionIndex}`;
}

/** «q:<id8>:<код варианта>» → {short, questionIndex, optionIndex}.
 *  Код варианта — `questionIndex*10 + optionIndex` (вопросов ≤4, вариантов ≤4):
 *  так один ряд клавиатуры = один вопрос, а данные остаются в 12 байтах.
 *  Всё остальное — мусор, не ошибка сервера. */
export function parseTelegramQuestionCallback(
  data: unknown,
): { short: string; questionIndex: number; optionIndex: number } | null {
  const match = /^q:([0-9a-f]{8}):(\d{1,2})$/.exec(String(data ?? "").trim().toLowerCase());
  if (!match) return null;
  const code = Number(match[2]);
  return { short: match[1], questionIndex: Math.floor(code / 10), optionIndex: code % 10 };
}

/** Клавиатура вопроса: ряд на вопрос, кнопки — по вариантам ответа. */
export function telegramQuestionKeyboard(
  questionId: string,
  payload: { questions: Array<{ options: Array<{ label: string }> }> },
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | null {
  const rows = payload.questions.slice(0, TELEGRAM_QUESTION_MAX_ROWS).map((question, questionIndex) =>
    question.options.map((option, optionIndex) => ({
      text: String(option.label).slice(0, 60),
      callback_data: telegramQuestionCallbackData(questionId, questionIndex * 10 + optionIndex),
    })),
  );
  return rows.length ? { inline_keyboard: rows } : null;
}

/**
 * `/topic <имя>`: Bot API дёргает только gateway (инвариант 1), поэтому сервер
 * ставит ему намерение `createForumTopic`/`editForumTopic`.
 *
 * Привязка топик→комната появляется там, где известен id треда:
 *  • для создания — после ответа Bot API (settleTelegramTopicDelivery);
 *  • для переименования — по уже известному треду (его шлёт gateway вместе с
 *    сообщением либо он последний созданный в этом чате).
 */
function requestTopic(action: "create" | "rename", title: string, context: { botId: string; chatId: string; threadId: number | null }): { action: "created" | "renamed" | "pending"; title: string; chatId: string; roleId: string; threadId: number | null } {
  if (action === "create") {
    enqueueTelegramDelivery({
      kind: "ack",
      chatId: context.chatId,
      payload: { method: "createForumTopic", name: title },
    });
    return { action: "pending", title, chatId: SECRETARY_CHAT_ID, roleId: SECRETARY_USER_ID, threadId: null };
  }
  const threadId = normalizeThreadId(context.threadId) ?? knownThreadOfRoom(context.botId, context.chatId);
  if (!threadId) throw new Error("topic_required");
  const binding = bindTopic({ botId: context.botId, chatId: context.chatId, threadId, title });
  enqueueTelegramDelivery({
    kind: "ack",
    chatId: context.chatId,
    payload: { method: "editForumTopic", message_thread_id: threadId, name: title },
    threadId,
  });
  return { action: "renamed", title, chatId: binding.chat_id_target, roleId: binding.role_id, threadId };
}

/**
 * Gateway ответил на `createForumTopic` — только здесь известен id треда.
 * Вызывается из `/api/integrations/telegram/outbox/:id/result`.
 * Неудача создания топика — не ошибка доставки: владелец получит обычный
 * ответ в общий топик, а не молчание.
 */
function settleTelegramTopicDelivery(deliveryId: string, result: { ok?: boolean; threadId?: number; permanent?: boolean; error?: string }): void {
  let row: { payload_json: string; kind: string } | undefined;
  try { row = db.prepare("SELECT payload_json,kind FROM telegram_delivery_outbox WHERE delivery_id=?").get(deliveryId) as { payload_json: string; kind: string } | undefined; } catch { return; }
  if (!row) return;
  let payload: { method?: string; name?: string; message_thread_id?: number } = {};
  try { payload = JSON.parse(row.payload_json); } catch { return; }
  if (payload.method !== "createForumTopic") return;
  const title = String(payload.name ?? "").trim();
  if (!title) return;
  const threadId = normalizeThreadId(result.threadId);
  const chatId = (db.prepare("SELECT chat_id FROM telegram_delivery_outbox WHERE delivery_id=?").get(deliveryId) as { chat_id: string } | undefined)?.chat_id;
  if (!chatId) return;
  if (result.ok && threadId) {
    try {
      const binding = bindTopic({ botId: telegramConfig().botId, chatId, threadId, title });
      enqueueTelegramDelivery({
        kind: "ack",
        chatId,
        payload: { text: topicReplyText("created", binding.title ?? title, threadId), disable_notification: true },
        threadId,
      });
    } catch (error) {
      console.warn("[telegram] топик создан, но не привязан к комнате:", error);
    }
    return;
  }
  enqueueTelegramDelivery({
    kind: "ack",
    chatId,
    payload: { text: `Не удалось создать топик «${title}»: режим топиков включается в @BotFather. Сообщения остаются в общем топике.`, disable_notification: true },
  });
}

export function telegramStatus() {
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN state='retry_wait' THEN 1 ELSE 0 END) retry_wait,
    SUM(CASE WHEN state='ambiguous' THEN 1 ELSE 0 END) ambiguous,
    MIN(CASE WHEN state IN ('pending','retry_wait','ambiguous') THEN created_at END) oldest_pending
    FROM telegram_delivery_outbox`).get();
  const inbound = db.prepare("SELECT MAX(update_id) last_update_id,SUM(CASE WHEN state='rejected' THEN 1 ELSE 0 END) rejected FROM telegram_inbound_ledger WHERE bot_id=?").get(telegramConfig().botId);
  return { ...counts as object, ...inbound as object };
}
