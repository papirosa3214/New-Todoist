import type { FastifyInstance } from "fastify";
import { authOrApiToken, ownerOrApiToken } from "../auth.js";
import { piRuntime } from "../runtime/index.js";

/** Список известных провайдеров — синхронизирован с PiRuntimeAdapter.KNOWN_PROVIDERS.
 *  Здесь дублируется намеренно: роут-слой не зависит от внутреннего адаптера.
 *  Имя "openai-codex" — каноническое для OpenAI через Codex OAuth. */
const KNOWN_PROVIDERS = ["anthropic", "openai-codex", "minimax"] as const;

export function registerRuntimeRoutes(app: FastifyInstance): void {
  const authPre = authOrApiToken;

  app.get("/api/runtime/status", { preHandler: authPre }, async () => {
    const runtime = await piRuntime.status();
    return { runtime };
  });

  app.get("/api/runtime/profiles", { preHandler: authPre }, async () => {
    const profiles = await piRuntime.listProfiles();
    return { profiles };
  });

  app.get<{ Params: { id: string } }>(
    "/api/runtime/profiles/:id",
    { preHandler: authPre },
    async (req, reply) => {
      const profiles = await piRuntime.listProfiles();
      const profile = profiles.find((p) => p.id === req.params.id);
      if (!profile) return reply.code(404).send({ error: "profile not found" });
      return profile;
    },
  );

  app.get("/api/runtime/models", { preHandler: authPre }, async () => {
    const models = await piRuntime.listModels();
    return { models };
  });

  app.get("/api/runtime/providers", { preHandler: authPre }, async () => {
    // В HTTP-ответе — только три публичных поля. runtime_id, managedBy,
    // lastCheckedAt остаются в TypeScript-фасаде, но НЕ утекают наружу:
    // это внутренняя механика, владельцу она не нужна, а credential
    // details (refresh/access/expires) тут и так не было — они в
    // ~/.pi/agent/auth.json и сюда не попадают.
    const providers = await piRuntime.listProviders();
    return {
      providers: providers.map((p) => ({
        provider: p.id,
        status: p.status,
        authType: (p as { authType?: "oauth" | "api_key" | null }).authType ?? null,
      })),
    };
  });

  // POST /auth — это ЗАПИСЬ credentials. Жёстче authOrApiToken: только
  // owner/service или api-token со scope runtime:auth (через ownerOrApiToken).
  // Обычный api_token не пройдёт (403 owner_or_service_required).
  app.post<{
    Params: { provider: string };
    Body: { apiKey?: string };
  }>(
    "/api/runtime/providers/:provider/auth",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const name = req.params.provider;
      if (!(KNOWN_PROVIDERS as readonly string[]).includes(name)) {
        return reply.code(404).send({ error: "unknown provider" });
      }
      const body = req.body ?? {};
      try {
        const result = await piRuntime.connectProvider(name, body);
        return {
          provider: result.id,
          status: result.status,
          authType: (result as { authType?: "oauth" | "api_key" | null })
            .authType ?? null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // OAuth провайдер: вместо записи возвращаем инструкцию с командой,
        // которую owner/service выполняет в интерактивном Pi.
        if (msg.includes("uses OAuth") || msg.includes("use authInstruction")) {
          const instr = await piRuntime.authInstruction(name);
          return reply.code(200).send(instr);
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );
}
