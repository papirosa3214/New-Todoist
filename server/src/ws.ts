// WebSocket client registry + broadcast helpers, extracted out of index.ts so
// route modules can push events without importing index.ts (which would be a
// module cycle — index.ts registers the routes and starts the listener).

type Socket = { readyState: number; send: (data: string) => void };

const clients = new Map<string, Set<Socket>>();

export function addClient(userId: string, socket: Socket) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(socket);
}

export function removeClient(userId: string, socket: Socket) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) clients.delete(userId);
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
