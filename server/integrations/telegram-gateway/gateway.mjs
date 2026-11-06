#!/usr/bin/env node
// Telegram gateway @ckor22_bot ↔ TaskFlow. Только Bot API и loopback integration
// API: owner JWT и БД не используются (инвариант плана note://a2475482).
//
// Транспорт доставки выбирается по `payload.method` (этап 0). Неизвестный метод
// помечается `abandoned` с логом, а не роняет цикл. Живой поток идёт черновиком
// `sendMessageDraft` с безусловным откатом на правку `editMessageText` (этап 4).
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
const commandsPath = path.join(path.dirname(statePath), "commands-cache.json");
// База Bot API переопределяема только для живой проверки транспорта на .110
// (локальная заглушка); в бою значение не задано.
const tg = `${(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "")}/bot${token}`;
const maxBytes = 15 * 1024 * 1024;
const STATUS_TEXT_MAX = 4096;
const ALLOWED_UPDATES = ["message", "callback_query", "inline_query"];
/** Реакции выключены по умолчанию (как `telegram.reactions` у Hermes). */
const reactionsEnabled = ["1", "on", "true", "yes"].includes(String(process.env.TASKFLOW_TELEGRAM_REACTIONS || "").trim().toLowerCase());
/** `auto` — черновик с откатом на правку; `off` — потока нет. */
const streamMode = (() => {
  const value = String(process.env.TASKFLOW_TELEGRAM_STREAM || "").trim().toLowerCase();
  return ["auto", "draft", "edit", "off"].includes(value) ? value : "auto";
})();
let draftSupported = streamMode === "draft" ? true : streamMode === "auto" ? null : false;
let stopped = false;
let offset = await loadOffset();

function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required`); return value; }
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data, at: new Date().toISOString() }));
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

// ── Меню команд (этап 2) ─────────────────────────────────────────────────────
// Реестр живёт на сервере: gateway спрашивает его по ETag, поэтому
// `setMyCommands` уходит только при изменении списка. Недоступный реестр не
// трогает уже установленное меню.
async function syncCommands() {
  let etag = null;
  try { etag = JSON.parse(await fs.readFile(commandsPath, "utf8")).etag || null; } catch {}
  let response;
  try {
    response = await fetch(`${api}/api/integrations/telegram/commands`, { headers: { "x-taskflow-integration-secret": secret, ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    log("commands_unavailable", { error: String(error.message || error) });
    return;
  }
  if (response.status === 304) { log("commands_unchanged", { etag }); return; }
  if (!response.ok) { log("commands_failed", { status: response.status }); return; }
  const data = await response.json().catch(() => ({}));
  const commands = Array.isArray(data.menu) ? data.menu.filter((item) => item && item.command) : [];
  if (!commands.length) { log("commands_empty", {}); return; }
  try {
    await setCommandsWithFallback(commands);
    const next = data.version ? `"${data.version}"` : response.headers.get("etag");
    await fs.mkdir(path.dirname(commandsPath), { recursive: true });
    await fs.writeFile(commandsPath, JSON.stringify({ etag: next, count: commands.length, updated_at: new Date().toISOString() }));
    log("commands_set", { count: commands.length, version: data.version || null });
  } catch (error) {
    log("commands_set_failed", { error: String(error.message || error), status: Number(error.status || 0) });
  }
}

/**
 * `setMyCommands` с отступлением: у бота есть недокументированный потолок
 * суммарного размера меню (60 команд × 256 символов → `BOT_COMMANDS_TOO_MUCH`,
 * замер 06.11.2026). Сервер уже отдаёт короткое меню, но если Telegram всё
 * равно откажет — сокращаем ещё: меньше команд и короче описание, а не
 * оставляем бота без меню.
 */
async function setCommandsWithFallback(commands) {
  const attempts = [
    commands,
    commands.slice(0, 30).map((item) => ({ ...item, description: String(item.description || item.command).slice(0, 60) })),
    commands.slice(0, 15).map((item) => ({ ...item, description: String(item.command) })),
  ];
  let lastError = null;
  for (const [index, list] of attempts.entries()) {
    try {
      await telegram("setMyCommands", { commands: list.map(({ command, description }) => ({ command, description: String(description || command).slice(0, 256) })) });
      if (index > 0) log("commands_reduced", { attempt: index + 1, count: list.length });
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function handleInlineQuery(query) {
  if (Number(query?.from?.id) !== allowedUser) { await telegram("answerInlineQuery", { inline_query_id: query.id, results: [], cache_time: 0 }).catch(() => {}); return; }
  // Без cap: меню ограничено 60, поиск — весь реестр (этап 2 плана).
  const data = await taskflow("/api/integrations/telegram/commands").catch((error) => { log("inline_registry_failed", { error: String(error.message || error) }); return { all: [] }; });
  const all = Array.isArray(data.all) ? data.all : [];
  const text = String(query.query || "").trim().toLowerCase();
  const matched = text ? all.filter((item) => item.command.includes(text) || String(item.description || "").toLowerCase().includes(text)) : all;
  const results = matched.slice(0, 50).map((item) => ({
    type: "article",
    id: item.command,
    title: `/${item.command}`,
    description: String(item.description || "").slice(0, 256),
    input_message_content: { message_text: `/${item.command} ` },
  }));
  await telegram("answerInlineQuery", { inline_query_id: query.id, results, cache_time: 60 }).catch((error) => log("inline_answer_failed", { error: String(error.message || error) }));
}

async function handleCallbackQuery(query) {
  // Кнопки вопроса — этап 3; апдейт всё равно забираем, чтобы offset не «съел» его.
  log("callback_unsupported", { callback_id: query?.id, has_message: Boolean(query?.message) });
  await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Кнопки ещё не поддерживаются" }).catch(() => {});
}

async function handleUpdate(update) {
  if (update.inline_query) { await handleInlineQuery(update.inline_query); return; }
  if (update.callback_query) { await handleCallbackQuery(update.callback_query); return; }
  const message = update.message;
  if (!message || !authorized(message)) return;
  // `/start` и `/help` — служебные для бота: отвечаем подсказкой, а не запускаем ход.
  const slash = String(message.text || "").trim().toLowerCase();
  if (slash === "/start" || slash === "/help") {
    await telegram("sendMessage", { chat_id: message.chat.id, reply_to_message_id: message.message_id, text: "Меню — кнопка «/» слева от поля ввода. Поиск команды — @ckor22_bot <слово>. Обычный вопрос — просто напишите.", disable_notification: true });
    return;
  }
  const meta = attachmentMeta(message);
  if (meta === null) { await telegram("sendMessage", { chat_id: message.chat.id, reply_to_message_id: message.message_id, text: "Файл больше 15 МБ или подходящего варианта фото нет." }); return; }
  const attachments = await downloadAttachment(meta);
  const transcript = attachments.map((item) => item.transcript).filter(Boolean).join("\n");
  await taskflow("/api/integrations/telegram/inbound", { method: "POST", body: JSON.stringify({ bot_id: botId, update_id: update.update_id, chat_id: message.chat.id, user_id: message.from.id, chat_type: message.chat.type, message_id: message.message_id, text: message.text || transcript || "", caption: message.caption || (meta?.kind === "voice" && !transcript ? "Голосовое не распознано" : ""), attachments }) });
  // Запрос принят — сразу показываем «печатает…», не дожидаясь 10-секундного
  // статуса и черновика. Останавливается на финале/ошибке в sendOutbox.
  startTyping(message.chat.id);
}

const statusBubbles = await loadStatusBubbles();

// «Печатает…» в Telegram (владелец 06.11.2026: без индикатора кажется, что
// бот не получил сообщение). Telegram гасит статус через ~5 с, поэтому
// держим его повтором каждые 4 с, пока ход не закончится финалом или ошибкой.
const typingTimers = new Map();
const TYPING_INTERVAL_MS = 4_000;
/** Последняя ошибка sendChatAction на чат: не спамим журналом каждый тик. */
const typingErrors = new Map();
async function typeTick(chatId) {
  try {
    await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
    typingErrors.delete(chatId);
  } catch (error) {
    const status = Number(error.status || 0);
    if (status === 429 || status === 400) return; // флуд-контроль и «нет прав» сами пройдут
    if (typingErrors.get(chatId) !== String(error.message || error)) {
      typingErrors.set(chatId, String(error.message || error));
      log("typing_failed", { chat_id: chatId, status, error: String(error.message || error) });
    }
  }
}
function startTyping(chatId) {
  const key = Number(chatId);
  if (typingTimers.has(key)) return;
  const tick = () => { void typeTick(key); };
  tick();
  const timer = setInterval(tick, TYPING_INTERVAL_MS);
  timer.unref?.();
  typingTimers.set(key, timer);
  log("typing_started", { chat_id: key });
}
function stopTyping(chatId) {
  const key = Number(chatId);
  const timer = typingTimers.get(key);
  if (timer) { clearInterval(timer); typingTimers.delete(key); typingErrors.delete(key); }
}
/** Telegram гасит «печатает…», когда в чат приходит сообщение: после любого
 *  промежуточного отправления статус нужно поднять заново (как у Hermes). */
function retriggerTyping(chatId) {
  const key = Number(chatId);
  if (!typingTimers.has(key)) return;
  void typeTick(key);
}

// Одна обновляемая строка статуса на ход, как у Hermes: пока роль думает —
// шлём/правим «Работаю», финальный ответ заменяет её на месте.
async function loadStatusBubbles() {
  try { return JSON.parse(await fs.readFile(statusPath, "utf8")).bubbles || {}; } catch { return {}; }
}
async function saveStatusBubbles() {
  try { await fs.mkdir(path.dirname(statusPath), { recursive: true }); const tmp = `${statusPath}.tmp`; await fs.writeFile(tmp, JSON.stringify({ bubbles: statusBubbles, updated_at: new Date().toISOString() })); await fs.rename(tmp, statusPath); } catch {}
}
async function editStatus(chatId, telegramMessageId, text, disableNotification) {
  try { await telegram("editMessageText", { chat_id: chatId, message_id: telegramMessageId, text: String(text || "").slice(0, STATUS_TEXT_MAX), ...(disableNotification === undefined ? {} : { disable_notification: disableNotification }) }); return true; }
  catch { return false; }
}
function sendArgs(delivery, payload, text) {
  return { chat_id: Number(delivery.chat_id), text, ...(payload.reply_to_message_id ? { reply_to_message_id: payload.reply_to_message_id } : {}), ...(payload.disable_notification === true ? { disable_notification: true } : {}) };
}
/** Черновик живёт ~30 с и эфемерен: финал всё равно приходит отдельным sendMessage. */
async function sendDraft(delivery, payload, text) {
  if (draftSupported === false) return null;
  const draftId = Number(payload.draft?.draft_id ?? payload.draft_id ?? 0);
  if (!Number.isSafeInteger(draftId) || draftId === 0) { draftSupported = false; log("draft_fallback", { reason: "draft_id", delivery_id: delivery.delivery_id }); return null; }
  try {
    await telegram("sendMessageDraft", { chat_id: Number(delivery.chat_id), draft_id: draftId, text: String(text || "").slice(0, STATUS_TEXT_MAX) });
    if (draftSupported === null) { draftSupported = true; log("draft_enabled", {}); }
    return { message_id: null };
  } catch (error) {
    // Любая ошибка — безусловный откат на правку до конца процесса.
    draftSupported = false;
    log("draft_fallback", { delivery_id: delivery.delivery_id, error: String(error.message || error), status: Number(error.status || 0) });
    return null;
  }
}

async function sendDelivery(delivery, payload) {
  const method = String(payload.method || "sendMessage");
  const key = payload.reply_to_message_id ? `${delivery.chat_id}:${payload.reply_to_message_id}` : null;
  const text = String(payload.text || "").slice(0, STATUS_TEXT_MAX);
  // Финал или ошибка закрывают ход — гасим «печатает…».
  if (delivery.kind === "final" || delivery.kind === "error") stopTyping(delivery.chat_id);

  if (method === "setMessageReaction") {
    if (!reactionsEnabled) { await settle(delivery, { ok: true }); return; }
    const messageId = Number(payload.message_id ?? payload.reply_to_message_id ?? 0);
    if (!messageId) { await settle(delivery, { ok: true }); return; }
    try {
      // Одна реакция на сообщение: Bot API сам заменяет прежнюю.
      await telegram("setMessageReaction", { chat_id: Number(delivery.chat_id), message_id: messageId, reaction: payload.reaction || [], ...(payload.is_big ? { is_big: true } : {}) });
      await settle(delivery, { ok: true });
    } catch (error) {
      // Реакция — украшение: 400 (нет доступа к сообщению, служебное) не ошибка хода.
      log("reaction_failed", { delivery_id: delivery.delivery_id, status: Number(error.status || 0), error: String(error.message || error) });
      await settle(delivery, { ok: true });
    }
    return;
  }

  if (method === "editMessageText") {
    const messageId = Number(payload.message_id ?? payload.reply_to_message_id ?? 0);
    const ok = messageId ? await editStatus(Number(delivery.chat_id), messageId, text, payload.disable_notification === true ? true : undefined) : false;
    if (ok) { await settle(delivery, { ok: true, telegramMessageId: messageId }); return; }
    const sent = await telegram("sendMessage", sendArgs(delivery, payload, text));
    await settle(delivery, { ok: true, telegramMessageId: sent.message_id });
    return;
  }

  if (method === "sendMessageDraft") {
    const draft = await sendDraft(delivery, payload, text);
    if (draft) { await settle(delivery, { ok: true }); return; }
    // Откат: тот же текст уходит правкой статус-пузыря или новым сообщением.
    const existing = key ? statusBubbles[key] : null;
    if (existing && await editStatus(Number(delivery.chat_id), existing, text, true)) { await settle(delivery, { ok: true, telegramMessageId: existing }); return; }
    const sent = await telegram("sendMessage", sendArgs(delivery, payload, text));
    if (key) { statusBubbles[key] = sent.message_id; await saveStatusBubbles(); }
    await settle(delivery, { ok: true, telegramMessageId: sent.message_id });
    return;
  }

  if (method !== "sendMessage") {
    // Неизвестный метод: сервер новее gateway. Не падаем и не теряем ход —
    // помечаем доставку abandoned с причиной в логе.
    log("unknown_method", { delivery_id: delivery.delivery_id, method, kind: delivery.kind });
    await settle(delivery, { ok: false, permanent: true, error: `unknown_method:${method}` });
    return;
  }

  if (delivery.kind === "progress") {
    const existing = key ? statusBubbles[key] : null;
    const result = existing
      ? { message_id: (await editStatus(Number(delivery.chat_id), existing, text, true)) ? existing : null }
      : await telegram("sendMessage", sendArgs(delivery, payload, text));
    if (result.message_id && key) { statusBubbles[key] = result.message_id; await saveStatusBubbles(); }
    retriggerTyping(delivery.chat_id);
    await settle(delivery, { ok: true, telegramMessageId: result.message_id || undefined });
    return;
  }
  if (delivery.kind === "final" && key && statusBubbles[key]) {
    const bubble = statusBubbles[key];
    delete statusBubbles[key];
    await saveStatusBubbles();
    // Финал — со звуком: disable_notification в правке не передаём.
    if (await editStatus(Number(delivery.chat_id), bubble, text)) { await settle(delivery, { ok: true, telegramMessageId: bubble }); return; }
  }
  const sent = await telegram("sendMessage", sendArgs(delivery, payload, text));
  await settle(delivery, { ok: true, telegramMessageId: sent.message_id });
}

async function settle(delivery, outcome) {
  await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/result`, { method: "POST", body: JSON.stringify(outcome) }).catch(() => {});
}

async function sendOutbox() {
  const { deliveries = [] } = await taskflow("/api/integrations/telegram/outbox?limit=20");
  for (const delivery of deliveries) {
    try {
      await taskflow(`/api/integrations/telegram/outbox/${delivery.delivery_id}/claim`, { method: "POST", body: "{}" });
      const payload = JSON.parse(delivery.payload_json || "{}");
      await sendDelivery(delivery, payload);
    } catch (error) {
      const status = Number(error.status || 0);
      const retryAfterSeconds = Number(error.parameters?.retry_after || 0) || undefined;
      await settle(delivery, { ok: false, permanent: status >= 400 && status < 500 && status !== 429, ambiguous: !status, retryAfterSeconds, error: String(error.message || error).slice(0, 500) });
    }
  }
}

// Меню синхронизируется при старте и дальше раз в 5 минут: сервер может быть
// ещё на старом коде (недоступный /commands) — тогда следующий заход догонит,
// а прежнее меню у бота остаётся рабочим.
const COMMANDS_RESYNC_MS = 5 * 60 * 1000;
let lastCommandsSync = 0;
async function resyncCommandsIfDue() {
  if (Date.now() - lastCommandsSync < COMMANDS_RESYNC_MS) return;
  lastCommandsSync = Date.now();
  await syncCommands().catch((error) => log("commands_sync_failed", { error: String(error.message || error) }));
}
await resyncCommandsIfDue();
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
while (!stopped) {
  try {
    const updates = await telegram("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ALLOWED_UPDATES });
    await resyncCommandsIfDue();
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
