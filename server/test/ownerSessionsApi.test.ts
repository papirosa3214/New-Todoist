import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOwnerSessionRoutes } from "../src/routes/owner-sessions.js";
import { OwnerSessionEventBuffer } from "../src/runtime/ownerSessionEvents.js";
import {
  OwnerSessionNotFoundError,
  OwnerSessionStreamingConflictError,
  type OwnerSessionSnapshot,
} from "../src/runtime/ownerSessionRuntime.js";

const rootSnapshot: OwnerSessionSnapshot = {
  id: "root-session",
  cwd: "/workspace",
  sessionFile: "/sessions/root.jsonl",
  leafId: "entry-1",
  isStreaming: false,
  isIdle: true,
  entries: [],
  tree: [],
};

class FakeRuntime {
  promptCalls: Array<[string, string, string]> = [];
  abortCalls: string[] = [];
  branchCalls: Array<[string, string]> = [];
  forkCalls: Array<[string, string]> = [];
  listeners = new Map<string, Set<(event: any) => void>>();

  async openRoot() { return rootSnapshot; }
  async open(id: string) { return this.snapshot(id); }
  async list() {
    return [{ id: rootSnapshot.id, cwd: rootSnapshot.cwd, name: "Owner assistant", parentSessionPath: undefined }];
  }
  async snapshot(id: string) {
    if (id === "missing") throw new OwnerSessionNotFoundError(id);
    return id === rootSnapshot.id ? rootSnapshot : { ...rootSnapshot, id };
  }
  async prompt(id: string, text: string, mode: string) {
    if (text === "stream-conflict") throw new OwnerSessionStreamingConflictError(id);
    this.promptCalls.push([id, text, mode]);
  }
  async abort(id: string) { this.abortCalls.push(id); }
  async branch(id: string, entryId: string) {
    this.branchCalls.push([id, entryId]);
    return { ...rootSnapshot, id, leafId: entryId };
  }
  async fork(id: string, entryId: string) {
    this.forkCalls.push([id, entryId]);
    return { ...rootSnapshot, id: "fork-session", parentSession: rootSnapshot.sessionFile };
  }
  async subscribe(id: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => listeners.delete(listener);
  }
  emit(id: string, event: any) {
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }
}

describe("owner session API", () => {
  let app: FastifyInstance;
  let runtime: FakeRuntime;
  let events: OwnerSessionEventBuffer;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    app = Fastify();
    runtime = new FakeRuntime();
    events = new OwnerSessionEventBuffer({ capacity: 3, epoch: "test", clock: () => new Date(0) });
    broadcast = vi.fn();
    registerOwnerSessionRoutes(app, {
      runtime: runtime as any,
      events,
      broadcast,
      authorize: async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (!userId) return reply.code(401).send({ error: "Unauthorized" });
        request.userId = userId;
      },
      isOwner: (userId: string) => userId === "owner",
    });
    await app.ready();
  });

  afterEach(async () => app.close());

  const ownerHeaders = { "x-user-id": "owner" };

  it("requires authentication and the owner account", async () => {
    const unauthenticated = await app.inject({ method: "POST", url: "/api/sessions/root" });
    const forbidden = await app.inject({ method: "POST", url: "/api/sessions/root", headers: { "x-user-id": "role_builder" } });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(runtime.listeners.size).toBe(0);
  });

  it("opens the reusable root, lists sessions, and returns a snapshot", async () => {
    const opened = await app.inject({ method: "POST", url: "/api/sessions/root", headers: ownerHeaders });
    const listed = await app.inject({ method: "GET", url: "/api/sessions", headers: ownerHeaders });
    const snapshot = await app.inject({ method: "GET", url: "/api/sessions/root-session", headers: ownerHeaders });

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ session: rootSnapshot });
    expect(listed.json()).toEqual({ sessions: [{ id: "root-session", cwd: "/workspace", name: "Owner assistant" }] });
    expect(snapshot.json()).toEqual({ session: rootSnapshot });
    expect(runtime.listeners.get("root-session")?.size).toBe(1);
  });

  it.each(["prompt", "steer", "follow_up"])("dispatches explicit %s mode", async mode => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/root-session/prompt",
      headers: ownerHeaders,
      payload: { requestId: `request-${mode}`, text: "hello", mode },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, requestId: `request-${mode}` });
    expect(runtime.promptCalls).toEqual([["root-session", "hello", mode]]);
  });

  it("deduplicates a repeated mutation request ID", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/sessions/root-session/prompt",
      headers: ownerHeaders,
      payload: { requestId: "same-request", text: "once", mode: "prompt" },
    };

    const first = await app.inject(request);
    const repeated = await app.inject(request);

    expect(first.statusCode).toBe(202);
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toEqual(first.json());
    expect(runtime.promptCalls).toHaveLength(1);
  });

  it("aborts, branches, and forks through the runtime", async () => {
    const abort = await app.inject({
      method: "POST", url: "/api/sessions/root-session/abort", headers: ownerHeaders,
      payload: { requestId: "abort-1" },
    });
    const branch = await app.inject({
      method: "POST", url: "/api/sessions/root-session/branch", headers: ownerHeaders,
      payload: { requestId: "branch-1", entryId: "entry-old" },
    });
    const fork = await app.inject({
      method: "POST", url: "/api/sessions/root-session/fork", headers: ownerHeaders,
      payload: { requestId: "fork-1", entryId: "entry-old" },
    });

    expect(abort.statusCode).toBe(200);
    expect(runtime.abortCalls).toEqual(["root-session"]);
    expect(branch.json()).toMatchObject({ session: { id: "root-session", leafId: "entry-old" } });
    expect(fork.json()).toMatchObject({ session: { id: "fork-session", parentSession: "/sessions/root.jsonl" } });
    expect(runtime.branchCalls).toEqual([["root-session", "entry-old"]]);
    expect(runtime.forkCalls).toEqual([["root-session", "entry-old"]]);
  });

  it("maps an unknown session to 404 and streaming ambiguity to 409", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/sessions/missing", headers: ownerHeaders });
    const conflict = await app.inject({
      method: "POST", url: "/api/sessions/root-session/prompt", headers: ownerHeaders,
      payload: { requestId: "conflict-1", text: "stream-conflict", mode: "prompt" },
    });

    expect(missing.statusCode).toBe(404);
    expect(conflict.statusCode).toBe(409);
  });

  it("broadcasts normalized events through the existing owner socket", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/root", headers: ownerHeaders });
    runtime.emit("root-session", { type: "agent_settled", aborted: false });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("owner", {
      type: "session:event",
      event: expect.objectContaining({ sessionId: "root-session", type: "agent_settled", cursor: "test:1" }),
    });
  });

  it("returns retained events or a snapshot reset after a missing cursor", async () => {
    events.push("root-session", { type: "agent_start" } as any);
    events.push("root-session", { type: "agent_settled", aborted: false } as any);

    const known = await app.inject({
      method: "GET", url: "/api/sessions/root-session/events?after=test%3A1", headers: ownerHeaders,
    });
    const missing = await app.inject({
      method: "GET", url: "/api/sessions/root-session/events?after=old%3A9", headers: ownerHeaders,
    });

    expect(known.json()).toMatchObject({ resetRequired: false, events: [{ cursor: "test:2" }] });
    expect(missing.json()).toMatchObject({
      resetRequired: true,
      snapshot: rootSnapshot,
      events: [{ cursor: "test:1" }, { cursor: "test:2" }],
    });
  });
});
