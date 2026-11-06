import { recoverAgentDelivery } from "./chats.js";
import type { FastifyInstance } from "fastify";
import { telegramCommands, TELEGRAM_COMMANDS_ROLE, TELEGRAM_COMMANDS_MODE } from "../lib/telegramCommands.js";
import {
  acceptTelegramInbound,
  captureTelegramFinal,
  isKnownTelegramMethod,
  isLoopback,
  markTelegramSending,
  secureSecretEqual,
  settleTelegramDelivery,
  telegramConfig,
  telegramOutbox,
  telegramStatus,
  transcribeTelegramAudio,
} from "../integrations/telegram.js";

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

  app.get("/api/integrations/telegram/outbox", { preHandler: auth }, async (req: any) => ({ deliveries: telegramOutbox(Number(req.query?.limit ?? 20)) }));

  app.post<{ Params: { id: string } }>("/api/integrations/telegram/outbox/:id/claim", { preHandler: auth }, async (req, reply) => {
    if (!markTelegramSending(req.params.id)) return reply.code(409).send({ error: "not_claimable" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/integrations/telegram/outbox/:id/result", { preHandler: auth }, async (req: any) => {
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
