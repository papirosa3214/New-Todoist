// Журнал отправки событий по сокетам (владелец 06.11.2026: «почему ты до
// сих пор этих журналов не насоздавал… не только чата — всех событий»).
//
// Зачем: ответ помощника сохранился в 15:11:30, а телефон пришёл за ним
// только в 15:11:50 — по журналу HTTP не видно, отправил ли сервер событие
// в сокет вообще. Теперь каждая отправка оставляет строку `[ws-out]`:
// кому, какое событие, сколько сокетов, сколько получили, сколько пропущено
// (служебный сокет устройства, закрытый сокет), и почему событие отброшено.
//
// Частые порции потока (`…:patch`, `chats:live`, `tasks:live`) идут каждые
// ~150 мс — их сводим в одну строку на получателя/тип/чат раз в 2 с, иначе
// журнал забьётся. Подключения и закрытия сокетов — `[ws-conn]`.

export type WsDelivery = {
  userId: string;
  type: string;
  chatId?: string | null;
  taskId?: string | null;
  sockets: number;
  sent: number;
  deviceSkipped: number;
  notOpen: number;
  dropped?: string;
};

let sink: (line: string) => void = (line) => console.log(line);

/** Только для тестов: куда писать строки журнала. */
export function setWsLogSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export const STREAM_FLUSH_MS = 2_000;

export function isStreamEvent(type: string): boolean {
  return type.endsWith(":patch") || type === "chats:live" || type === "tasks:live";
}

/** Чат и задача события — откуда бы они ни лежали в теле. */
export function eventRefs(event: unknown): { type: string; chatId: string | null; taskId: string | null } {
  const e = (event ?? {}) as Record<string, any>;
  const type = typeof e.type === "string" ? e.type : "?";
  const chatId = e.chat_id ?? e.chatId ?? e.message?.chat_id ?? e.chat?.id ?? null;
  const taskId = e.task_id ?? e.taskId ?? e.task?.id ?? null;
  return {
    type,
    chatId: typeof chatId === "string" ? chatId : null,
    taskId: typeof taskId === "string" ? taskId : null,
  };
}

function line(d: WsDelivery, count?: number): string {
  const parts = [`[ws-out] ${new Date().toISOString()} user=${d.userId} type=${d.type}`];
  if (d.chatId) parts.push(`chat=${d.chatId}`);
  if (d.taskId) parts.push(`task=${d.taskId}`);
  if (count !== undefined) parts.push(`count=${count}`);
  if (d.dropped) parts.push(`dropped=${d.dropped}`);
  else parts.push(`sockets=${d.sockets} sent=${d.sent} device_skipped=${d.deviceSkipped} not_open=${d.notOpen}`);
  return parts.join(" ");
}

type StreamBucket = { first: WsDelivery; count: number; sent: number; deviceSkipped: number; notOpen: number; sockets: number };
const stream = new Map<string, StreamBucket>();

export function logWsDelivery(d: WsDelivery): void {
  if (!d.dropped && isStreamEvent(d.type)) {
    const key = `${d.userId}|${d.type}|${d.chatId ?? d.taskId ?? ""}`;
    const bucket = stream.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.sent += d.sent;
      bucket.deviceSkipped += d.deviceSkipped;
      bucket.notOpen += d.notOpen;
      bucket.sockets = Math.max(bucket.sockets, d.sockets);
    } else {
      stream.set(key, { first: d, count: 1, sent: d.sent, deviceSkipped: d.deviceSkipped, notOpen: d.notOpen, sockets: d.sockets });
    }
    return;
  }
  sink(line(d));
}

/** Сбросить накопленные порции потока одной строкой на получателя/тип/чат. */
export function flushWsStream(): void {
  for (const bucket of stream.values()) {
    sink(line({ ...bucket.first, sockets: bucket.sockets, sent: bucket.sent,
      deviceSkipped: bucket.deviceSkipped, notOpen: bucket.notOpen }, bucket.count));
  }
  stream.clear();
}

setInterval(flushWsStream, STREAM_FLUSH_MS).unref();

export function logWsConnection(kind: "open" | "close", userId: string, deviceId: string | null, userSockets: number): void {
  sink(`[ws-conn] ${new Date().toISOString()} ${kind} user=${userId} socket=${deviceId ? `device:${deviceId}` : "session"} user_sockets=${userSockets}`);
}
