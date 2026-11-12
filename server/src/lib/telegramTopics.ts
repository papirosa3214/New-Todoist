import crypto from "crypto";
import db from "../db.js";
import { SECRETARY_CHAT_ID } from "./secretaryReply.js";

/**
 * Топики Telegram как рабочие пространства (этап 7 плана note://a2475482).
 *
 * Зачем: сообщения разных тем должны расходиться по комнатам, а не лежать
 * одной лентой. Для этого нужна карта `telegram_topic_binding` (бот, чат, тред →
 * комната) — без неё «топик как рабочее пространство» остаётся косметикой.
 *
 * Адресация берётся из живого факта 06.11.2026 (отчёт Лайф-тестировщика
 * artifact_sav_38bfdddc), а не из документации: в личном чате топик адресуется
 * `message_thread_id`; `direct_messages_topic_id` там сообщение в топик не кладёт.
 * `message_thread_id` идёт в payload доставки — новых решений о транспорте он не
 * принимает, gateway просто подставляет его в аргументы Bot API.
 *
 * Выключатель `TASKFLOW_TELEGRAM_TOPICS` (по умолчанию выключен): без него тред
 * не читается, `/topic` — обычный текст, все сообщения идут в комнату Секретаря,
 * то есть поведение прежнее.
 */
export const TOPIC_COMMAND = "/topic";
/** `createForumTopic.name` — 1–128 символов по Bot API. */
export const TELEGRAM_TOPIC_TITLE_MAX = 128;

export function telegramTopicsEnabled(): boolean {
  const value = String(process.env.TASKFLOW_TELEGRAM_TOPICS ?? "").trim().toLowerCase();
  return ["1", "on", "true", "yes"].includes(value);
}

/** `message_thread_id` апдейта: целое > 0 и не служебный «общий» тред. */
export function normalizeThreadId(value: unknown): number | null {
  const thread = Number(value ?? 0);
  if (!Number.isSafeInteger(thread) || thread <= 0) return null;
  // В форумных чатах id общих сообщений — 1 («General»), в личном чате
  // Bot API отдаёт реальный номер треда. Служебный тред топиком не считаем.
  return thread === 1 ? null : thread;
}

export type TopicCommand =
  | { ok: true; action: "create" | "rename"; title: string }
  | { ok: false; error: "empty_title" };

/**
 * `/topic Работа` — создать топик с таким именем; `/topic rename Работа` —
 * переименовать текущий. Без имени — не команда, а подсказка (empty_title).
 * Своих таймеров и ботов не заводим: это обычная команда в тексте.
 */
export function parseTopicCommand(text: unknown): TopicCommand | null {
  const value = String(text ?? "").trim();
  const match = /^\/topic(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(value);
  if (!match) return null;
  const rest = String(match[1] ?? "").trim();
  if (!rest) return { ok: false, error: "empty_title" };
  const rename = /^(?:rename|переименуй|переименовать)\s+([\s\S]+)$/i.exec(rest);
  const title = (rename ? rename[1] : rest).trim().replace(/\s+/g, " ").slice(0, TELEGRAM_TOPIC_TITLE_MAX);
  if (!title) return { ok: false, error: "empty_title" };
  return { ok: true, action: rename ? "rename" : "create", title };
}

export type TopicBinding = {
  bot_id: string;
  chat_id: string;
  thread_id: number;
  chat_id_target: string;
  role_id: string;
  title: string | null;
};

const BINDING_COLUMNS = "bot_id,chat_id,thread_id,chat_id_target,role_id,title";

/** Привязка топика к комнате; null — топик не привязан (общий топик). */
export function topicBinding(botId: unknown, chatId: unknown, threadId: unknown): TopicBinding | null {
  if (!telegramTopicsEnabled()) return null;
  const thread = normalizeThreadId(threadId);
  if (!thread) return null;
  const row = db
    .prepare(`SELECT ${BINDING_COLUMNS} FROM telegram_topic_binding WHERE bot_id=? AND chat_id=? AND thread_id=?`)
    .get(String(botId ?? ""), String(chatId ?? ""), thread) as TopicBinding | undefined;
  return row ?? null;
}

/**
 * Куда идёт сообщение из треда. Неизвестный топик (его создали не через
 * `/topic`) — комната Секретаря: терять сообщение нельзя, а угадывать
 * комнату — тем более.
 */
export function topicTargetChat(botId: unknown, chatId: unknown, threadId: unknown): { chatId: string; roleId: string } {
  const binding = topicBinding(botId, chatId, threadId);
  return binding
    ? { chatId: binding.chat_id_target, roleId: binding.role_id }
    : { chatId: SECRETARY_CHAT_ID, roleId: "u-secretary" };
}

/** Устойчивый id комнаты топика: тот же топик — та же комната после рестарта. */
export function topicRoomId(botId: string, chatId: string, threadId: number): string {
  const digest = crypto.createHash("sha256").update(`${botId}|${chatId}|${threadId}`).digest("hex").slice(0, 16);
  return `chat-topic-${digest}`;
}

/** Создать комнату под топик (идемпотентно: повтор ничего не ломает). */
export function bindTopic(args: { botId: string; chatId: string; threadId: number; title: string }): TopicBinding {
  const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
  if (!owner) throw new Error("owner_not_found");
  const chatIdTarget = topicRoomId(args.botId, args.chatId, args.threadId);
  const existing = topicBinding(args.botId, args.chatId, args.threadId);
  if (existing) {
    if (existing.title !== args.title) {
      // Переименование: комната и привязка носят одно имя, иначе владелец
      // видит в списке не то, что написано в Telegram.
      db.transaction(() => {
        db.prepare("UPDATE telegram_topic_binding SET title=? WHERE bot_id=? AND chat_id=? AND thread_id=?").run(args.title, args.botId, args.chatId, args.threadId);
        db.prepare("UPDATE chats SET title=?, updated_at=datetime('now') WHERE id=?").run(args.title, existing.chat_id_target);
      })();
    }
    return { ...existing, title: args.title };
  }
  db.transaction(() => {
    // Отдельная комната на топик: истории топиков не смешиваются, а ход роли
    // остаётся тем же живым путём (роль Секретаря, как в chat-secretary).
    db.prepare("INSERT OR IGNORE INTO chats (id, title, kind, created_by, task_id) VALUES (?, ?, 'group', ?, NULL)").run(chatIdTarget, args.title, owner.id);
    db.prepare("UPDATE chats SET title=?, updated_at=datetime('now') WHERE id=?").run(args.title, chatIdTarget);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)").run(chatIdTarget, owner.id);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, 'u-secretary')").run(chatIdTarget);
    db.prepare(`INSERT INTO telegram_topic_binding(${BINDING_COLUMNS})
      VALUES(?,?,?,?,'u-secretary',?)`).run(args.botId, args.chatId, args.threadId, chatIdTarget, args.title);
  })();
  return { bot_id: args.botId, chat_id: args.chatId, thread_id: args.threadId, chat_id_target: chatIdTarget, role_id: "u-secretary", title: args.title };
}

/** Привязка по комнате: нужна, чтобы доставка в комнату знала свой тред. */
export function topicBindingOfRoom(chatIdTarget: string): TopicBinding | null {
  if (!telegramTopicsEnabled()) return null;
  const row = db
    .prepare(`SELECT ${BINDING_COLUMNS} FROM telegram_topic_binding WHERE chat_id_target=? ORDER BY created_at,thread_id LIMIT 1`)
    .get(chatIdTarget) as TopicBinding | undefined;
  return row ?? null;
}

/** Тред, известный по комнате: переименование по имени комнаты. */
export function knownThreadOfRoom(botId: string, chatId: string): number | null {
  const room = db
    .prepare("SELECT chat_id_target FROM telegram_topic_binding WHERE bot_id=? AND chat_id=? ORDER BY created_at DESC, thread_id DESC LIMIT 1")
    .get(botId, chatId) as { chat_id_target: string } | undefined;
  const binding = room ? topicBindingOfRoom(room.chat_id_target) : null;
  return binding ? binding.thread_id : null;
}

/** Ответ владельцу на `/topic` — обычный текст, не разметка. */
export function topicReplyText(action: "created" | "renamed" | "pending" | null, title: string | null, threadId: number | null): string {
  if (action === "pending") return `Создаю топик «${title}». Следующее сообщение в нём уже пойдёт в свою комнату.`;
  if (action === "renamed") return `Топик переименован в «${title}».`;
  if (action === "created") return `Топик «${title}» привязан к комнате. Всё, что вы напишете в нём, идёт туда; соседние топики обрабатываются параллельно, порядок внутри топика сохранён.`;
  return threadId ? `Топик ${threadId}. Чтобы создать новый, напишите /topic Название.` : "Чтобы создать рабочий топик, напишите /topic Название.";
}

/**
 * Вызов после ответа gateway на `createForumTopic`: только здесь у треда есть
 * номер, поэтому только здесь появляется привязка.
 */
export function settleTopicCreation(args: { botId: string; chatId: string; threadId: number; title: string }): TopicBinding {
  return bindTopic(args);
}

/** Все привязки: нужны для карты тредов в `/topic` без треда. */
export function listTopicBindings(botId: string, chatId: string): TopicBinding[] {
  return db
    .prepare(`SELECT ${BINDING_COLUMNS} FROM telegram_topic_binding WHERE bot_id=? AND chat_id=? ORDER BY created_at, thread_id`)
    .all(botId, chatId) as TopicBinding[];
}

/**
 * Комната связана с Telegram: Секретарь или комната топика. По этому признаку
 * чат-рантайм включает живой поток и отдаёт финал в Telegram — второй список
 * комнат не заводим, источник правды один: привязка топика.
 */
export function isTelegramRoom(chatId: string): boolean {
  if (chatId === SECRETARY_CHAT_ID) return true;
  return topicBindingOfRoom(chatId) !== null;
}
