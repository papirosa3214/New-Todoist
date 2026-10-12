import type { FastifyInstance, FastifyReply } from "fastify";
import { authOrApiToken, ownerOrApiToken } from "../auth.js";
import { piRuntime } from "../runtime/index.js";
import { authSessionManager, type AuthSessionEvent } from "../runtime/AuthSession.js";
import {
  AuthInputNotExpectedError,
  AuthSessionNotFoundError,
  ModelNotAvailableError,
  RuntimeUnavailableError,
} from "../runtime/errors.js";
import {
  ROLE_NAMES,
  providerOfModel,
  loadRoleRouting,
  writeRuntimeConfig,
  type RoleName,
} from "../roleRouting.js";
import { modelExists } from "../runtime/PiRuntimeAdapter.js";
import db from "../db.js";
import { getFailoverSettings, setFailoverSettings } from "../lib/failoverSettings.js";
import { readProviderQuota } from "../lib/providerQuota.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { pickStartModel } from "../runtime/providerFailover.js";

/** Единый маппинг ошибок runtime-слоя в HTTP. Ключевое различие
 *  (спека §14): Pi недоступен → 503 runtime_unavailable; модели нет в
 *  каталоге → 422 model_not_available. */
export function sendRuntimeError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof RuntimeUnavailableError) {
    return reply.code(503).send({ error: "runtime_unavailable", message: err.message });
  }
  if (err instanceof ModelNotAvailableError) {
    return reply
      .code(422)
      .send({ error: "model_not_available", model: err.model, provider: err.provider });
  }
  if (err instanceof AuthSessionNotFoundError) {
    return reply.code(404).send({ error: "auth_session_not_found", message: err.message });
  }
  if (err instanceof AuthInputNotExpectedError) {
    return reply.code(409).send({ error: "auth_input_not_expected", message: err.message });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return reply.code(400).send({ error: msg });
}

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

  app.get("/api/runtime/models", { preHandler: authPre }, async (_req, reply) => {
    try {
      const models = await piRuntime.listModels();
      return { models };
    } catch (err) {
      return sendRuntimeError(reply, err);
    }
  });

  app.get("/api/runtime/providers", { preHandler: authPre }, async (_req, reply) => {
    // В HTTP-ответе нет credential details (спека §17). Отдаём только
    // публичные поля: провайдер, статус, тип И текущих credentials и
    // список поддерживаемых способов авторизации. Ни токенов, ни refresh,
    // ни expires, ни accountId.
    try {
      const providers = await piRuntime.listProviders();
      return {
        providers: providers.map((p) => ({
          provider: p.id,
          name: p.name ?? p.id,
          status: p.status,
          authType: p.authType ?? null,
          authMethods: p.authMethods ?? [],
        })),
      };
    } catch (err) {
      return sendRuntimeError(reply, err);
    }
  });

  // POST /auth — запуск авторизации. api_key пишется сразу и persistent
  // (ModelRuntime.login, штатный CredentialStore Pi). OAuth запускается
  // ФОНОМ и отвечает 202 authSessionId немедленно — иначе пользователь
  // никогда не увидит auth_url (спека §3).
  app.post<{
    Params: { provider: string };
    Body: { apiKey?: string };
  }>(
    "/api/runtime/providers/:provider/auth",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const name = req.params.provider;
      const body = req.body ?? {};
      try {
        const providers = await piRuntime.listProviders();
        if (!providers.some((p) => p.id === name)) {
          return reply.code(404).send({ error: "unknown provider" });
        }
        if (body.apiKey?.trim()) {
          const conn = await piRuntime.connectProvider(name, body);
          return {
            provider: conn.id,
            status: conn.status,
            authType: conn.authType ?? null,
          };
        }
        const session = await piRuntime.startAuthSession(name);
        return reply.code(202).send({
          authSessionId: session.id,
          provider: session.provider,
          status: session.status,
        });
      } catch (err) {
        return sendRuntimeError(reply, err);
      }
    },
  );

  // Снимок auth-сессии — polling-фолбэк для клиентов без SSE.
  app.get<{ Params: { id: string } }>(
    "/api/runtime/auth/:id",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const session = piRuntime.getAuthSession(req.params.id);
      if (!session) {
        return reply.code(404).send({ error: "auth_session_not_found" });
      }
      return session;
    },
  );

  // SSE-поток событий auth-сессии: auth_url, device_code, prompt,
  // progress, success, error, cancelled. ?since=<seq> — догнать пропуск.
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/runtime/auth/:id/events",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const id = req.params.id;
      const initial = piRuntime.getAuthSession(id);
      if (!initial) {
        return reply.code(404).send({ error: "auth_session_not_found" });
      }
      const since = Number(req.query.since ?? 0) || 0;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const write = (event: AuthSessionEvent) => {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const session = authSessionManager.get(id);
      if (!session) {
        reply.raw.end();
        return reply;
      }
      for (const event of session.eventsSince(since)) write(event);

      const unsubscribe = session.subscribe(write);
      const ping = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch { /* сокет закрыт */ }
      }, 15_000);
      const cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      reply.raw.on("close", cleanup);
      reply.raw.on("error", cleanup);
      if (session.finished) {
        cleanup();
        reply.raw.end();
      }
      return reply;
    },
  );

  // Ответ пользователя на pending prompt (manual_code / text / secret /
  // select) — двусторонний AuthInteraction (спека §6).
  app.post<{
    Params: { id: string };
    Body: { type?: string; value?: string };
  }>(
    "/api/runtime/auth/:id/input",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const value = req.body?.value;
      if (typeof value !== "string") {
        return reply.code(422).send({ error: "value must be a string" });
      }
      try {
        piRuntime.submitAuthInput(req.params.id, value);
        return reply.code(202).send({ ok: true });
      } catch (err) {
        return sendRuntimeError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/runtime/auth/:id",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const session = piRuntime.getAuthSession(req.params.id);
      if (!session) {
        return reply.code(404).send({ error: "auth_session_not_found" });
      }
      piRuntime.cancelAuthSession(req.params.id);
      return reply.code(204).send();
    },
  );

  // GET /api/runtime/routing — текущий role-routing. Диагностика, не запись.
  app.get("/api/runtime/routing", { preHandler: authPre }, async () => {
    const routing = loadRoleRouting();
    return { routing };
  });

  // PUT /api/runtime/routing/:role — запись primary + ordered fallbacks.
  // Fallback-список УПОРЯДОЧЕН (спека §15): порядок сохраняется как есть,
  // без sort() — иначе Sonnet→Sol→MiniMax превратится в другой routing.
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
      // fallbacks не передан — запасные роли остаются как есть: на них держится автопереключение
      // при лимите (runtime/providerFailover.ts), а веб запасные не показывает и не должен их затирать.
      const keepFallbacks = fallbacks === undefined;
      if (!keepFallbacks && (!Array.isArray(fallbacks) ||
          fallbacks.some((m) => typeof m !== "string" || !m.trim()))) {
        return reply.code(422).send({ error: "fallbacks must be array of non-empty strings" });
      }
      // Дедуп сохраняет порядок первого вхождения.
      const orderedFallbacks = keepFallbacks
        ? (loadRoleRouting().fallbacks[role] ?? []).filter((m) => m !== primary.trim())
        : Array.from(new Set(fallbacks as string[]));
      if (!keepFallbacks && orderedFallbacks.includes(primary)) {
        return reply.code(422).send({ error: "primary must not appear in fallbacks" });
      }

      try {
        if (!(await modelExists(primary.trim()))) {
          return reply.code(422).send({ error: `model_not_available: ${primary}` });
        }
        for (const fb of orderedFallbacks) {
          if (!(await modelExists(fb))) {
            return reply.code(422).send({ error: `model_not_available: ${fb}` });
          }
        }
      } catch (err) {
        return sendRuntimeError(reply, err);
      }

      const config = loadRoleRouting();
      config.models[role] = primary.trim();
      config.fallbacks[role] = orderedFallbacks;
      try {
        writeRuntimeConfig(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `write failed: ${msg}` });
      }
      return { role, primary: primary.trim(), fallbacks: orderedFallbacks };
    },
  );

  // GET /api/runtime/failover — тумблеры автопереключения, провайдеры в лимите и, у каждой роли,
  // на какой модели она работает сейчас.
  app.get("/api/runtime/failover", { preHandler: authPre }, async () => {
    const routing = loadRoleRouting();
    const limits = db
      .prepare(
        `SELECT provider, unavailable_until, mode, reason FROM provider_limits
          WHERE unavailable_until IS NOT NULL AND unavailable_until > datetime('now')
          ORDER BY provider`,
      )
      .all() as { provider: string; unavailable_until: string; mode: string; reason: string | null }[];
    const roles = (ROLE_NAMES as RoleName[]).map((role) => {
      const primary = routing.models[role] ?? "";
      const current = primary ? pickStartModel(routing, role) : "";
      return { role, primary, fallbacks: routing.fallbacks[role] ?? [], current, on_fallback: !!primary && current !== primary };
    });
    const s = getFailoverSettings();
    // Остаток лимитов у провайдеров, которые его отдают (владелец 12.10.2026:
    // «почему он у нас не отображается, когда в лёгкую видно остатки на панели
    // провайдера»). Провайдер берём из ПРЕФИКСА модели: providerOfModel — грубая
    // эвристика, и opencode-go/... сводила ею к minimax, из-за чего провайдер
    // в ответ не попадал вовсе.
    const providers = Array.from(new Set(
      [
        ...(Object.values(routing.models) as string[]),
        // и запасные: opencode-go живёт именно в цепочке, а не в основной модели
        ...Object.values(routing.fallbacks).flat(),
      ].filter(Boolean).map((m) => parseModelRef(m as string).provider).filter(Boolean),
    ));
    const quota = await Promise.all(providers.map(async (provider) => {
      const q = await readProviderQuota(provider);
      return {
        provider,
        known: q.known,
        limited: q.limited,
        reset_at: q.resetAt ? q.resetAt.toISOString() : null,
        detail: q.detail ?? null,
      };
    }));
    return {
      auto_switch: s.autoSwitch,
      auto_return: s.autoReturn,
      quota,
      limits: limits.map((l) => ({
        provider: l.provider,
        until: l.unavailable_until,
        // «Держится вручную»: автовозврат выключен, метка не истечёт сама.
        held: new Date(l.unavailable_until.replace(" ", "T") + "Z").getTime() > Date.now() + 400 * 86400_000,
        mode: l.mode,
        reason: l.reason,
      })),
      roles,
    };
  });

  // PUT /api/runtime/failover — тумблеры автопереключения / автовозврата (общие на все роли).
  app.put<{ Body: { auto_switch?: unknown; auto_return?: unknown } }>(
    "/api/runtime/failover",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const body = req.body ?? {};
      for (const k of ["auto_switch", "auto_return"] as const) {
        if (body[k] !== undefined && typeof body[k] !== "boolean") {
          return reply.code(422).send({ error: `${k} must be boolean` });
        }
      }
      const before = getFailoverSettings();
      const next = setFailoverSettings({
        autoSwitch: body.auto_switch as boolean | undefined,
        autoReturn: body.auto_return as boolean | undefined,
      });
      // Автовозврат снова включён: «ручные» метки превращаем в обычные (проба снимет, когда лимит сброшен).
      if (!before.autoReturn && next.autoReturn) {
        db.prepare(
          `UPDATE provider_limits SET mode = 'probe', unavailable_until = datetime('now', '+5 hours'), updated_at = datetime('now')
            WHERE unavailable_until > datetime('now', '+30 days')`,
        ).run();
      }
      return { auto_switch: next.autoSwitch, auto_return: next.autoReturn };
    },
  );

  // DELETE /api/runtime/failover/limits/:provider — «Вернуть сейчас»: снять метку лимита у провайдера.
  app.delete<{ Params: { provider: string } }>(
    "/api/runtime/failover/limits/:provider",
    { preHandler: ownerOrApiToken },
    async (req) => {
      db.prepare(
        "UPDATE provider_limits SET unavailable_until = datetime('now'), reason = 'снято владельцем', updated_at = datetime('now') WHERE provider = ?",
      ).run(req.params.provider);
      return { ok: true };
    },
  );

  // PUT /api/runtime/routing — основная модель СРАЗУ ВСЕМ ролям (кнопка «Всем ролям»).
  // Запасные каждой роли не трогаются; если выбранная модель стояла у роли среди запасных,
  // она из запасных убирается, чтобы не дублировать основную.
  app.put<{ Body: { primary?: unknown } }>(
    "/api/runtime/routing",
    { preHandler: ownerOrApiToken },
    async (req, reply) => {
      const primary = req.body?.primary;
      if (typeof primary !== "string" || !primary.trim()) {
        return reply.code(422).send({ error: "primary must be non-empty string" });
      }
      const model = primary.trim();
      try {
        if (!(await modelExists(model))) {
          return reply.code(422).send({ error: `model_not_available: ${model}` });
        }
      } catch (err) {
        return sendRuntimeError(reply, err);
      }
      const config = loadRoleRouting();
      for (const role of ROLE_NAMES as RoleName[]) {
        config.models[role] = model;
        config.fallbacks[role] = (config.fallbacks[role] ?? []).filter((m) => m !== model);
      }
      try {
        writeRuntimeConfig(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `write failed: ${msg}` });
      }
      return { primary: model, roles: ROLE_NAMES };
    },
  );
}
