import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";
import { piRuntime } from "../runtime/index.js";

/** Список известных провайдеров — синхронизирован с PiRuntimeAdapter.KNOWN_PROVIDERS.
 *  Здесь дублируется намеренно: роут-слой не зависит от внутреннего адаптера. */
const KNOWN_PROVIDERS = ["anthropic", "openai", "minimax"] as const;

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
    const providers = await piRuntime.listProviders();
    return { providers };
  });

  app.post<{ Params: { provider: string } }>(
    "/api/runtime/providers/:provider/auth",
    { preHandler: authPre },
    async (req, reply) => {
      const name = req.params.provider;
      if (!(KNOWN_PROVIDERS as readonly string[]).includes(name)) {
        return reply.code(404).send({ error: "unknown provider" });
      }
      // Заглушка до появления реального OAuth в Pi.
      // Возвращаем текущий статус из окружения, не инициируем OAuth.
      const providers = await piRuntime.listProviders();
      const provider = providers.find((p) => p.id === name);
      if (!provider) return reply.code(404).send({ error: "provider not found" });
      return {
        provider: provider.id,
        status: provider.status,
        note: "Реальный connectProvider появится в Pi; пока возвращается текущий статус.",
      };
    },
  );
}
