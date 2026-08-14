// WebSocket client registry + broadcast helpers, extracted out of index.ts so
// route modules can push events without importing index.ts (which would be a
// module cycle — index.ts registers the routes and starts the listener).

import db from "./db.js";

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
  }
}

/** Push an event to every open socket for a single user. */
export function broadcast(userId: string | null | undefined, event: unknown) {
  if (!userId) return;
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

/** Push an event to several users at once, deduplicated. */
export function broadcastToUsers(
  userIds: Array<string | null | undefined>,
  event: unknown,
) {
  const seen = new Set<string>();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    broadcast(id, event);
  }
}
