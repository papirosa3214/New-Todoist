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
import { onCoordinationAnswered, registerCrossSessionOrigin } from "./chatCoordination.js";
import { recordDurableDelivery } from "./chatSession.js";
import { enqueueMessageDelivery } from "./chatQueue.js";
import { activeVoiceCallId } from "../lib/voiceCallRegistry.js";

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

/**
 * Ответ адресата будит спросившую роль (владелец 11.11.2026).
 *
 * Раньше ответ только закрывал карточку в сессии отправителя, хода ему не
 * поднимал: Помощник спросил Инженера .110, тот ответил, а Помощник так и
 * остался на «ждём». Вызов роли (`roleSubagentCall`) будил всегда — теперь
 * и обращение через сессию: ответ ложится в сессию отправителя сообщением,
 * строка очереди поднимает ему ход. Повтор того же ответа отсекается по
 * delivery_id.
 */
type WakeLauncher = (input: { chatId: string; roleId: string; queueRowId: string }) => void;
let wakeLauncher: WakeLauncher = (input) => {
  void import("../routes/chats.js")
    .then(({ recoverAgentDelivery }) => recoverAgentDelivery(input))
    .catch((error) => console.warn("[cross-session] ход отправителя не поднялся:", error));
};
/** Подмена запуска хода (тесты). */
export function setCrossSessionWakeLauncher(fn: WakeLauncher): void {
  wakeLauncher = fn;
}

// Подписка откладывается на микрозадачу: модульный граф доходит сюда раньше,
// чем chatCoordination завершит инициализацию (agentMessaging → этот файл →
// chatCoordination), и прямой вызов падал на «answerListeners before
// initialization» — весь сервер не грузился в тестах (11.11.2026).
queueMicrotask(() => onCoordinationAnswered(({ deliveryKey, questionId, recipientId, answer }) => {
  if (!deliveryKey.startsWith("cross-session:")) return;
  const question = db
    .prepare(
      "SELECT json_extract(steps,'$.coordination_origin.chat_id') AS chat, json_extract(steps,'$.coordination_origin.requester_id') AS requester, text FROM chat_messages WHERE id=? AND json_valid(steps)",
    )
    .get(questionId) as { chat: string | null; requester: string | null; text: string } | undefined;
  if (!question?.chat || !question.requester) return;
  const requester = db.prepare("SELECT type FROM users WHERE id=?").get(question.requester) as { type: string } | undefined;
  if (requester?.type !== "ai") return;
  const recipientName =
    (db.prepare("SELECT name FROM users WHERE id=?").get(recipientId) as { name: string } | undefined)?.name ?? recipientId;
  const deliveryId = `cross-session-answer:${questionId}`;
  const known = db
    .prepare("SELECT 1 FROM chat_message_queue WHERE chat_id=? AND role_id=? AND delivery_id=?")
    .get(question.chat, question.requester, deliveryId);
  if (known) return;
  const messageId = crypto.randomUUID();
  const text = [`Ответ «${recipientName}» на твоё обращение «${String(question.text).slice(0, 160)}»:`, "", answer].join("\n");
  db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,?,'chat',?)").run(
    messageId,
    question.requester,
    text,
    question.chat,
  );
  const queued = enqueueMessageDelivery({
    chatId: question.chat,
    roleId: question.requester,
    deliveryId,
    messageId,
    payload: { mode: "work", hop: 0 },
  });
  if (activeVoiceCallId(question.chat)) return;
  wakeLauncher({ chatId: question.chat, roleId: question.requester, queueRowId: queued.id });
}));
