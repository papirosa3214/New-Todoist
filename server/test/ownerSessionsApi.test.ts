import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerOwnerSessionRoutes } from "../src/routes/owner-sessions.js";
import { OwnerSessionEventBuffer } from "../src/runtime/ownerSessionEvents.js";
import { chatBlocksCached } from "../src/lib/chatBlocks.js";
import {
  OwnerSessionNotFoundError,
  OwnerSessionStreamingConflictError,
  type OwnerSessionSnapshot,
} from "../src/runtime/ownerSessionRuntime.js";

const rootSnapshot: OwnerSessionSnapshot = {
  id: "root-session",
  cwd: "/workspace",
  sessionFile: "/sessions/root.jsonl",
  relation: "root",
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
  createdRoots = 0;
  async createRoot() {
    this.createdRoots += 1;
    return { ...rootSnapshot, id: `new-root-${this.createdRoots}`, entries: [] };
  }
  async open(id: string) { return this.snapshot(id); }
  async list() {
    return [{ id: rootSnapshot.id, cwd: rootSnapshot.cwd, name: "Owner assistant", parentSessionPath: undefined, relation: "root" }];
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
    return { ...rootSnapshot, id: "fork-session", parentSession: rootSnapshot.sessionFile, relation: "fork" };
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

class InMemoryMeta {
  rows = new Map<string, any>();
  read(ids: string[]) {
    return new Map(ids.filter(id => this.rows.has(id)).map(id => [id, this.rows.get(id)]));
  }
  patch(id: string, fields: any) {
    const { archived, ...rest } = fields;
    const row = { title: null, projectId: null, pinned: false, archivedAt: null, ...this.rows.get(id), ...rest };
    if (archived !== undefined) row.archivedAt = archived ? "2026-11-12T00:00:00.000Z" : null;
    this.rows.set(id, row);
    return row;
  }
}

describe("owner session API", () => {
  let app: FastifyInstance;
  let runtime: FakeRuntime;
  let events: OwnerSessionEventBuffer;
  let broadcast: ReturnType<typeof vi.fn>;
  let meta: InMemoryMeta;

  beforeEach(async () => {
    app = Fastify();
    runtime = new FakeRuntime();
    meta = new InMemoryMeta();
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
      isSessionAgent: (userId: string) => userId === "orchestrator-claude",
      meta,
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

  it("пускает к сессиям учётку Оркестратор Claude, но не другие роли (владелец 13.11.2026)", async () => {
    const agent = await app.inject({ method: "GET", url: "/api/sessions", headers: { "x-user-id": "orchestrator-claude" } });
    const role = await app.inject({ method: "GET", url: "/api/sessions", headers: { "x-user-id": "role_builder" } });
    expect(agent.statusCode).toBe(200);
    expect(role.statusCode).toBe(403);
  });

  it("opens the reusable root, lists sessions, and returns a snapshot", async () => {
    const opened = await app.inject({ method: "POST", url: "/api/sessions/root", headers: ownerHeaders });
    const listed = await app.inject({ method: "GET", url: "/api/sessions", headers: ownerHeaders });
    const snapshot = await app.inject({ method: "GET", url: "/api/sessions/root-session", headers: ownerHeaders });

    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ session: rootSnapshot });
    expect(listed.json().sessions).toHaveLength(1);
    expect(listed.json().sessions[0]).toMatchObject({ id: "root-session", cwd: "/workspace", name: "Owner assistant", relation: "root" });
    expect(snapshot.json()).toEqual({ session: rootSnapshot });
    expect(runtime.listeners.get("root-session")?.size).toBe(1);
  });

  it("creates a new root session once per request ID and forwards its events", async () => {
    const request = { method: "POST" as const, url: "/api/sessions", headers: ownerHeaders, payload: { requestId: "new-1" } };
    const created = await app.inject(request);
    const repeated = await app.inject(request);

    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({ id: "new-root-1", relation: "root" });
    expect(repeated.json().session.id).toBe("new-root-1");
    expect(runtime.createdRoots).toBe(1);
    expect(runtime.listeners.get("new-root-1")?.size).toBe(1);
  });

  // Владелец 12.11.2026: «сессия, сессия, сессия на всех экранах» — строке
  // нужны название, превью, время, проект и закрепление.
  it("lists sessions with preview, time and owner labels, hiding archived ones", async () => {
    runtime.list = async () => [
      { id: "a", cwd: "/w", name: undefined, relation: "root", firstMessage: "Привет", modified: new Date("2026-11-12T09:00:00Z"), messageCount: 4 },
      { id: "b", cwd: "/w", name: "Pi name", relation: "root", firstMessage: "Второй", modified: new Date("2026-11-12T10:00:00Z"), messageCount: 2 },
      { id: "c", cwd: "/w", relation: "root", firstMessage: "Старое", modified: new Date("2026-11-11T10:00:00Z"), messageCount: 1 },
    ] as any;
    await app.inject({ method: "PATCH", url: "/api/sessions/a", headers: ownerHeaders,
      payload: { title: "Сборка iOS", project_id: "p1", pinned: true } });
    await app.inject({ method: "PATCH", url: "/api/sessions/c", headers: ownerHeaders, payload: { archived: true } });

    const listed = (await app.inject({ method: "GET", url: "/api/sessions", headers: ownerHeaders })).json().sessions;
    const archived = (await app.inject({ method: "GET", url: "/api/sessions?archived=1", headers: ownerHeaders })).json().sessions;

    expect(listed.map((s: any) => s.id)).toEqual(["b", "a"]);
    expect(listed[1]).toMatchObject({ title: "Сборка iOS", projectId: "p1", pinned: true,
      firstMessage: "Привет", modified: "2026-11-12T09:00:00.000Z", messageCount: 4 });
    expect(listed[0]).toMatchObject({ title: "Pi name", pinned: false, projectId: null });
    expect(archived.map((s: any) => s.id)).toEqual(["c"]);
  });

  it("rejects an unknown label field", async () => {
    const response = await app.inject({ method: "PATCH", url: "/api/sessions/a", headers: ownerHeaders, payload: { colour: "red" } });
    expect(response.statusCode).toBe(400);
  });

  // Владелец 12.11.2026: ответы в сессии — той же разметкой, что в чате.
  it("adds chat text blocks to assistant answers in the snapshot", async () => {
    runtime.snapshot = async (id: string) => ({ ...rootSnapshot, id, entries: [
      { type: "message", id: "u1", message: { role: "user", content: "Вопрос" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "## Итог\n\n- пункт" }] } },
      { type: "custom_message", id: "v1", customType: "taskflow.voice", details: { role: "assistant", text: "- голосом" } },
    ] as any });
    runtime.open = async (id: string) => runtime.snapshot(id);

    const entries = (await app.inject({ method: "GET", url: "/api/sessions/s1", headers: ownerHeaders })).json().session.entries;

    expect(entries[0].text_blocks).toBeUndefined();
    expect(entries[1].text_blocks).toEqual(chatBlocksCached("## Итог\n\n- пункт"));
    expect(entries[2].text_blocks).toEqual(chatBlocksCached("- голосом"));
    expect(entries[1].text_blocks.length).toBeGreaterThan(0);
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
