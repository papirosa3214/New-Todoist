// API подписок на события TaskFlow (`/api/integrations/webhooks`).
// Контракт зафиксирован в docs/research/2026-10-09-webhook-codex-wake-contract.md
// и реализован в server/src/lib/webhookSubscriptions.ts. Здесь — только
// тонкий слой Fastify: валидация, преобразование ошибок, авторизация.
//
// Уточнение ведущего 2026-10-10: секрет строго write-only во ВСЕХ
// ответах POST/PATCH/GET/test, включая ротацию. Владелец держит секрет
// у себя в keychain; на сервере он шифруется ключом
// TASKFLOW_WEBHOOK_SECRET_KEY и не покидает процесс. Поэтому ниже
// `secret` НЕ возвращается ни в одном `publicDto(...)`/ответ — только
// `secret_preview` для UI.
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import {
  ValidationError,
  WEBHOOK_PROJECT_ID,
  bootstrapSecrets,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  processWakePass,
  registerWakeAck,
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
      // write-only: секрет НЕ возвращается ни в одном ответе (см. уточнение
      // ведущего 2026-10-10). Владелец его уже знает — он его прислал.
      return { webhook: publicDto(out.webhook) };
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
        // write-only: секрет НЕ возвращается ни при создании, ни при
        // ротации. Владелец прислал новое значение в PATCH — значит, он
        // его уже знает; эхо в ответе не нужно и опасно.
        return { webhook: publicDto(dto) };
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

  /**
   * Явный callback подтверждения wake от чата Codex (D-5: ack только
   * по независимому подтверждению turn started или явному callback чата).
   * Тело: { codex_followup_id: string, kind?: string }. Открыт по
   * api_token — ожидаемо, что звонит desktop-bound Codex, а не
   * произвольный клиент. Возвращает { ok: true }.
   *
   * kind сейчас фиксируется в `wake_acked_kind` для последующего аудита
   * (например, различать app_server_turn_started и codex_chat_callback);
   * реальная маршрутизация «что считать acked» — будущая работа.
   */
  app.post<{ Body: { codex_followup_id?: string; kind?: string } }>(
    "/api/integrations/webhooks/_wake_ack",
    { preHandler: authOrApiToken },
    async (req: any, reply) => {
      const body = req.body ?? {};
      const followupId = typeof body.codex_followup_id === "string" ? body.codex_followup_id : "";
      const kind = typeof body.kind === "string" && body.kind ? body.kind : "codex_chat_callback";
      const r = registerWakeAck(followupId, kind);
      if (!r.ok) return reply.code(400).send({ error: r.reason });
      return { ok: true };
    },
  );

  /**
   * Bootstrap секретов (вызывается из server/src/index.ts на старте
   * сервера). Делает явный прогрев, чтобы владелец видел в логе, сколько
   * подписок удалось поднять. Не выдаёт никаких секретов наружу.
   * Защищён владельцем, чтобы посторонний не дёргал.
   */
  app.post(
    "/api/integrations/webhooks/_bootstrap_secrets",
    { preHandler: authOrApiToken },
    async (_req: any, reply) => {
      if (!isOwner(_req.userId)) return reply.code(403).send({ error: "только владелец" });
      const r = bootstrapSecrets();
      return r;
    },
  );
}
