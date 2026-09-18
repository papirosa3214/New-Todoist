import type { FastifyInstance } from "fastify";
import { authOrApiToken, ownerOrApiToken } from "../auth.js";
import { piRuntime } from "../runtime/index.js";
import {
  ROLE_NAMES,
  loadRoleRouting,
  writeRuntimeConfig,
  type RoleName,
} from "../roleRouting.js";
import { modelExists } from "../runtime/PiRuntimeAdapter.js";

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

  // GET /api/runtime/routing — текущий role-routing. Без авторизации
  // owner (только authOrApiToken): это диагностика, не запись.
  app.get("/api/runtime/routing", { preHandler: authPre }, async () => {
    const routing = loadRoleRouting();
    return { routing };
  });

  // PUT /api/runtime/routing/:role — запись primary + fallbacks для роли.
  // Валидация:
  //   - primary непустая строка;
  //   - fallbacks — массив строк (может быть пустым);
  //   - primary и каждый fallback существуют в pi --list-models;
  //   - primary не встречается в fallbacks.
  // Доступ: owner/service или api-token со scope runtime:auth.
  app.put<{
    Params: { role: string };
    Body: { primary?: unknown; fallbacks?: unknown };
  }>(
    "/api/runtime/routing/:role",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const role = req.params.role as RoleName;
      if (!ROLE_NAMES.includes(role)) {
        return reply.code(404).send({ error: "unknown role" });
      }
      const body = req.body ?? {};
      const primary = body.primary;
      const fallbacks = body.fallbacks;
      if (typeof primary !== "string" || !primary.trim()) {
        return reply.code(422).send({ error: "primary must be non-empty string" });
      }
      if (!Array.isArray(fallbacks) ||
          fallbacks.some((m) => typeof m !== "string" || !m.trim())) {
        return reply.code(422).send({ error: "fallbacks must be array of non-empty strings" });
      }
      const uniqueFallbacks = Array.from(new Set(fallbacks as string[]));
      if (uniqueFallbacks.includes(primary)) {
        return reply.code(422).send({ error: "primary must not appear in fallbacks" });
      }

      // Проверка моделей через pi --list-models (кэш 10 c).
      try {
        if (!(await modelExists(primary.trim()))) {
          return reply.code(422).send({ error: `model_not_available: ${primary}` });
        }
        for (const fb of uniqueFallbacks) {
          if (!(await modelExists(fb))) {
            return reply.code(422).send({ error: `model_not_available: ${fb}` });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(503).send({ error: `pi unreachable: ${msg}` });
      }

      const config = loadRoleRouting();
      config.models[role] = primary.trim();
      config.fallbacks[role] = uniqueFallbacks;
      // defaults трогать не нужно: для всех 8 ролей это pi_runtime, и
      // сейчас shell-семантика не используется.
      try {
        writeRuntimeConfig(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `write failed: ${msg}` });
      }
      return { role, primary: primary.trim(), fallbacks: uniqueFallbacks };
    },
  );
}
