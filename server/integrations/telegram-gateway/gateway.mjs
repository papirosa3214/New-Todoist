#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const token = required("TELEGRAM_BOT_TOKEN");
const secret = required("TASKFLOW_TELEGRAM_INTEGRATION_SECRET");
const botId = required("TASKFLOW_TELEGRAM_BOT_ID");
const allowedUser = Number(required("TASKFLOW_TELEGRAM_OWNER_USER_ID"));
const allowedChat = Number(required("TASKFLOW_TELEGRAM_OWNER_CHAT_ID"));
const api = (process.env.TASKFLOW_API_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
const statePath = process.env.TELEGRAM_GATEWAY_STATE || path.join(process.cwd(), "telegram-gateway-state.json");
const statusPath = process.env.TELEGRAM_GATEWAY_STATUS || path.join(path.dirname(statePath), "status-bubbles.json");
const tg = `https://api.telegram.org/bot${token}`;
const maxBytes = 15 * 1024 * 1024;
let stopped = false;
let offset = await loadOffset();

function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function loadOffset() { try { return Number(JSON.parse(await fs.readFile(statePath, "utf8")).offset || 0); } catch { return 0; } }
async function saveOffset(value) { await fs.mkdir(path.dirname(statePath), { recursive: true }); const tmp = `${statePath}.tmp`; await fs.writeFile(tmp, JSON.stringify({ offset: value, updated_at: new Date().toISOString() })); await fs.rename(tmp, statePath); }
async function taskflow(route, options = {}) {
  const response = await fetch(`${api}${route}`, { ...options, headers: { "content-type": "application/json", "x-taskflow-integration-secret": secret, ...(options.headers || {}) }, signal: AbortSignal.timeout(35_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `TaskFlow HTTP ${response.status}`), { status: response.status });
  return data;
}
async function taskflowRaw(route, bytes, mime) {
  const response = await fetch(`${api}${route}`, { method: "POST", headers: { "content-type": mime, "x-taskflow-integration-secret": secret }, body: bytes, signal: AbortSignal.timeout(310_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `TaskFlow HTTP ${response.status}`);
  return data;
}
async function telegram(method, body) {
  const response = await fetch(`${tg}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
  const data = await response.json();
  if (!data.ok) throw Object.assign(new Error(data.description || `Telegram ${method} failed`), { status: response.status, parameters: data.parameters });
  return data.result;
}
function authorized(message) { return message?.chat?.type === "private" && !message?.from?.is_bot && message.from.id === allowedUser && message.chat.id === allowedChat && message.from.id === message.chat.id; }
function attachmentMeta(message) {
  if (message.voice) return { file_id: message.voice.file_id, size: message.voice.file_size, name: `voice-${message.message_id}.ogg`, mime: message.voice.mime_type || "audio/ogg", kind: "voice" };
  if (message.audio) return { file_id: message.audio.file_id, size: message.audio.file_size, name: message.audio.file_name || `audio-${message.message_id}`, mime: message.audio.mime_type || "audio/mpeg", kind: "audio" };
  if (message.document) return { file_id: message.document.file_id, size: message.document.file_size, name: message.document.file_name || `document-${message.message_id}`, mime: message.document.mime_type || "application/octet-stream", kind: "document" };
  if (Array.isArray(message.photo)) { const photo = [...message.photo].reverse().find((p) => Number(p.file_size || 0) <= maxBytes); return photo ? { file_id: photo.file_id, size: photo.file_size, name: `photo-${message.message_id}.jpg`, mime: "image/jpeg", kind: "photo" } : null; }
  return undefined;
}
async function downloadAttachment(meta) {
  if (!meta) return [];
  if (!Number.isFinite(meta.size) || meta.size <= 0 || meta.size > maxBytes) throw new Error("attachment_too_large");
  const file = await telegram("getFile", { file_id: meta.file_id });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("attachment_too_large");
  const item = { file_name: meta.name, mime: meta.mime, kind: meta.kind, data_base64: bytes.toString("base64") };
  if (meta.kind === "voice" || meta.kind === "audio") {
    try { item.transcript = (await taskflowRaw("/api/integrations/telegram/transcribe", bytes, meta.mime)).text || ""; } catch { item.transcript = ""; }
  }
  return [item];
}
async function handleUpdate(update) {
  const message = update.message;
  if (!message || !authorized(message)) return;
  const meta = attachmentMeta(message);
  if (meta === null) { await telegram("sendMessage", { chat_id: message.chat.id, reply_to_message_id: message.message_id, text: "Файл больше 15 МБ или подходящего варианта фото нет." }); return; }
  const attachments = await downloadAttachment(meta);
  const transcript = attachments.map((item) => item.transcript).filter(Boolean).join("\n");
  await taskflow("/api/integrations/telegram/inbound", { method: "POST", body: JSON.stringify({ bot_id: botId, update_id: update.update_id, chat_id: message.chat.id, user_id: message.from.id, chat_type: message.chat.type, message_id: message.message_id, text: message.text || transcript || "", caption: message.caption || (meta?.kind === "voice" && !transcript ? "Голосовое не распознано" : ""), attachments }) });
}
const statusBubbles = await loadStatusBubbles();

// Одна обновляемая строка статуса на ход, как у Hermes: пока роль думает —
// шлём/правим «Работаю», финальный ответ заменяет её на месте.
async function loadStatusBubbles() {
  try { return JSON.parse(await fs.readFile(statusPath, "utf8")).bubbles || {}; } catch { return {}; }
}
async function saveStatusBubbles() {
  try { await fs.mkdir(path.dirname(statusPath), { recursive: true }); const tmp = `${statusPath}.tmp`; await fs.writeFile(tmp, JSON.stringify({ bubbles: statusBubbles, updated_at: new Date().toISOString() })); await fs.rename(tmp, statusPath); } catch {}
}
async function editStatus(chatId, telegramMessageId, text) {
  try { await telegram("editMessageText", { chat_id: chatId, message_id: telegramMessageId, text: String(text || "").slice(0, 4096) }); return true; }
  catch { return false; }
}
async function sendOutbox() {
  const { deliveries = [] } = await taskflow("/api/integrations/telegram/outbox?limit=20");
  for (const delivery of deliveries) {
    try {
      await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/claim`, { method: "POST", body: "{}" });
      const payload = JSON.parse(delivery.payload_json);
      const key = payload.reply_to_message_id ? `${delivery.chat_id}:${payload.reply_to_message_id}` : null;
      const text = String(payload.text || "").slice(0, 4096);
      if (delivery.kind === "progress") {
        const existing = key ? statusBubbles[key] : null;
        const result = existing
          ? { message_id: (await editStatus(Number(delivery.chat_id), existing, text)) ? existing : null }
          : await telegram("sendMessage", { chat_id: Number(delivery.chat_id), text, ...(payload.reply_to_message_id ? { reply_to_message_id: payload.reply_to_message_id } : {}) });
        if (result.message_id && key) { statusBubbles[key] = result.message_id; await saveStatusBubbles(); }
        await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/result`, { method: "POST", body: JSON.stringify({ ok: true, telegramMessageId: result.message_id || undefined }) });
        continue;
      }
      if (delivery.kind === "final" && key && statusBubbles[key]) {
        const bubble = statusBubbles[key];
        delete statusBubbles[key];
        await saveStatusBubbles();
        if (await editStatus(Number(delivery.chat_id), bubble, text)) {
          await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/result`, { method: "POST", body: JSON.stringify({ ok: true, telegramMessageId: bubble }) });
          continue;
        }
      }
      const result = await telegram("sendMessage", { chat_id: Number(delivery.chat_id), text, ...(payload.reply_to_message_id ? { reply_to_message_id: payload.reply_to_message_id } : {}) });
      await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/result`, { method: "POST", body: JSON.stringify({ ok: true, telegramMessageId: result.message_id }) });
    } catch (error) {
      const status = Number(error.status || 0);
      const retryAfterSeconds = Number(error.parameters?.retry_after || 0) || undefined;
      await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/result`, { method: "POST", body: JSON.stringify({ ok: false, permanent: status >= 400 && status < 500 && status !== 429, ambiguous: !status, retryAfterSeconds, error: String(error.message || error).slice(0, 500) }) }).catch(() => {});
    }
  }
}
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
while (!stopped) {
  try {
    const updates = await telegram("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ["message"] });
    for (const update of updates) {
      try { await handleUpdate(update); }
      catch (error) { console.error(JSON.stringify({ event: "update_failed", update_id: update.update_id, error: String(error.message || error) })); }
      offset = update.update_id + 1;
      await saveOffset(offset);
      await sendOutbox();
    }
    await sendOutbox();
  } catch (error) {
    console.error(JSON.stringify({ event: "poll_failed", error: String(error.message || error) }));
    await sleep(5000);
  }
}
