// API подписок на события TaskFlow (`/api/integrations/webhooks`).
// Контракт зафиксирован в docs/research/2026-10-09-webhook-codex-wake-contract.md
// и реализован в server/src/lib/webhookSubscriptions.ts. Здесь — только
// тонкий слой Fastify: валидация, преобразование ошибок, авторизация.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import {
  ValidationError,
  WEBHOOK_PROJECT_ID,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  processWakePass,
  testSubscriptionDelivery,
  updateSubscription,
  type WebhookDTO,
} from "../lib/webhookSubscriptions.js";

function publicDto(dto: WebhookDTO): WebhookDTO {
  return dto; // DTO уже не содержит секрета (только preview)
}

function errorFromValidation(reply: any, e: unknown): unknown {
  if (e instanceof ValidationError) {
    return reply.code(400).send({ error: e.message });
  }
  if (e instanceof Error) {
    return reply.code(500).send({ error: e.message });
  }
  return reply.code(500).send({ error: "internal error" });
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.get("/api/integrations/webhooks", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const userId = req.userId;
    const onlyMine = !isOwner(userId); // владелец видит все, остальные — только свои
    try {
      const dtos = onlyMine ? listSubscriptions(userId) : listSubscriptions();
      return { webhooks: dtos.map(publicDto) };
    } catch (e) {
      return errorFromValidation(reply, e);
    }
  });

  app.post<{ Body: {
    name: string;
    url: string;
    secret: string;
    enabled?: boolean;
    event_kinds?: string[];
    project_id?: string | null;
    codex_thread_id?: string | null;
  } }>("/api/integrations/webhooks", { preHandler: authOrApiToken }, async (req: any, reply) => {
    const userId = req.userId;
    const body = req.body ?? {};
    try {
      const out = createSubscription({
        owner_user_id: userId,
        name: body.name,
        url: body.url,
        secret: body.secret,
        enabled: body.enabled,
        event_kinds: body.event_kinds,
        project_id: body.project_id === undefined ? WEBHOOK_PROJECT_ID : body.project_id,
        codex_thread_id: body.codex_thread_id,
      });
      return { webhook: publicDto(out.webhook), secret: out.secret };
    } catch (e) {
      return errorFromValidation(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/integrations/webhooks/:id",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const userId = req.userId;
      const id = req.params.id;
      const onlyMine = !isOwner(userId);
      try {
        const dto = getSubscription(id, onlyMine ? userId : undefined);
        if (!dto) return reply.code(404).send({ error: "не найдено" });
        return { webhook: publicDto(dto) };
      } catch (e) {
        return errorFromValidation(reply, e);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/integrations/webhooks/:id",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const userId = req.userId;
      const id = req.params.id;
      const onlyMine = !isOwner(userId);
      try {
        const dto = updateSubscription(id, req.body ?? {}, onlyMine ? userId : undefined);
        // Если меняли секрет — пробросим полное значение ОДИН РАЗ.
        const incoming = (req.body ?? {}) as { secret?: unknown };
        return {
          webhook: publicDto(dto),
          secret: typeof incoming.secret === "string" && incoming.secret.length >= 16 ? incoming.secret : undefined,
        };
      } catch (e) {
        return errorFromValidation(reply, e);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/integrations/webhooks/:id",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const userId = req.userId;
      const id = req.params.id;
      const onlyMine = !isOwner(userId);
      try {
        const ok = deleteSubscription(id, onlyMine ? userId : undefined);
        if (!ok) return reply.code(404).send({ error: "не найдено" });
        return { ok: true };
      } catch (e) {
        return errorFromValidation(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { codex_thread_id?: string | null } }>(
    "/api/integrations/webhooks/:id/test",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const userId = req.userId;
      const id = req.params.id;
      const onlyMine = !isOwner(userId);
      if (!getSubscription(id, onlyMine ? userId : undefined)) {
        return reply.code(404).send({ error: "не найдено" });
      }
      try {
        const codexThreadOverride =
          typeof req.body?.codex_thread_id === "string" ? req.body.codex_thread_id : null;
        const r = await testSubscriptionDelivery(id, fetch, undefined, codexThreadOverride);
        return r;
      } catch (e) {
        return errorFromValidation(reply, e);
      }
    },
  );

  // Служебная ручка для QA-инструментов: принудительно прогнать один проход
  // wake-моста (без ожидания 2-секундного цикла). Только владелец.
  app.post(
    "/api/integrations/webhooks/_wake_now",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) return reply.code(403).send({ error: "только владелец" });
      const r = await processWakePass();
      return r;
    },
  );
}
