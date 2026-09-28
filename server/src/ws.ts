// WebSocket client registry + broadcast helpers, extracted out of index.ts so
// route modules can push events without importing index.ts (which would be a
// module cycle — index.ts registers the routes and starts the listener).

import db from "./db.js";
import { queueLiveActivityPush } from "./apns.js";

type Socket = { readyState: number; send: (data: string) => void };

const clients = new Map<string, Set<Socket>>();

// users.status показывался на экране агентов, но никто его никогда не
// менял — все трое (Максим, Клод, Гермес) вечно висели «offline». Живой
// признак присутствия у нас уже есть: открытый сокет. Пока хоть один
// сокет пользователя жив — он «online», закрылся последний — «offline».
// Пишем прямо в базу, а не в память процесса: экран агентов читает
// пользователей обычным запросом, и после перезапуска сервера статусы не
// должны остаться враньём (сокетов после рестарта нет — см. resetAllOffline
// в index.ts).
function setStatus(userId: string, status: "online" | "offline") {
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
}

/** Все — «offline»: вызывается на старте сервера, когда живых сокетов нет. */
export function resetAllOffline() {
  db.prepare(
    "UPDATE users SET status = 'offline' WHERE status <> 'offline'",
  ).run();
}

export function addClient(userId: string, socket: Socket) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(socket);
  setStatus(userId, "online");
}

export function removeClient(userId: string, socket: Socket) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    clients.delete(userId);
    setStatus(userId, "offline");
    for (const listener of goneListeners) listener(userId);
  }
}

// «Последний сокет участника закрылся» нужно знать не только статусу: на
// этом же событии гаснет отметка «печатает» (chatTyping.ts). Импортировать
// её отсюда нельзя — она сама зависит от broadcastToUsers, вышел бы цикл;
// поэтому не вызов по имени, а подписка: желающий регистрирует обработчик.
type GoneListener = (userId: string) => void;
const goneListeners = new Set<GoneListener>();

export function onUserGone(listener: GoneListener) {
  goneListeners.add(listener);
}

// Событие про задачу уходит не только в открытые сокеты. Если по этой задаче
// на iPhone висит островок, его надо двигать и тогда, когда приложение
// свёрнуто, — а свёрнутое приложение сокет не слушает. Единственный путь туда
// лежит через APNs (apns.ts). Точка одна и та же, потому что и повод один:
// задача изменилась.
function alsoPushToIsland(event: unknown) {
  const e = event as { type?: string; task?: { id?: string } };
  if (!e?.type?.startsWith("task:") || !e.task?.id) return;
  queueLiveActivityPush(e.task);
}

/** Push an event to every open socket for a single user. */
export function broadcast(userId: string | null | undefined, event: unknown) {
  if (!userId) return;
  const notification = event as {type?:string;notificationId?:string};
  // Миграция подавляет дубли ещё при INSERT; не посылаем пустой сигнал.
  if (notification?.type === "notification:new" && notification.notificationId &&
      db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner'").get(userId) &&
      !db.prepare("SELECT 1 FROM notifications WHERE id=? AND user_id=?").get(notification.notificationId,userId)) return;
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

// Владельцы кэшируются на минуту: событие по задаче прилетает часто (каждый
// шаг агента), а роль в users меняется раз в полгода — гонять SELECT на
// каждый чих незачем.
let ownersCache: { ids: string[]; at: number } | null = null;

/** id всех учёток с role='owner' — им видна работа на доске целиком. */
function ownerIds(): string[] {
  const now = Date.now();
  if (ownersCache && now - ownersCache.at < 60_000) return ownersCache.ids;
  const rows = db
    .prepare("SELECT id FROM users WHERE role = 'owner'")
    .all() as Array<{ id: string }>;
  ownersCache = { ids: rows.map((r) => r.id), at: now };
  return ownersCache.ids;
}

/**
 * Событие ПО ЗАДАЧЕ: создателю, исполнителю и всегда — владельцу.
 *
 * Раньше слали только создателю и исполнителю, и у задачи, которую агент
 * завёл сам на себя, оба поля — это он сам: владелец не получал ничего.
 * Открытая на телефоне карточка молчала, пока её не закроешь и не откроешь
 * заново, — со стороны выглядело как «анимация шага пропала», хотя данные на
 * сервере были верные (09.09.2026, разбор с владельцем).
 *
 * Для адресных уведомлений («вас назначили») остаётся broadcastToUsers:
 * там получатель именно один, и владелец в списке не нужен.
 */
export function broadcastTaskEvent(
  userIds: Array<string | null | undefined>,
  event: unknown,
) {
  broadcastToUsers([...userIds, ...ownerIds()], event);
}

/** Push an event to several users at once, deduplicated. */
export function broadcastToUsers(
  userIds: Array<string | null | undefined>,
  event: unknown,
) {
  // Островок трогаем один раз на событие, а не на каждого адресата.
  alsoPushToIsland(event);
  const seen = new Set<string>();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    broadcast(id, event);
  }
}

// Сигнал «на связи» (28.09.2026). Клиенты (iOS — RealtimeClient.swift)
// считают сокет мёртвым после 45 с без входящих сообщений и переподключаются.
// Сервер раньше ничего не слал в тишине — телефон рвал живой канал раз в
// минуту и терял события, пришедшие в разрыв (живой ход роли в чате). Раз в
// 20 с — {"type":"ping"}, клиент отвечает {"type":"pong"}.
export const KEEPALIVE_MS = 20_000;
export const KEEPALIVE_PAYLOAD = JSON.stringify({ type: "ping" });

export function pingAllClients() {
  for (const set of clients.values()) {
    for (const socket of set) {
      if (socket.readyState === 1) socket.send(KEEPALIVE_PAYLOAD);
    }
  }
}

setInterval(pingAllClients, KEEPALIVE_MS).unref();
