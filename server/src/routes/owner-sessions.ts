import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authOrApiToken } from "../auth.js";
import { isOwner as userIsOwner } from "../access.js";
import { broadcast as socketBroadcast } from "../ws.js";
import {
  OwnerSessionModelError,
  OwnerSessionBranchError,
  OwnerSessionNotFoundError,
  OwnerSessionRuntime,
  OwnerSessionStreamingConflictError,
  type OwnerSessionPromptMode,
} from "../runtime/ownerSessionRuntime.js";
import { OwnerSessionEventBuffer } from "../runtime/ownerSessionEvents.js";
import { ownerAssistantProfile } from "../runtime/ownerAssistantProfile.js";
import { setOwnerSessionVoiceTarget } from "../lib/secretaryVoiceConversation.js";
import { chatBlocksCached } from "../lib/chatBlocks.js";
import { ownerSessionEntryKey, ownerSessionTurnUsageByEntry } from "../runtime/ownerSessionTurnUsage.js";

/** Ответы Помощника в снимке сессии — с той же разметкой, что в чате
 *  (владелец 12.11.2026): к записи ответа и голосовой реплике Помощника
 *  добавляется text_blocks. Файл сессии не меняется.
 *  Плюс расход хода (13.11.2026): на ПОСЛЕДНЮЮ запись ответа хода кладётся
 *  turn_usage той же формы, что строка расхода под ответом в чате.
 *  Незаконченный ход тоже получает итог — клиент обновит его по живому
 *  событию agent_settled. */
export function withAnswerBlocks<T extends { entries: any[] }>(snapshot: T): T {
  const turnUsage = ownerSessionTurnUsageByEntry(snapshot.entries);
  const entries = snapshot.entries.map((entry: any, index: number) => {
    let text = "";
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      const content = entry.message.content;
      text = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "";
    } else if (entry?.type === "custom_message" && entry.customType === "taskflow.voice" && entry.details?.role === "assistant") {
      text = String(entry.details.text ?? "");
    }
    const usage = turnUsage.get(ownerSessionEntryKey(entry, index));
    const patch: Record<string, unknown> = {};
    if (text.trim()) patch.text_blocks = chatBlocksCached(text);
    if (usage) patch.turn_usage = usage;
    return Object.keys(patch).length ? { ...entry, ...patch } : entry;
  });
  return { ...snapshot, entries };
}
import { ownerSessionMeta, type OwnerSessionMetaPatch, type OwnerSessionMetaStore } from "../lib/ownerSessionMeta.js";

type RuntimeContract = Pick<OwnerSessionRuntime,
  "openRoot" | "createRoot" | "open" | "list" | "contextUsage" | "snapshot" | "prompt" | "abort" | "branch" | "fork" | "subscribe" | "setModel"
> & {
  subscribeAll?: OwnerSessionRuntime["subscribeAll"];
};

type Authorize = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

export interface OwnerSessionRouteDependencies {
  runtime: RuntimeContract;
  events: OwnerSessionEventBuffer;
  broadcast: (userId: string, event: unknown) => void;
  authorize: Authorize;
  isOwner: (userId: string) => boolean;
  meta?: OwnerSessionMetaStore;
}

let defaultRuntime: OwnerSessionRuntime | undefined;
let defaultEvents: OwnerSessionEventBuffer | undefined;

function productionDependencies(): OwnerSessionRouteDependencies {
  if (!defaultRuntime) {
    const runsRoot = process.env.TASKFLOW_RUNS_DIR
      ?? path.join(os.homedir(), ".local", "state", "taskflow-runs");
    const cwd = process.env.VITEST ? os.tmpdir() : path.resolve(process.cwd(), "..");
    const sessionDir = process.env.VITEST
      ? path.join(os.tmpdir(), `taskflow-owner-sessions-${process.pid}`)
      : path.join(runsRoot, "owner-sessions");
    defaultRuntime = new OwnerSessionRuntime({
      cwd,
      sessionDir,
      // В тестах профиль не собираем: он подключает MCP и Composio.
      ...(process.env.VITEST ? {} : { assistantProfile: ownerAssistantProfile }),
    });
    // Голосовой вызов в сессии: мост Помощника пишет реплики в сессию.
    setOwnerSessionVoiceTarget(defaultRuntime);
  }
  defaultEvents ??= new OwnerSessionEventBuffer();
  return {
    runtime: defaultRuntime,
    events: defaultEvents,
    broadcast: socketBroadcast,
    authorize: authOrApiToken,
    isOwner: userIsOwner,
  };
}

type CachedResponse = { statusCode: number; body: unknown };

function sendRuntimeError(reply: FastifyReply, error: unknown) {
  if (error instanceof OwnerSessionNotFoundError) {
    return reply.code(404).send({ error: "session_not_found", sessionId: error.sessionId });
  }
  if (error instanceof OwnerSessionStreamingConflictError) {
    return reply.code(409).send({ error: "streaming_requires_explicit_mode" });
  }
  if (error instanceof OwnerSessionBranchError) {
    return reply.code(409).send({ error: "session_branch_conflict", message: error.message });
  }
  if (error instanceof OwnerSessionModelError) {
    return reply.code(400).send({ error: "model_unavailable", message: error.message });
  }
  throw error;
}

function requestIdFrom(body: unknown): string | null {
  const value = (body as { requestId?: unknown } | null)?.requestId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function registerOwnerSessionRoutes(
  app: FastifyInstance,
  dependencies: OwnerSessionRouteDependencies = productionDependencies(),
): void {
  const { runtime, events, broadcast, authorize, isOwner } = dependencies;
  const metaStore = dependencies.meta ?? ownerSessionMeta;
  const subscriptions = new Map<string, () => void>();
  const idempotency = new Map<string, CachedResponse>();

  const ownerOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    await authorize(request, reply);
    if (reply.sent) return;
    const userId = (request as any).userId as string | undefined;
    if (!userId || !isOwner(userId)) {
      return reply.code(403).send({ error: "owner_only" });
    }
  };

  const ensureForwarding = async (sessionId: string, ownerId: string) => {
    if (runtime.subscribeAll) {
      const globalKey = `${ownerId}:*`;
      if (subscriptions.has(globalKey)) return;
      const unsubscribe = runtime.subscribeAll((eventSessionId, event) => {
        const normalized = events.push(eventSessionId, event);
        broadcast(ownerId, { type: "session:event", event: normalized });
      });
      subscriptions.set(globalKey, unsubscribe);
      return;
    }
    const key = `${ownerId}:${sessionId}`;
    if (subscriptions.has(key)) return;
    const unsubscribe = await runtime.subscribe(sessionId, event => {
      const normalized = events.push(sessionId, event);
      broadcast(ownerId, { type: "session:event", event: normalized });
    });
    subscriptions.set(key, unsubscribe);
  };

  const mutate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: string,
    statusCode: number,
    operation: (requestId: string) => Promise<unknown>,
  ) => {
    const requestId = requestIdFrom(request.body);
    if (!requestId) return reply.code(400).send({ error: "requestId_required" });
    const userId = (request as any).userId as string;
    const key = `${userId}:${action}:${requestId}`;
    const cached = idempotency.get(key);
    if (cached) return reply.code(cached.statusCode).send(cached.body);
    try {
      const body = await operation(requestId);
      const response = { statusCode, body };
      idempotency.set(key, response);
      if (idempotency.size > 1000) idempotency.delete(idempotency.keys().next().value!);
      return reply.code(statusCode).send(body);
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  };

  app.post("/api/sessions/root", { preHandler: ownerOnly }, async (request: any, reply) => {
    try {
      const session = await runtime.openRoot();
      await ensureForwarding(session.id, request.userId);
      return { session };
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  // Новая сессия разговора (владелец 12.11.2026: «просто обычные сессии»).
  app.post("/api/sessions", { preHandler: ownerOnly }, async (request: any, reply) =>
    mutate(request, reply, "create-root", 201, async () => {
      const session = await runtime.createRoot();
      await ensureForwarding(session.id, request.userId);
      return { session };
    }));

  // Строка сессии в приложении — как строка чата: название, превью, время,
  // проект, закрепление (владелец 12.11.2026). Архивные — только по ?archived=1.
  app.get("/api/sessions", { preHandler: ownerOnly }, async (request: any) => {
    const wantArchived = request.query?.archived === "1";
    const list = await runtime.list();
    const labels = metaStore.read(list.map(session => session.id));
    const sessions = list
      .map(session => {
        const label = labels.get(session.id);
        const modified = (session as any).modified;
        return {
          id: session.id,
          cwd: session.cwd,
          name: session.name,
          parentSession: session.parentSessionPath,
          relation: session.relation,
          title: label?.title ?? session.name ?? null,
          firstMessage: (session as any).firstMessage ?? null,
          modified: modified instanceof Date ? modified.toISOString() : modified ?? null,
          messageCount: (session as any).messageCount ?? null,
          projectId: label?.projectId ?? null,
          pinned: label?.pinned ?? false,
          archivedAt: label?.archivedAt ?? null,
        };
      })
      .filter(session => Boolean(session.archivedAt) === wantArchived)
      .sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")));
    return { sessions };
  });

  app.patch("/api/sessions/:id", { preHandler: ownerOnly }, async (request: any, reply) => {
    const body = request.body ?? {};
    const allowed = new Set(["title", "project_id", "pinned", "archived"]);
    if (typeof body !== "object" || Object.keys(body).some(key => !allowed.has(key))) {
      return reply.code(400).send({ error: "unknown_field" });
    }
    const patch: OwnerSessionMetaPatch = {};
    if ("title" in body) patch.title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
    if ("project_id" in body) patch.projectId = typeof body.project_id === "string" ? body.project_id : null;
    if ("pinned" in body) patch.pinned = body.pinned === true;
    if ("archived" in body) patch.archived = body.archived === true;
    return { meta: metaStore.patch(request.params.id, patch) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", { preHandler: ownerOnly }, async (request: any, reply) => {
    try {
      const session = await runtime.open(request.params.id);
      await ensureForwarding(session.id, request.userId);
      return { session: withAnswerBlocks(session) };
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/context", { preHandler: ownerOnly }, async (request: any, reply) => {
    try {
      return { context: await runtime.contextUsage(request.params.id) };
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/sessions/:id/events",
    { preHandler: ownerOnly },
    async (request: any, reply) => {
      try {
        const session = await runtime.open(request.params.id);
        await ensureForwarding(session.id, request.userId);
        const slice = events.eventsAfter(request.query.after, session.id);
        if (!slice.resetRequired) return slice;
        return { ...slice, snapshot: withAnswerBlocks(await runtime.snapshot(session.id)) };
      } catch (error) {
        return sendRuntimeError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { requestId?: string; text?: string; mode?: string } }>(
    "/api/sessions/:id/prompt",
    { preHandler: ownerOnly },
    async (request: any, reply) => mutate(request, reply, `prompt:${request.params.id}`, 202, async requestId => {
      const text = request.body?.text;
      const mode = request.body?.mode;
      if (typeof text !== "string" || !text.trim()) throw new TypeError("text_required");
      if (mode !== "prompt" && mode !== "steer" && mode !== "follow_up") throw new TypeError("invalid_prompt_mode");
      try {
        await runtime.prompt(request.params.id, text, mode as OwnerSessionPromptMode);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw error;
      }
      await ensureForwarding(request.params.id, request.userId);
      return { accepted: true, requestId };
    }).catch((error: unknown) => {
      if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
      throw error;
    }),
  );

  app.put<{ Params: { id: string }; Body: { requestId?: string; provider?: string; model?: string } }>(
    "/api/sessions/:id/model",
    { preHandler: ownerOnly },
    async (request: any, reply) =>
      mutate(request, reply, `model:${request.params.id}`, 200, async requestId => {
        const provider = request.body?.provider;
        const model = request.body?.model;
        if (typeof provider !== "string" || !provider.trim()) throw new TypeError("provider_required");
        if (typeof model !== "string" || !model.trim()) throw new TypeError("model_required");
        const session = await runtime.setModel(request.params.id, {
          provider: provider.trim(),
          id: model.trim(),
        });
        await ensureForwarding(request.params.id, request.userId);
        return { requestId, session };
      }).catch((error: unknown) => {
        if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
        throw error;
      }),
  );

  app.post<{ Params: { id: string }; Body: { requestId?: string } }>(
    "/api/sessions/:id/abort",
    { preHandler: ownerOnly },
    async (request: any, reply) => mutate(request, reply, `abort:${request.params.id}`, 200, async requestId => {
      await runtime.abort(request.params.id);
      return { aborted: true, requestId };
    }),
  );

  app.post<{ Params: { id: string }; Body: { requestId?: string; entryId?: string } }>(
    "/api/sessions/:id/branch",
    { preHandler: ownerOnly },
    async (request: any, reply) => mutate(request, reply, `branch:${request.params.id}`, 200, async requestId => {
      const entryId = request.body?.entryId;
      if (typeof entryId !== "string" || !entryId) throw new TypeError("entryId_required");
      const session = await runtime.branch(request.params.id, entryId);
      await ensureForwarding(session.id, request.userId);
      return { requestId, session };
    }).catch((error: unknown) => {
      if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
      throw error;
    }),
  );

  app.post<{ Params: { id: string }; Body: { requestId?: string; entryId?: string } }>(
    "/api/sessions/:id/fork",
    { preHandler: ownerOnly },
    async (request: any, reply) => mutate(request, reply, `fork:${request.params.id}`, 201, async requestId => {
      const entryId = request.body?.entryId;
      if (typeof entryId !== "string" || !entryId) throw new TypeError("entryId_required");
      const session = await runtime.fork(request.params.id, entryId);
      await ensureForwarding(session.id, request.userId);
      return { requestId, session };
    }).catch((error: unknown) => {
      if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
      throw error;
    }),
  );

  app.addHook("onClose", async () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  });
}
