import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { OwnerSessionModelError } from "../runtime/ownerSessionRuntime.js";
import { registerOwnerSessionRoutes } from "./owner-sessions.js";

const snapshot = {
  id: "sess-1",
  cwd: "/tmp",
  relation: "root",
  model: { provider: "anthropic", id: "claude-haiku-4-5" },
  leafId: null,
  isStreaming: false,
  isIdle: true,
  entries: [],
  tree: [],
};

function appWith(setModel: (id: string, ref: { provider: string; id: string }) => Promise<unknown>) {
  const app = Fastify();
  registerOwnerSessionRoutes(app, {
    runtime: {
      setModel,
      subscribe: async () => () => {},
    } as any,
    events: { push: () => ({ cursor: "1" }), eventsAfter: () => ({ events: [], resetRequired: false }) } as any,
    broadcast: () => {},
    authorize: async (request: any) => {
      request.userId = "u1";
    },
    isOwner: () => true,
  });
  return app;
}

describe("PUT /api/sessions/:id/model", () => {
  it("переключает модель сессии и отдаёт её в снапшоте", async () => {
    const setModel = vi.fn(async () => snapshot);
    const app = appWith(setModel);

    const response = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-1/model",
      payload: { requestId: "req-1", provider: "anthropic", model: "claude-haiku-4-5" },
    });

    expect(response.statusCode).toBe(200);
    expect(setModel).toHaveBeenCalledWith("sess-1", { provider: "anthropic", id: "claude-haiku-4-5" });
    expect(JSON.parse(response.body).session.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
  });

  it("без model отвечает 400", async () => {
    const app = appWith(vi.fn(async () => snapshot));
    const response = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-1/model",
      payload: { requestId: "req-2", provider: "anthropic" },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("model_required");
  });

  it("недоступную модель отдаёт как 400 model_unavailable", async () => {
    const app = appWith(async () => {
      throw new OwnerSessionModelError("Model anthropic/nope is unavailable");
    });
    const response = await app.inject({
      method: "PUT",
      url: "/api/sessions/sess-1/model",
      payload: { requestId: "req-3", provider: "anthropic", model: "nope" },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("model_unavailable");
  });
});
