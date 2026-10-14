import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner } from "../access.js";
import { ROLE_NAMES } from "../roleRouting.js";
import { composioCredentialConfigured, roleComposioPolicy, saveComposioPolicy } from "../runtime/composioPolicy.js";
import { inspectComposio } from "../runtime/composioRuntime.js";
import { composioAccountsCall } from "../runtime/composioAccounts.js";
import db from "../db.js";

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
  // Аккаунты сервиса у владельца («Интеграции»): несколько адресов одного сервиса.
  const ownerToolkit = async (req: any, reply: any) => {
    await authOrApiToken(req, reply);
    if (reply.sent) return;
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "Подключения доступны владельцу" });
    if (!/^[a-z0-9_\-]{1,100}$/.test(req.params.toolkit)) return reply.code(422).send({ error: "Укажите сервис" });
  };
  app.get("/api/integrations/composio/:toolkit/accounts", { preHandler: ownerToolkit }, async (req: any, reply) => {
    try { return await composioAccountsCall(req.userId, req.params.toolkit, "accounts"); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.post("/api/integrations/composio/:toolkit/accounts", { preHandler: ownerToolkit }, async (req: any, reply) => {
    const alias = req.body?.alias;
    if (alias !== undefined && (typeof alias !== "string" || alias.trim().length > 100)) return reply.code(422).send({ error: "Подпись аккаунта — до 100 символов" });
    try {
      const result = await composioAccountsCall(req.userId, req.params.toolkit, "account-link", { alias });
      if (result?.error === "alias_taken") return reply.code(409).send({ error: "Такой адрес уже добавлен" });
      if (!result?.url) return reply.code(502).send({ error: "Composio не выдал ссылку авторизации" });
      return { url: result.url };
    } catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.delete("/api/integrations/composio/:toolkit/accounts/:id", { preHandler: ownerToolkit }, async (req: any, reply) => {
    try {
      const result = await composioAccountsCall(req.userId, req.params.toolkit, "account-delete", { id: req.params.id });
      if (result?.error === "not_found") return reply.code(404).send({ error: "Аккаунт не найден" });
      return { ok: true };
    } catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  // Белый список отправителей почты: их письма Помощник владельца читает напрямую.
  const ownerOnly = async (req: any, reply: any) => {
    await authOrApiToken(req, reply);
    if (reply.sent) return;
    if (!isOwner(req.userId)) return reply.code(403).send({ error: "Белый список доступен владельцу" });
  };
  const trusted = () => ({ items: db.prepare("SELECT address, added_at FROM mail_trusted_senders ORDER BY added_at").all() });
  app.get("/api/integrations/mail/trusted", { preHandler: ownerOnly }, async () => trusted());
  app.post("/api/integrations/mail/trusted", { preHandler: ownerOnly }, async (req: any, reply) => {
    const address = String(req.body?.address ?? "").trim().toLowerCase();
    if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(address) || address.length > 320) return reply.code(422).send({ error: "Укажите адрес почты" });
    db.prepare("INSERT OR IGNORE INTO mail_trusted_senders(address, added_by) VALUES (?, ?)").run(address, req.userId);
    return trusted();
  });
  app.delete("/api/integrations/mail/trusted/:address", { preHandler: ownerOnly }, async (req: any) => {
    db.prepare("DELETE FROM mail_trusted_senders WHERE address = ?").run(String(req.params.address).trim().toLowerCase());
    return trusted();
  });
}
