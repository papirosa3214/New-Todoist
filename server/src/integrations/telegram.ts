import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "../db.js";
import { DB_PATH } from "../db.js";
import { SECRETARY_CHAT_ID } from "../lib/secretaryReply.js";
import type { AnswerPayload, QuestionPayload } from "../lib/chatQuestions.js";
import { foldedQuestionHtml, questionWidgetHtml } from "../lib/telegramQuestionWidget.js";
import { enqueueMessageDelivery } from "../runtime/chatQueue.js";
import { resolveTelegramCommandText } from "../lib/telegramCommands.js";

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
  editMessageText: { kinds: ["progress", "final"] },
  setMessageReaction: { kinds: ["progress", "final", "error"] },
  sendMessageDraft: { kinds: ["progress"] },
  // Виджет вопроса (Bot API 10.4): одно сообщение вместо текста + карточки.
  sendWidget: { kinds: ["ack"] },
  // Свёрнутый виджет после ответа — вместо живого виджета в ленте.
  editMessageWidgetData: { kinds: ["progress"] },
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
}): string {
  const id = crypto.randomUUID();
  // Метод сохраняем как есть: неизвестный транспорт — забота gateway (он
  // помечает доставку abandoned с логом). Подставляем sendMessage только когда
  // метода нет вовсе — так прежние вызовы (progress/final) не меняют поведение.
  const rawMethod = args.payload.method;
  const method = typeof rawMethod === "string" && rawMethod.trim() ? rawMethod.trim() : "sendMessage";
  const payload = {
    ...args.payload,
    method,
    reply_to_message_id: args.replyToMessageId ?? (args.payload.reply_to_message_id as number | null | undefined) ?? null,
  };
  db.prepare(`INSERT INTO telegram_delivery_outbox(delivery_id,bot_id,chat_id,kind,payload_json,state,next_attempt_at,source_message_id)
    VALUES(?,?,?,?,?,'pending',datetime('now'),?)`).run(id, telegramConfig().botId, args.chatId, args.kind, JSON.stringify(payload), args.sourceMessageId ?? null);
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
  const links = db.prepare(`SELECT chat_id,message_id FROM telegram_inbound_ledger
    WHERE taskflow_message_id=? AND state='posted'`).all(triggerMessageId) as Array<{ chat_id: string; message_id: number }>;
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
    enqueueTelegramDelivery({ kind: "progress", chatId: link.chat_id, payload: { text: label, disable_notification: true }, replyToMessageId: link.message_id, sourceMessageId: triggerMessageId });
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
      const links = db.prepare(`SELECT chat_id,message_id FROM telegram_inbound_ledger
        WHERE taskflow_message_id=? AND state='posted'`).all(triggerMessageId) as Array<{ chat_id: string; message_id: number }>;
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
        });
      }
    } catch { /* поток — не повод ломать ход */ }
  };
  if (streamTimers.has(triggerMessageId)) return;
  const timer = setInterval(tick, STREAM_INTERVAL_MS);
  timer.unref?.();
  streamTimers.set(triggerMessageId, timer);
}

export async function acceptTelegramInbound(input: TelegramInbound): Promise<{ duplicate: boolean; ledger_id: string; message_id: string | null; ack_delivery_id: string | null; queue_row_id: string | null; chat_id: string; role_id: string }> {
  const existing = db.prepare("SELECT id,taskflow_message_id,ack_delivery_id FROM telegram_inbound_ledger WHERE bot_id=? AND update_id=?").get(String(input.bot_id), input.update_id) as { id: string; taskflow_message_id: string | null; ack_delivery_id: string | null } | undefined;
  if (existing) return { duplicate: true, ledger_id: existing.id, message_id: existing.taskflow_message_id, ack_delivery_id: existing.ack_delivery_id, queue_row_id: null, chat_id: SECRETARY_CHAT_ID, role_id: SECRETARY_USER_ID };
  const ledgerId = crypto.randomUUID();
  const hash = normalizedHash(input);
  db.prepare(`INSERT INTO telegram_inbound_ledger(id,bot_id,update_id,chat_id,user_id,message_id,payload_hash,state)
    VALUES(?,?,?,?,?,?,?,'received')`).run(ledgerId, String(input.bot_id), input.update_id, String(input.chat_id), String(input.user_id), input.message_id, hash);
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
    db.transaction(() => {
      db.prepare(`INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,work_mode,execution_mode)
        VALUES(?,?,?,'chat',?,'work','chat')`).run(messageId, owner, text, SECRETARY_CHAT_ID);
      const attach = db.prepare("UPDATE attachments SET chat_message_id=? WHERE id=? AND user_id=? AND chat_message_id IS NULL");
      for (const id of attachmentIds) attach.run(messageId, id, owner);
      db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(SECRETARY_CHAT_ID);
      db.prepare("UPDATE telegram_inbound_ledger SET state='posted',posted_at=datetime('now'),taskflow_message_id=? WHERE id=?").run(messageId, ledgerId);
    })();
    const durable = enqueueMessageDelivery({ chatId: SECRETARY_CHAT_ID, roleId: SECRETARY_USER_ID, deliveryId: `tg:${input.bot_id}:${input.update_id}`, messageId, payload: { hop: 0, mode: "work", text: roleText } });
    // Немедленного «Принял.» нет: Telegram получает статус только если ход
    // тянется дольше 10 секунд (scheduleTelegramProgress в чат-рантайме).
    // Реакция 👀 — сразу после успешного inbound: владелец видит, что запрос
    // принят, не дожидаясь статуса (выключатель TASKFLOW_TELEGRAM_REACTIONS).
    enqueueTelegramReaction({ kind: "progress", chatId: String(input.chat_id), messageId: input.message_id, emoji: "👀", sourceMessageId: null });
    scheduleTelegramProgress(messageId);
    return { duplicate: false, ledger_id: ledgerId, message_id: messageId, ack_delivery_id: null, queue_row_id: durable.id, chat_id: SECRETARY_CHAT_ID, role_id: SECRETARY_USER_ID };
  } catch (error) {
    const code = error instanceof Error ? error.message : "inbound_failed";
    db.prepare("UPDATE telegram_inbound_ledger SET state='rejected',error_code=?,finished_at=datetime('now') WHERE id=?").run(code, ledgerId);
    throw error;
  }
}

export function telegramOutbox(limit = 20) {
  db.prepare("UPDATE telegram_delivery_outbox SET state='ambiguous',last_error='sending lease expired',updated_at=datetime('now') WHERE state='sending' AND updated_at < datetime('now','-2 minutes')").run();
  return db.prepare(`SELECT delivery_id,chat_id,kind,payload_json,attempts,state,next_attempt_at FROM telegram_delivery_outbox
    WHERE state IN ('pending','retry_wait','ambiguous') AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now')) ORDER BY created_at LIMIT ?`).all(limit);
}

export function markTelegramSending(id: string): boolean {
  return db.prepare("UPDATE telegram_delivery_outbox SET state='sending',attempts=attempts+1,updated_at=datetime('now') WHERE delivery_id=? AND state IN ('pending','retry_wait','ambiguous')").run(id).changes === 1;
}

export function settleTelegramDelivery(id: string, result: { ok: boolean; permanent?: boolean; ambiguous?: boolean; retryAfterSeconds?: number; telegramMessageId?: number; error?: string }) {
  if (result.ok) {
    db.prepare("UPDATE telegram_delivery_outbox SET state='delivered',telegram_message_id=?,delivered_at=datetime('now'),updated_at=datetime('now'),last_error=NULL WHERE delivery_id=?").run(result.telegramMessageId ?? null, id);
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

export function captureTelegramFinal(messageId: string): number {
  const reply = db.prepare("SELECT id,text,reply_to_message_id,from_user_id,stop_reason,partial FROM chat_messages WHERE id=?").get(messageId) as { id: string; text: string; reply_to_message_id: string | null; from_user_id: string; stop_reason: string | null; partial: number | null } | undefined;
  if (!reply || reply.from_user_id !== SECRETARY_USER_ID || !reply.reply_to_message_id) return 0;
  // Вопрос ушёл виджетом — текстового дубля с тем же вопросом быть не должно
  // (владелец 11.11.2026: сначала текст, потом карточка).
  const asQuestion = db.prepare("SELECT 1 FROM chat_questions WHERE message_id=?").get(reply.id);
  if (asQuestion) return 0;
  const links = db.prepare(`SELECT l.chat_id,l.message_id FROM telegram_inbound_ledger l
    WHERE l.taskflow_message_id=? AND l.state='posted'`).all(reply.reply_to_message_id) as Array<{ chat_id: string; message_id: number }>;
  let count = 0;
  for (const link of links) {
    const exists = db.prepare("SELECT 1 FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply.id);
    if (exists) continue;
    // Финал идёт со звуком: disable_notification не ставим (критерий владельца).
    enqueueTelegramDelivery({ kind: "final", chatId: link.chat_id, payload: { text: reply.text }, replyToMessageId: link.message_id, sourceMessageId: reply.id });
    // Прерванный ход или ошибка — 👎 на сообщении-триггере, успех — 👍.
    // source_message_id не заполняем: уникальный индекс (source_message_id,kind='final')
    // принадлежит самой доставке финала, а реакция — отдельное намерение.
    const failed = Boolean(reply.stop_reason) || Boolean(reply.partial);
    enqueueTelegramReaction({ kind: failed ? "error" : "final", chatId: link.chat_id, messageId: link.message_id, emoji: failed ? "👎" : "👍", sourceMessageId: null });
    count++;
  }
  return count;
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

/**
 * Вопрос роли → одно сообщение Telegram (виджет, Bot API 10.4).
 *
 * Дубль текста убран: текст вопроса живёт внутри самого виджета, отдельной
 * текстовой доставки нет — владелец видит ровно одно сообщение.
 * `kind='ack'`: вопрос не закрывает ход, поэтому «печатает…» не гасится.
 */
export function captureQuestionWidget(questionId: string): number {
  const question = db
    .prepare("SELECT id,chat_id,message_id,payload_json FROM chat_questions WHERE id=?")
    .get(questionId) as { id: string; chat_id: string; message_id: string | null; payload_json: string } | undefined;
  if (!question?.message_id) return 0;
  const message = db
    .prepare("SELECT reply_to_message_id FROM chat_messages WHERE id=?")
    .get(question.message_id) as { reply_to_message_id: string | null } | undefined;
  if (!message?.reply_to_message_id) return 0;
  let payload: QuestionPayload;
  try {
    payload = JSON.parse(question.payload_json) as QuestionPayload;
  } catch {
    return 0;
  }
  const links = db.prepare(`SELECT chat_id,message_id FROM telegram_inbound_ledger
    WHERE taskflow_message_id=? AND state='posted'`).all(message.reply_to_message_id) as Array<{ chat_id: string; message_id: number }>;
  let count = 0;
  for (const link of links) {
    const already = db
      .prepare("SELECT 1 FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='ack' AND payload_json LIKE '%sendWidget%'")
      .get(question.message_id);
    if (already) continue;
    enqueueTelegramDelivery({
      kind: "ack",
      chatId: link.chat_id,
      payload: { method: "sendWidget", html: questionWidgetHtml(payload), height: 260, allow_queries: false },
      replyToMessageId: link.message_id,
      sourceMessageId: question.message_id,
    });
    count++;
  }
  return count;
}

/**
 * Виджет вопроса после ответа: сворачиваем в строку «Вопрос: … → Ответ: …».
 *
 * Сворачивание, а не `deleteMessage`: у удаления в outbox нет транспорта (см.
 * TELEGRAM_METHOD_POLICY — там нет deleteMessage), а несверный live-виджет
 * продолжает перерисовываться в ленте — ровно то, на что жалуется владелец.
 * Правка тем же сообщением оставляет в ленте историю ответа и не требует
 * нового метода. Если сообщения уже нет — Telegram ответит ошибкой, доставка
 * помечается abandoned, лента не ломается.
 */
export function foldQuestionWidget(questionId: string): number {
  const question = db
    .prepare("SELECT id,message_id,payload_json,answer_json FROM chat_questions WHERE id=?")
    .get(questionId) as { id: string; message_id: string | null; payload_json: string; answer_json: string | null } | undefined;
  if (!question?.message_id) return 0;
  let payload: QuestionPayload;
  let answer: AnswerPayload | null = null;
  try {
    payload = JSON.parse(question.payload_json) as QuestionPayload;
  } catch {
    return 0;
  }
  if (question.answer_json) {
    try {
      answer = JSON.parse(question.answer_json) as AnswerPayload;
    } catch {
      answer = null;
    }
  }
  const delivered = db
    .prepare("SELECT telegram_message_id,chat_id FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='ack' AND state='delivered' AND telegram_message_id IS NOT NULL LIMIT 1")
    .get(question.message_id) as { telegram_message_id: number; chat_id: string } | undefined;
  const already = db
    .prepare("SELECT 1 FROM telegram_delivery_outbox WHERE source_message_id=? AND payload_json LIKE '%editMessageWidgetData%'")
    .get(question.message_id);
  if (already) return 0;
  if (!delivered) {
    // Виджет не дошёл до Telegram (владелец отвечал в чате TaskFlow) — сворачивать нечего.
    return 0;
  }
  enqueueTelegramDelivery({
    kind: "progress",
    chatId: delivered.chat_id,
    payload: {
      method: "editMessageWidgetData",
      message_id: delivered.telegram_message_id,
      html: foldedQuestionHtml(payload, answer),
      height: 120,
    },
    sourceMessageId: question.message_id,
  });
  return 1;
}
