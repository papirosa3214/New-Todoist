import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { composioCredentialConfigured, roleComposioPolicy, saveComposioPolicy } from "../runtime/composioPolicy.js";
import { inspectComposio } from "../runtime/composioRuntime.js";

export function registerComposioRoutes(app: FastifyInstance) {
  const authorize = async (req: any, reply: any) => {
    await authOrApiToken(req, reply);
    if (reply.sent) return;
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "Настройки Composio доступны владельцу" });
    if (!ROLE_NAMES.includes(req.params.role)) return reply.code(404).send({ error: "Роль не найдена" });
  };
  app.get("/api/roles/:role/composio", { preHandler: authorize }, async (req: any) => {
    const policy = roleComposioPolicy(req.params.role, req.userId);
    const configured = composioCredentialConfigured();
    try {
      const catalog = configured ? await inspectComposio(policy, "catalog", String(req.query.search ?? "").slice(0, 100)) : { items: [] };
      return { enabled: policy.enabled, toolkits: policy.toolkits, configured, available: configured, catalog: catalog.items, error: configured ? null : "Ключ Composio ещё не настроен на сервере" };
    } catch (error) {
      return { enabled: policy.enabled, toolkits: policy.toolkits, configured, available: false, catalog: [], error: (error as Error).message };
    }
  });
  app.patch("/api/roles/:role/composio", { preHandler: authorize }, async (req: any, reply) => {
    const body = req.body;
    if (!body || typeof body.enabled !== "boolean" || !(body.toolkits === null || (Array.isArray(body.toolkits) && body.toolkits.length <= 1000 && body.toolkits.every((t: unknown) => typeof t === "string" && /^[a-z0-9_\-]{1,100}$/.test(t))))) {
      return reply.code(422).send({ error: "Нужны enabled и список toolkits либо null для всего каталога" });
    }
    const policy = { role: req.params.role, ownerId: req.userId, enabled: body.enabled, toolkits: body.toolkits === null ? null : [...new Set<string>(body.toolkits)] };
    saveComposioPolicy(policy);
    return { enabled: policy.enabled, toolkits: policy.toolkits };
  });
  app.post("/api/roles/:role/composio/authorize", { preHandler: authorize }, async (req: any, reply) => {
    const toolkit = req.body?.toolkit;
    if (typeof toolkit !== "string" || !/^[a-z0-9_\-]{1,100}$/.test(toolkit)) return reply.code(422).send({ error: "Укажите toolkit" });
    try { return await inspectComposio(roleComposioPolicy(req.params.role, req.userId), "authorize", toolkit); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
}
