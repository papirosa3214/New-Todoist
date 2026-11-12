import { recoverAgentDelivery } from "./chats.js";
import crypto from "node:crypto";
import db from "../db.js";
import { enqueueMessageDelivery } from "../runtime/chatQueue.js";
import { broadcastToUsers } from "../ws.js";
import { loadChatMessage } from "../lib/chatMessages.js";
import type { FastifyInstance } from "fastify";
import { telegramCommands, TELEGRAM_COMMANDS_ROLE, TELEGRAM_COMMANDS_MODE } from "../lib/telegramCommands.js";
import {
  acceptTelegramInbound,
  captureTelegramFinal,
  expireTelegramQuestionKeyboards,
  isKnownTelegramMethod,
  isLoopback,
  markTelegramSending,
  parseTelegramQuestionCallback,
  releaseTelegramQuestionKeyboard,
  secureSecretEqual,
  settleTelegramDelivery,
  telegramConfig,
  telegramOutbox,
  telegramStatus,
  transcribeTelegramAudio,
} from "../integrations/telegram.js";
import {
  answerQuestionRowIfOpen,
  openQuestionOfChat,
  payloadOf,
  questionByShortId,
  QuestionValidationError,
  renderAnswerText,
  validateAnswerPayload,
  type AnswerPayload,
  type QuestionRow,
} from "../lib/chatQuestions.js";
import { deliverAnswer } from "../lib/questionWait.js";

export function registerTelegramIntegrationRoutes(app: FastifyInstance) {
  const auth = async (req: any, reply: any) => {
    if (!isLoopback(req.ip)) return reply.code(404).send({ error: "Not found" });
    let cfg;
    try { cfg = telegramConfig(); }
    catch { return reply.code(503).send({ error: "Telegram integration is not configured" }); }
    if (!secureSecretEqual(req.headers["x-taskflow-integration-secret"], cfg.secret)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };

  app.post("/api/integrations/telegram/transcribe", { preHandler: auth }, async (req: any, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: "empty_audio" });
    if (req.body.length > 15 * 1024 * 1024) return reply.code(413).send({ error: "attachment_too_large" });
    const text = await transcribeTelegramAudio(req.body, String(req.headers["content-type"] || "audio/ogg"));
    return text ? { text } : reply.code(502).send({ error: "asr_unavailable" });
  });

  app.post("/api/integrations/telegram/inbound", { preHandler: auth }, async (req: any, reply) => {
    try {
      const result = await acceptTelegramInbound(req.body);
      // Сообщение из Telegram — обычный ход роли, а не «доставка на потом».
      // Раньше здесь только писалась строка очереди, и без клиента TaskFlow
      // её подбирал лишь периодический sweep (раз в 10 минут) — владелец
      // видел «очередь» вместо ответа. Запускаем тот же путь, что и вопрос
      // владельца роли: recoverAgentDelivery сам сериализует ход (FIFO).
      if (!result.duplicate && result.queue_row_id) {
        void recoverAgentDelivery({ chatId: result.chat_id, roleId: result.role_id, queueRowId: result.queue_row_id })
          .catch((error) => console.warn("[telegram] ход по входящему не поехал:", error));
      }
      return reply.code(result.duplicate ? 200 : 202).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "inbound_failed";
      const status = code === "rate_limited" || code === "conversation_queue_full" ? 429
        : code.includes("not_allowed") || code === "private_chat_required" ? 403
        : code === "attachment_too_large" ? 413
        : code.startsWith("unsafe_") || code === "unsupported_attachment_type" ? 415 : 400;
      return reply.code(status).send({ error: code });
    }
  });

  app.get("/api/integrations/telegram/outbox", { preHandler: auth }, async (req: any) => {
    // Срок кнопок вопроса проверяется здесь же: gateway опрашивает outbox
    // постоянно, поэтому отдельного таймера и новой службы не нужно.
    try { expireTelegramQuestionKeyboards(); } catch (error) { console.warn("[telegram] срок кнопок вопроса не проверен:", error); }
    return { deliveries: telegramOutbox(Number(req.query?.limit ?? 20)) };
  });

  /**
   * Нажатие inline-кнопки вопроса (этап 3 плана note://a2475482).
   *
   * Gateway присылает разобранный `callback_query`; сервер сам решает, что
   * значит кнопка. Идемпотентность — атомарный UPDATE по `status='open'`:
   * повторное нажатие не создаёт второго ответа и второго хода.
   * Ответ владельца уходит в ждущий ход (deliverAnswer), а если ход уже не
   * ждёт — поднимает новый ход тем же путём, что и ответ из чата.
   */
  app.post("/api/integrations/telegram/callback", { preHandler: auth }, async (req: any, reply) => {
    const body = (req.body ?? {}) as { callback_id?: unknown; callback_data?: unknown; chat_id?: unknown; message_id?: unknown };
    const parsed = parseTelegramQuestionCallback(body.callback_data);
    if (!parsed) return reply.code(400).send({ status: "invalid", answer_text: "Кнопка не распознана" });
    const question = questionByShortId(parsed.short);
    if (!question) return reply.code(404).send({ status: "unknown", answer_text: "Вопрос уже закрыт" });
    if (question.status !== "open") {
      closeTelegramQuestionKeyboard(question, body.chat_id, body.message_id);
      return { status: "already", answer_text: "Уже отвечено" };
    }
    const payload = payloadOf(question);
    const item = payload.questions[parsed.questionIndex];
    const option = item?.options[parsed.optionIndex];
    if (!item || !option) {
      closeTelegramQuestionKeyboard(question, body.chat_id, body.message_id);
      return reply.code(400).send({ status: "invalid", answer_text: "Такого варианта в вопросе нет" });
    }
    let answer: AnswerPayload;
    try {
      answer = validateAnswerPayload(payload, [{ questionIndex: parsed.questionIndex, selected: [option.label] }]);
    } catch (error) {
      if (error instanceof QuestionValidationError) return reply.code(400).send({ status: "invalid", answer_text: error.message });
      throw error;
    }
    const settled = settleTelegramQuestionAnswer(question, answer);
    if (!settled) {
      closeTelegramQuestionKeyboard(question, body.chat_id, body.message_id);
      return { status: "already", answer_text: "Уже отвечено" };
    }
    closeTelegramQuestionKeyboard(question, body.chat_id, body.message_id);
    return { status: "answered", resumed: settled.resumed, answer_text: "Ответ принят" };
  });

  app.post<{ Params: { id: string } }>("/api/integrations/telegram/outbox/:id/claim", { preHandler: auth }, async (req, reply) => {
    if (!markTelegramSending(req.params.id)) return reply.code(409).send({ error: "not_claimable" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/integrations/telegram/outbox/:id/result", { preHandler: auth }, async (req: any) => {
    // `thread_id` в ответе gateway — id топика, который вернул createForumTopic
    // (этап 7): только здесь сервер узнаёт, к какому треду привязывать комнату.
    settleTelegramDelivery(req.params.id, req.body ?? { ok: false });
    return { ok: true };
  });

  app.post<{ Params: { messageId: string } }>("/api/integrations/telegram/final/:messageId", { preHandler: auth }, async (req) => ({ created: captureTelegramFinal(req.params.messageId) }));
  /**
   * Меню команд и inline-поиск (этап 2 плана note://a2475482). Реестр тот же,
   * что у чата: второй список команд не заводится. ETag — хеш списка, чтобы
   * gateway не дёргал реестр каждые пять минут заново.
   */
  app.get("/api/integrations/telegram/commands", { preHandler: auth }, async (req: any, reply) => {
    const { menu, all, version } = await telegramCommands({ force: req.query?.refresh === "1" });
    const etag = `"${version}"`;
    reply.header("etag", etag).header("cache-control", "no-cache");
    if (String(req.headers["if-none-match"] ?? "") === etag) return reply.code(304).send();
    return { version, role: TELEGRAM_COMMANDS_ROLE, mode: TELEGRAM_COMMANDS_MODE, menu, all };
  });
  /**
   * Проба транспорта для живых проверок этапа 4: сервер только сообщает,
   * известен ли метод, решения о транспорте не принимает (оно в gateway).
   */
  app.get("/api/integrations/telegram/method/:name", { preHandler: auth }, async (req: any, reply) => {
    const name = String(req.params.name ?? "");
    return isKnownTelegramMethod(name) ? { name, known: true } : reply.code(404).send({ error: "unknown_method", name });
  });
  app.get("/api/integrations/telegram/status", { preHandler: auth }, async () => telegramStatus());
}

/** Погасить клавиатуру сообщения вопроса, если gateway сообщил его id. */
function closeTelegramQuestionKeyboard(question: QuestionRow, chatId: unknown, messageId: unknown): void {
  const chat = String(chatId ?? "").trim();
  const message = Number(messageId ?? 0);
  if (!chat || !Number.isSafeInteger(message) || message <= 0) return;
  if (!question.message_id) return;
  try { releaseTelegramQuestionKeyboard(question.message_id, chat, message); } catch (error) { console.warn("[telegram] клавиатура вопроса не погашена:", error); }
}

/**
 * Закрыть вопрос ответом из кнопки: тот же путь, что у ответа из чата —
 * запись ответа владельца в чат, атомарный UPDATE статуса, отдача ответа
 * ждущему ходу. Возвращает null, если вопрос уже закрыт (гонка двух нажатий).
 */
function settleTelegramQuestionAnswer(question: QuestionRow, answer: AnswerPayload): { resumed: boolean } | null {
  const payload = payloadOf(question);
  const owner = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
  if (!owner) return null;
  const текст = renderAnswerText(payload, answer);
  const id = crypto.randomUUID();
  let closed = false;
  db.transaction(() => {
    // Сначала статус: атомарный UPDATE — единственный замок против двух нажатий.
    closed = answerQuestionRowIfOpen(question.id, answer);
    if (!closed) return;
    db.prepare(
      `INSERT INTO chat_messages (id, from_user_id, text, channel, chat_id, reply_to_message_id)
       VALUES (?, ?, ?, 'chat', ?, ?)`,
    ).run(id, owner.id, текст, question.chat_id, question.message_id);
    db.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(question.chat_id);
  })();
  if (!closed) return null;
  broadcastToUsers(
    (db.prepare("SELECT member_id FROM chat_members WHERE chat_id = ?").all(question.chat_id) as Array<{ member_id: string }>).map((row) => row.member_id),
    { type: "chat:new", message: loadChatMessage(id) },
  );
  const resumed = deliverAnswer(question.id, answer);
  if (!resumed) {
    // Ход уже не ждёт (пауза истекла): ответ поднимает новый ход — тем же
    // путём, что входящее из Telegram: durable-очередь + recoverAgentDelivery.
    try {
      const delivery = enqueueMessageDelivery({
        chatId: question.chat_id,
        roleId: question.role_id,
        deliveryId: `tg-answer:${question.id}`,
        messageId: id,
        payload: { hop: 0, mode: "work", text: текст },
      });
      void recoverAgentDelivery({ chatId: question.chat_id, roleId: question.role_id, queueRowId: delivery.id })
        .catch((error) => console.warn("[telegram] ответ на вопрос не поднял ход роли:", error));
    } catch (error) {
      console.warn("[telegram] ответ на вопрос не поставлен в очередь:", error);
    }
  }
  return { resumed };
}
