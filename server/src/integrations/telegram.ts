import crypto from "crypto";
import fs from "fs";
import path from "path";
import db from "../db.js";
import { DB_PATH } from "../db.js";
import { SECRETARY_CHAT_ID } from "../lib/secretaryReply.js";
import { enqueueMessageDelivery } from "../runtime/chatQueue.js";

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

export function enqueueTelegramDelivery(args: { kind: "ack" | "progress" | "final" | "error"; chatId: string; text: string; replyToMessageId?: number | null; sourceMessageId?: string | null }): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO telegram_delivery_outbox(delivery_id,bot_id,chat_id,kind,payload_json,state,next_attempt_at,source_message_id)
    VALUES(?,?,?,?,?,'pending',datetime('now'),?)`).run(id, telegramConfig().botId, args.chatId, args.kind, JSON.stringify({ text: args.text, reply_to_message_id: args.replyToMessageId ?? null }), args.sourceMessageId ?? null);
  return id;
}

export function acceptTelegramInbound(input: TelegramInbound): { duplicate: boolean; ledger_id: string; message_id: string | null; ack_delivery_id: string | null } {
  const existing = db.prepare("SELECT id,taskflow_message_id,ack_delivery_id FROM telegram_inbound_ledger WHERE bot_id=? AND update_id=?").get(String(input.bot_id), input.update_id) as { id: string; taskflow_message_id: string | null; ack_delivery_id: string | null } | undefined;
  if (existing) return { duplicate: true, ledger_id: existing.id, message_id: existing.taskflow_message_id, ack_delivery_id: existing.ack_delivery_id };
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
    const messageId = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,work_mode,execution_mode)
        VALUES(?,?,?,'chat',?,'work','chat')`).run(messageId, owner, text, SECRETARY_CHAT_ID);
      const attach = db.prepare("UPDATE attachments SET chat_message_id=? WHERE id=? AND user_id=? AND chat_message_id IS NULL");
      for (const id of attachmentIds) attach.run(messageId, id, owner);
      db.prepare("UPDATE chats SET updated_at=datetime('now') WHERE id=?").run(SECRETARY_CHAT_ID);
      db.prepare("UPDATE telegram_inbound_ledger SET state='posted',posted_at=datetime('now'),taskflow_message_id=? WHERE id=?").run(messageId, ledgerId);
    })();
    enqueueMessageDelivery({ chatId: SECRETARY_CHAT_ID, roleId: SECRETARY_USER_ID, deliveryId: `tg:${input.bot_id}:${input.update_id}`, messageId, payload: { hop: 0, mode: "work", text } });
    const ackId = enqueueTelegramDelivery({ kind: "ack", chatId: String(input.chat_id), text: "Принял.", replyToMessageId: input.message_id, sourceMessageId: messageId });
    db.prepare("UPDATE telegram_inbound_ledger SET ack_delivery_id=? WHERE id=?").run(ackId, ledgerId);
    return { duplicate: false, ledger_id: ledgerId, message_id: messageId, ack_delivery_id: ackId };
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
  const reply = db.prepare("SELECT id,text,reply_to_message_id,from_user_id FROM chat_messages WHERE id=?").get(messageId) as { id: string; text: string; reply_to_message_id: string | null; from_user_id: string } | undefined;
  if (!reply || reply.from_user_id !== SECRETARY_USER_ID || !reply.reply_to_message_id) return 0;
  const links = db.prepare(`SELECT l.chat_id,l.message_id FROM telegram_inbound_ledger l
    WHERE l.taskflow_message_id=? AND l.state='posted'`).all(reply.reply_to_message_id) as Array<{ chat_id: string; message_id: number }>;
  let count = 0;
  for (const link of links) {
    const exists = db.prepare("SELECT 1 FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply.id);
    if (exists) continue;
    enqueueTelegramDelivery({ kind: "final", chatId: link.chat_id, text: reply.text, replyToMessageId: link.message_id, sourceMessageId: reply.id });
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
