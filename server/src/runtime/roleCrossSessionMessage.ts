/**
 * Обращение роли к роли — через сессии (владелец 29.10.2026).
 *
 * Отдельных чатов «роль↔роль» больше нет. Схема:
 *
 *   1. Вопрос уходит в ПОСТОЯННУЮ сессию адресата (его личку). Там он
 *      лежит обычным сообщением: адресат читает его как входящее, работает
 *      и отвечает там же; владелец (он участник лички) это видит.
 *   2. В сессии отправителя появляется КАРТОЧКА обращения: «кто кому»,
 *      вопрос (под шевроном), статус, кнопка «Остановить». Само сообщение
 *      в сессии отправителя не дублируется — вопрос представлен карточкой.
 *   3. Ответ адресата закрывает карточку в сессии отправителя.
 *
 * Почему сервер пишет сообщение сам, а не роль через HTTP: отправитель не
 * участник лички адресата (иначе роли читали бы чужие переписки), а
 * сообщение от роли в чужой личке — обычное дело.
 */
import crypto from "node:crypto";
import db from "../db.js";
import { ensurePersonalRoom } from "../lib/chatRooms.js";
import { registerCrossSessionOrigin } from "./chatCoordination.js";
import { recordDurableDelivery } from "./chatSession.js";

export type CrossSessionPost = {
  /** Учётка отправителя (роль). */
  senderId: string;
  /** Сессия отправителя — там живёт карточка обращения. */
  senderChatId: string;
  /** Учётка адресата. */
  recipientId: string;
  /** Текст вопроса. */
  text: string;
  /** Счётчик цепочки вопросов (лимит переходов между ролями). */
  hop?: number;
};

export type CrossSessionPostResult = {
  /** id сообщения-вопроса в постоянной сессии адресата. */
  questionId: string;
  /** постоянная сессия адресата, куда ушёл вопрос. */
  roomId: string;
  /** id строки очереди доставки. */
  queueRowId: string;
};

/**
 * Отправить вопрос роли в её постоянную сессию и завести карточку
 * обращения в сессии отправителя.
 */
export function postToRoleSession(input: CrossSessionPost): CrossSessionPostResult {
  const roomId = ensurePersonalRoom(input.recipientId);
  if (!roomId)
    throw new Error("Не удалось открыть постоянную сессию адресата");
  const questionId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)",
  ).run(questionId, input.senderId, input.text, roomId);
  // Исток: вопрос пришёл из сессии отправителя — карточка живёт там.
  registerCrossSessionOrigin(questionId, input.senderChatId, input.senderId);
  const deliveryId = `cross-session:${questionId}`;
  const durable = recordDurableDelivery({
    chatId: roomId,
    roleId: input.recipientId,
    deliveryId,
    messageId: questionId,
    payload: {
      triggerMessageId: questionId,
      text: input.text,
      hop: input.hop ?? 0,
      mode: "work",
    },
  });
  return { questionId, roomId, queueRowId: durable.id };
}

/** Поднять доставку (ход адресата в его сессии). */
export async function startRoleSessionDelivery(input: {
  roomId: string;
  recipientId: string;
  queueRowId: string;
}): Promise<void> {
  const { recoverAgentDelivery } = await import("../routes/chats.js");
  await recoverAgentDelivery({
    chatId: input.roomId,
    roleId: input.recipientId,
    queueRowId: input.queueRowId,
  });
}
