import type { FastifyInstance } from "fastify";
import {
  acceptTelegramInbound,
  captureTelegramFinal,
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
      const result = acceptTelegramInbound(req.body);
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
  app.get("/api/integrations/telegram/status", { preHandler: auth }, async () => telegramStatus());
}
