import db from "../db.js";
import { broadcastToUsers } from "../ws.js";
import { liveTurnsOfChat, onLiveTurnEnd } from "./chatLiveTurn.js";

// Отложенные сообщения владельца (12.11.2026, как в T3 Code). Пока роль в
// чате отвечает, новое сообщение владельца не прерывает ход, а встаёт в
// очередь: в ленте его нет, оно лежит в chat_queued_messages. Ход
// закончился — первое уходит роли как обычное новое сообщение, остальные —
// по одному после каждого хода. «Отправить сейчас» вставляет его в текущий
// ход (подмешивание), «Убрать» отменяет.
//
// Здесь — хранилище, статус для клиента и разгрузка очереди. Саму отправку
// делает маршрут сообщений (routes/chats.ts): он регистрирует releaser,
// чтобы отложенное сообщение шло ровно тем же путём, что обычное.

export interface QueuedRow {
  message_id: string;
  chat_id: string;
  user_id: string;
  text: string;
  body_json: string;
  idempotency_key: string | null;
  created_at: string;
}

export interface ComposerRunning {
  chat_id: string;
  role_id: string;
  name: string;
  title: string | null;
  state: "working" | "waiting" | "done";
}

export interface ComposerStatus {
  queued: Array<{ message_id: string; text: string; created_at: string }>;
  running: ComposerRunning[];
}

/** Как давно закончившийся дочерний запуск ещё показывается как «done». */
const DONE_VISIBLE_SEC = 120;

export function enqueueQueued(row: Omit<QueuedRow, "created_at">): void {
  db.prepare(
    `INSERT INTO chat_queued_messages (message_id, chat_id, user_id, text, body_json, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.message_id, row.chat_id, row.user_id, row.text, row.body_json, row.idempotency_key);
}

export function queuedOfChat(chatId: string): QueuedRow[] {
  return db
    .prepare("SELECT * FROM chat_queued_messages WHERE chat_id = ? ORDER BY rowid")
    .all(chatId) as QueuedRow[];
}

export function queuedByKey(chatId: string, key: string): QueuedRow | undefined {
  return db
    .prepare("SELECT * FROM chat_queued_messages WHERE chat_id = ? AND idempotency_key = ?")
    .get(chatId, key) as QueuedRow | undefined;
}

export function queuedById(chatId: string, messageId: string): QueuedRow | undefined {
  return db
    .prepare("SELECT * FROM chat_queued_messages WHERE chat_id = ? AND message_id = ?")
    .get(chatId, messageId) as QueuedRow | undefined;
}

/** Забрать строку из очереди; true — это сделали мы (повторный забор — false). */
export function takeQueued(chatId: string, messageId: string): boolean {
  return db.prepare("DELETE FROM chat_queued_messages WHERE chat_id = ? AND message_id = ?").run(chatId, messageId).changes > 0;
}

/** Дочерние запуски, начатые из этого чата: комнаты субагентов и назначения. */
export function runningOfChat(chatId: string): ComposerRunning[] {
  const out: ComposerRunning[] = [];
  const rooms = db
    .prepare(
      `SELECT c.id, c.title, c.subagent_role_id AS role_id, c.subagent_state AS state, c.closed_at,
              COALESCE(u.name, c.subagent_role_id) AS name
         FROM chats c LEFT JOIN users u ON u.id = c.subagent_role_id
        WHERE c.branch_of_chat_id = ? AND c.subagent_role_id IS NOT NULL
        ORDER BY c.created_at`,
    )
    .all(chatId) as Array<{ id: string; title: string | null; role_id: string; state: string | null; closed_at: string | null; name: string }>;
  for (const room of rooms) {
    const live = liveTurnsOfChat(room.id).some((t) => t.user_id === room.role_id);
    if (room.state === "open" || room.state === null) {
      out.push({ chat_id: room.id, role_id: roleKey(room.role_id), name: room.name, title: room.title, state: live ? "working" : "waiting" });
    } else if (room.closed_at && recently(room.closed_at)) {
      out.push({ chat_id: room.id, role_id: roleKey(room.role_id), name: room.name, title: room.title, state: "done" });
    }
  }
  const children = db
    .prepare(
      `SELECT c.talk_chat_id AS chat_id, c.role_id, c.status, c.updated_at, c.title,
              (SELECT title FROM subtasks WHERE id = c.slot_id) AS slot_title,
              COALESCE(u.name, c.role_id) AS name
         FROM chat_child_sessions c LEFT JOIN users u ON u.id = c.role_id
        WHERE c.parent_chat_id = ? AND c.status IN ('assigned','delivered','waiting','answered')
        ORDER BY c.created_at`,
    )
    .all(chatId) as Array<{ chat_id: string; role_id: string; status: string; updated_at: string; title: string | null; slot_title: string | null; name: string }>;
  for (const child of children) {
    const title = child.slot_title ?? child.title;
    if (child.status === "answered") {
      if (recently(child.updated_at)) out.push({ chat_id: child.chat_id, role_id: roleKey(child.role_id), name: child.name, title, state: "done" });
    } else {
      out.push({ chat_id: child.chat_id, role_id: roleKey(child.role_id), name: child.name, title, state: child.status === "waiting" ? "waiting" : "working" });
    }
  }
  return out;
}

function recently(sqliteTime: string): boolean {
  const ms = Date.parse(sqliteTime.includes("T") ? sqliteTime : sqliteTime.replace(" ", "T") + "Z");
  return Number.isFinite(ms) && Date.now() - ms < DONE_VISIBLE_SEC * 1000;
}

/** «role_builder» → «builder»: клиент показывает роль по ключу. */
function roleKey(userId: string): string {
  const key = (db.prepare("SELECT role_key FROM users WHERE id = ?").get(userId) as { role_key: string | null } | undefined)?.role_key;
  return key || userId.replace(/^role_/, "");
}

export function composerStatus(chatId: string): ComposerStatus {
  return {
    queued: queuedOfChat(chatId).map((q) => ({ message_id: q.message_id, text: q.text, created_at: q.created_at })),
    running: runningOfChat(chatId),
  };
}

const lastSignature = new Map<string, string>();

/** Сообщить участникам, что очередь или запуски чата поменялись. */
export function emitComposerStatus(chatId: string): void {
  try {
    lastSignature.set(chatId, JSON.stringify(composerStatus(chatId)));
    const members = db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(chatId) as Array<{ member_id: string }>;
    broadcastToUsers(members.map((m) => m.member_id), { type: "chat.composer_status", chat_id: chatId });
  } catch (error) {
    console.warn("[chat-queued] не удалось разослать статус:", error instanceof Error ? error.message : error);
  }
}

interface Hooks {
  /** Идёт ли в чате (и его ветках) ход роли. */
  isBusy: (chatId: string) => boolean;
  /** Отправить отложенное ровно как обычное сообщение; false — не вышло. */
  release: (row: QueuedRow, steer: boolean) => Promise<boolean>;
}
let hooks: Hooks | null = null;
export function configureQueuedRelease(h: Hooks): void { hooks = h; }

const releasing = new Set<string>();

/** Выпустить первое отложенное чата, если ход закончился. */
export async function releaseNextQueued(chatId: string): Promise<boolean> {
  if (!hooks || releasing.has(chatId)) return false;
  const first = queuedOfChat(chatId)[0];
  if (!first || hooks.isBusy(chatId)) return false;
  releasing.add(chatId);
  try {
    return await sendQueued(first, false);
  } finally {
    releasing.delete(chatId);
  }
}

/** Отправить конкретное отложенное: steer — вставить в текущий ход. */
export async function sendQueued(row: QueuedRow, steer: boolean): Promise<boolean> {
  if (!hooks) return false;
  if (!takeQueued(row.chat_id, row.message_id)) return false;
  let ok = false;
  try {
    ok = await hooks.release(row, steer);
  } catch (error) {
    console.warn(`[chat-queued] отправка ${row.message_id} не удалась:`, error instanceof Error ? error.message : error);
  }
  emitComposerStatus(row.chat_id);
  return ok;
}

const timers = new Map<string, NodeJS.Timeout>();
/** Ход закончился: чуть подождать (ответ роли ещё ложится в историю) и выпустить. */
export function scheduleRelease(chatId: string, delayMs = 1500): void {
  if (timers.has(chatId)) return;
  const t = setTimeout(() => {
    timers.delete(chatId);
    void releaseNextQueued(chatId);
  }, delayMs);
  t.unref?.();
  timers.set(chatId, t);
}

/** Страховка и «живой» статус запусков: раз в несколько секунд. */
export function startQueuedSweeper(intervalMs = 4000): () => void {
  const offEnd = onLiveTurnEnd((turnChatId) => {
    const root = (db.prepare("SELECT branch_of_chat_id FROM chats WHERE id = ?").get(turnChatId) as { branch_of_chat_id: string | null } | undefined)?.branch_of_chat_id ?? turnChatId;
    scheduleRelease(root);
    emitComposerStatus(root);
  });
  const tick = () => {
    try {
      const chats = db.prepare("SELECT DISTINCT chat_id FROM chat_queued_messages").all() as Array<{ chat_id: string }>;
      for (const c of chats) scheduleRelease(c.chat_id, 0);
      // Запуски: рассылаем только когда картина поменялась.
      const watched = new Set<string>([...lastSignature.keys()]);
      for (const r of db.prepare("SELECT DISTINCT branch_of_chat_id AS id FROM chats WHERE subagent_role_id IS NOT NULL AND subagent_state='open' AND branch_of_chat_id IS NOT NULL").all() as Array<{ id: string }>) watched.add(r.id);
      for (const r of db.prepare("SELECT DISTINCT parent_chat_id AS id FROM chat_child_sessions WHERE status IN ('assigned','delivered','waiting')").all() as Array<{ id: string }>) watched.add(r.id);
      for (const id of watched) {
        const sig = JSON.stringify(composerStatus(id));
        if (sig !== lastSignature.get(id)) emitComposerStatus(id);
      }
    } catch (error) {
      console.warn("[chat-queued] обход не удался:", error instanceof Error ? error.message : error);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); offEnd(); };
}
