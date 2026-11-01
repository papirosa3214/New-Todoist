import {isQuietSystemMessage} from "./lib/serviceNoise.js";
// WebSocket client registry + broadcast helpers, extracted out of index.ts so
// route modules can push events without importing index.ts (which would be a
// module cycle — index.ts registers the routes and starts the listener).

import crypto from "node:crypto";
import db from "./db.js";
import { installRealtimeInvalidation } from "./lib/realtimeInvalidation.js";
import { queueLiveActivityPush } from "./apns.js";
import {
  DEVICE_OP_TIMEOUT_MS,
  DEVICE_PROTOCOL_VERSION,
  type DeviceOpOutcome,
  type DeviceOpRequest,
  type DeviceOpResult,
} from "./device/protocol.js";

type Socket = { readyState: number; send: (data: string) => void; close?: (code?: number, reason?: string) => void };

const clients = new Map<string, Set<Socket>>();

// Сокеты, открытые токеном УСТРОЙСТВА, отдельно от сокетов пользователя
// (карточка b5a16110, отзыв устройства §8).
//
// Хранятся оба среза: в clients — чтобы слать события по userId (как раньше),
// здесь — чтобы по отзыву закрыть ИМЕННО сокеты этого телефона. Закрывать
// все сокеты пользователя нельзя: у Максима одновременно открыт браузер на
// маке и телефон, и отзыв телефона не должен вышибать браузер.
//
// Ключ — device_id, а не токен: токена в памяти процесса нет и быть не
// должно (в базе лежит только его sha256).
const deviceSockets = new Map<string, Set<Socket>>();

/** Закрыть все живые сокеты отозванного устройства кодом 4401.
 *
 * 4401, а не обычное закрытие — это сигнал для приложения: значит
 * «устройство отозвали», а не «сеть моргнула». Приложение по нему чистит
 * токен из Keychain и возвращает экран привязки (документ решения §10 п.7),
 * а не переподключается в бесконечном цикле. */
export function closeDeviceSockets(deviceId: string) {
  const set = deviceSockets.get(deviceId);
  if (!set) return;
  for (const socket of set) {
    try {
      socket.close?.(4401, "device_revoked");
    } catch {
      // Сокет мог умереть между сборомset и закрытием — тогда делать нечего.
    }
  }
  deviceSockets.delete(deviceId);
}

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

let invalidationInstalled = false;

/** Топики, которые адресуются по задаче (создатель/исполнитель/владелец).
 *  Остальные — события сущностей (проект, метка, заметка, рутина, вложение):
 *  у них получателя «создатель задачи» нет, их видит владелец. */
const TASK_SCOPED_TOPICS = new Set(["task:changed", "roles:changed", "role-jobs:changed"]);
export function addClient(userId: string, socket: Socket, deviceId?: string | null) {
  if (!invalidationInstalled) {
    installRealtimeInvalidation(db, (taskID, topic) => {
      if (topic === "task:changed" && !taskID) return;
      // Сущности вне задач (проекты, метки, заметки, рутины, вложения):
      // адресовать по создателю/исполнителю нечего — шлём всем владельцам.
      // Клиент по такому событию перечитывает свой стор, а не одну карточку.
      if (!TASK_SCOPED_TOPICS.has(topic)) {
        if (!taskID) return;
        broadcastToUsers(ownerIds(), { type: topic, id: taskID });
        return;
      }
      const task = taskID ? db.prepare("SELECT creator_id,assignee_id FROM tasks WHERE id=?").get(taskID) as {creator_id:string;assignee_id:string}|undefined : undefined;
      broadcastTaskEvent(task ? [task.creator_id,task.assignee_id] : [], {type:topic,task_id:taskID || undefined});
    });
    invalidationInstalled = true;
  }
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(socket);
  if (deviceId) {
    if (!deviceSockets.has(deviceId)) deviceSockets.set(deviceId, new Set());
    deviceSockets.get(deviceId)!.add(socket);
  }
  setStatus(userId, "online");
}

export function removeClient(userId: string, socket: Socket) {
  const set = clients.get(userId);
  // Убираем из среза устройств ТОЖЕ: иначе отозванное устройство держало бы
  // в памяти сокеты, которых уже нет, и closeDeviceSockets() закрывала бы
  // их по второму разу при каждом отзыве.
  for (const [deviceId, socketsOfOne] of deviceSockets) {
    if (socketsOfOne.delete(socket) && socketsOfOne.size === 0) {
      deviceSockets.delete(deviceId);
      // Телефон отвалился посреди команды — висящий вызов должен упасть
      // сейчас, а не ждать своего таймаута: иначе роль полминуты думает,
      // что айфон думает.
      failDeviceOps(deviceId, new Error("связь с телефоном потеряна"));
    }
  }
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
  const chatEvent = event as {type?:string; message?:unknown};
  if (chatEvent?.type === "chat:new" && isQuietSystemMessage(chatEvent.message)) return;
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

// ─────────────────────────────────────────────────────────────────────────
// Канал команд устройству: запрос → ответ (device_op).
//
// Зачем: сокет устройства до сих пор был только «доставкой событий»
// (инвалидация доски, Live Activity). Этого мало — Apple Напоминания и
// Apple Календарь лежат на айфоне, а роль работает на сервере .110: нужен
// способ СКАЗАТЬ телефону «создай напоминание» и ДОЖДАТЬСЯ ответа.
//
// Образец — runOperation в host/gateway.ts: тот же приём (opId как ключ
// корреляции, таймаут, отмена вызывающего), но адресат — устройство, а не
// машина. Своя копия протокола (op, имена операций) — в device/protocol.ts.
//
// Чего тут нет: логики доступа к Apple-данным. Она живёт на устройстве
// (EventKit), сервер только проксирует — ровно как с Things 3.
// ─────────────────────────────────────────────────────────────────────────

type PendingDeviceOp = {
  deviceId: string;
  op: string;
  resolve: (outcome: DeviceOpOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Отменён ли вызов — чтобы результат, пришедший после отмены, её не воскресил. */
  cancelled: boolean;
  /** Снять слушатель abort: сигнал вызывающего живёт весь ход роли. */
  снятьAbort?: () => void;
};

const pendingDeviceOps = new Map<string, PendingDeviceOp>();

/** Есть ли живой сокет устройства. Проверяем сокет, а не запись в базе:
 *  телефон мог отвалиться, а строка в devices живёт до отзыва. */
export function deviceSocketAlive(deviceId: string): boolean {
  const сокеты = deviceSockets.get(deviceId);
  if (!сокеты) return false;
  for (const socket of сокеты) if (socket.readyState === 1) return true;
  return false;
}

/** Идентификаторы устройств с живым сокетом прямо сейчас. */
export function liveDeviceIds(): string[] {
  const ids: string[] = [];
  for (const [deviceId, сокеты] of deviceSockets) {
    for (const socket of сокеты) {
      if (socket.readyState === 1) {
        ids.push(deviceId);
        break;
      }
    }
  }
  return ids;
}

/** Отправить сообщение устройству. Мёртвый сокет — не повод ронять вызов:
 *  сокетов у устройства может быть несколько, пробуем следующий. */
function sendToDevice(deviceId: string, message: DeviceOpRequest): boolean {
  const сокеты = deviceSockets.get(deviceId);
  if (!сокеты || сокеты.size === 0) return false;
  const payload = JSON.stringify(message);
  let доставлено = false;
  for (const socket of [...сокеты]) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(payload);
      доставлено = true;
    } catch {
      // Сокет умер между проверкой и отправкой — следующий по списку.
    }
  }
  return доставлено;
}

export type RunDeviceOpOptions = {
  /** Отмена вызывающего (AbortSignal инструмента роли). */
  signal?: AbortSignal;
  /** Потолок ожидания; сервер может уменьшить, но не увеличить. */
  timeoutMs?: number;
};

/**
 * Вызвать операцию на устройстве и дождаться результата.
 *
 * Отказ (reject) — это поломка канала: устройства нет, связь пропала,
 * телефон не ответил за отведённое время. Отказ самого устройства — не
 * исключение, а { ok: false } с кодом: для роли это данные («нет доступа»),
 * а не поломка шлюза.
 */
export function runDeviceOp(
  deviceId: string,
  op: string,
  args: Record<string, unknown> = {},
  options: RunDeviceOpOptions = {},
): Promise<DeviceOpOutcome> {
  if (!deviceSocketAlive(deviceId)) {
    return Promise.reject(new Error("устройство сейчас офлайн"));
  }
  const opId = crypto.randomUUID();
  const timeoutMs = Math.min(
    options.timeoutMs ?? DEVICE_OP_TIMEOUT_MS,
    DEVICE_OP_TIMEOUT_MS,
  );

  return new Promise<DeviceOpOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDeviceOps.delete(opId);
      pending.снятьAbort?.();
      reject(new Error(`телефон не ответил за ${Math.round(timeoutMs / 1000)}с`));
    }, timeoutMs);
    timer.unref?.();

    const pending: PendingDeviceOp = {
      deviceId,
      op,
      resolve,
      reject,
      timer,
      cancelled: false,
    };
    pendingDeviceOps.set(opId, pending);

    const onAbort = () => cancelDeviceOp(opId);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      pending.снятьAbort = () => options.signal!.removeEventListener("abort", onAbort);
    }

    const доставлено = sendToDevice(deviceId, {
      type: "device_op",
      v: DEVICE_PROTOCOL_VERSION,
      opId,
      op,
      arguments: args,
      timeoutMs,
    });
    if (!доставлено) {
      clearTimeout(timer);
      pending.снятьAbort?.();
      pendingDeviceOps.delete(opId);
      reject(new Error("устройство сейчас офлайн"));
    }
  });
}

/** Отменить вызов к устройству. true — отмена учтена; false — вызова уже нет. */
export function cancelDeviceOp(opId: string): boolean {
  const pending = pendingDeviceOps.get(opId);
  if (!pending) return false;
  pending.cancelled = true;
  clearTimeout(pending.timer);
  pendingDeviceOps.delete(opId);
  pending.снятьAbort?.();
  pending.reject(new Error("вызов отменён"));
  return true;
}

/** Все висящие вызовы устройства — «связь потеряна». */
function failDeviceOps(deviceId: string, error: Error) {
  for (const [opId, pending] of [...pendingDeviceOps]) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    pendingDeviceOps.delete(opId);
    pending.снятьAbort?.();
    pending.reject(error);
  }
}

/**
 * Обработать сообщение от устройства. Возвращает false для всего, что
 * серверу не адресовано: телефон шлёт и обычные события.
 */
export function handleDeviceOpResult(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const сообщение = raw as DeviceOpResult;
  if (сообщение.type !== "device_op_result") return false;
  const opId = typeof сообщение.opId === "string" ? сообщение.opId : "";
  if (!opId) return true;
  const pending = pendingDeviceOps.get(opId);
  // Повторный ответ с тем же opId (или ответ на чужой) — игнор: телефон
  // обязан ответить ровно один раз, но лишний ответ не должен ронять вызов.
  if (!pending || pending.cancelled) return true;
  clearTimeout(pending.timer);
  pending.снятьAbort?.();
  pendingDeviceOps.delete(opId);

  if (сообщение.ok === true) {
    pending.resolve({ ok: true, data: сообщение.data });
    return true;
  }
  const ошибка = (сообщение.error ?? {}) as { code?: unknown; message?: unknown };
  pending.resolve({
    ok: false,
    error: {
      code: typeof ошибка.code === "string" ? ошибка.code : "internal",
      message:
        typeof ошибка.message === "string"
          ? ошибка.message
          : "телефон не объяснил, что случилось",
    },
  });
  return true;
}

/** Сброс состояния канала. Только для тестов: в одном процессе живут
 *  десятки тестовых файлов, и висящий вызов из одного теста иначе держал
 *  бы таймер в следующем. */
export function resetDeviceOpsForTests() {
  for (const [opId, pending] of [...pendingDeviceOps]) {
    clearTimeout(pending.timer);
    pendingDeviceOps.delete(opId);
    pending.reject(new Error("тест сбросил канал устройств"));
  }
  pendingDeviceOps.clear();
}
