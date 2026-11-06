import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  OwnerSessionRuntime,
  OwnerSessionStreamingConflictError,
  type OwnerAgentSession,
} from "../src/runtime/ownerSessionRuntime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Call = { name: string; text?: string };

class FakeSession implements OwnerAgentSession {
  readonly calls: Call[] = [];
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  subscriptionCount = 0;
  unsubscriptionCount = 0;
  isStreaming = false;
  isIdle = true;

  constructor(readonly sessionManager: SessionManager) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.subscriptionCount += 1;
    this.listeners.add(listener);
    return () => {
      this.unsubscriptionCount += 1;
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.calls.push({ name: "prompt", text });
    this.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any);
  }

  async steer(text: string): Promise<"queued"> {
    this.calls.push({ name: "steer", text });
    return "queued";
  }

  async followUp(text: string): Promise<"queued"> {
    this.calls.push({ name: "followUp", text });
    return "queued";
  }

  async abort(): Promise<void> {
    this.calls.push({ name: "abort" });
    this.isStreaming = false;
    this.isIdle = true;
  }

  async waitForIdle(): Promise<void> {
    this.calls.push({ name: "waitForIdle" });
  }

  async navigateTree(entryId: string): Promise<{ cancelled: boolean }> {
    this.calls.push({ name: "navigateTree", text: entryId });
    this.sessionManager.branch(entryId);
    return { cancelled: false };
  }

  dispose(): void {
    this.calls.push({ name: "dispose" });
  }
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-session-runtime-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(cwd, { recursive: true });
  const sessions: FakeSession[] = [];
  const createSession = async (manager: SessionManager) => {
    const session = new FakeSession(manager);
    sessions.push(session);
    return session;
  };
  return { cwd, sessionDir, sessions, createSession };
}

describe("OwnerSessionRuntime", () => {
  it("reuses the persisted root session", async () => {
    const h = harness();
    const firstRuntime = new OwnerSessionRuntime(h);
    const first = await firstRuntime.openRoot();
    await firstRuntime.prompt(first.id, "persist me", "prompt");

    const secondRuntime = new OwnerSessionRuntime(h);
    const reopened = await secondRuntime.openRoot();

    expect(reopened.id).toBe(first.id);
    expect(reopened.entries).toHaveLength(1);
  });

  it("requires an explicit queue mode while streaming", async () => {
    const h = harness();
    const runtime = new OwnerSessionRuntime(h);
    const root = await runtime.openRoot();
    h.sessions.at(-1)!.isStreaming = true;
    h.sessions.at(-1)!.isIdle = false;

    await expect(runtime.prompt(root.id, "ambiguous", "prompt"))
      .rejects.toBeInstanceOf(OwnerSessionStreamingConflictError);
    await runtime.prompt(root.id, "change course", "steer");
    await runtime.prompt(root.id, "do this next", "follow_up");

    expect(h.sessions.at(-1)!.calls).toEqual([
      { name: "steer", text: "change course" },
      { name: "followUp", text: "do this next" },
    ]);
  });

  it("aborts and then waits for actual idle", async () => {
    const h = harness();
    const runtime = new OwnerSessionRuntime(h);
    const root = await runtime.openRoot();

    await runtime.abort(root.id);

    expect(h.sessions.at(-1)!.calls).toEqual([
      { name: "abort" },
      { name: "waitForIdle" },
    ]);
  });

  it("branches in the same session without deleting the abandoned path", async () => {
    const h = harness();
    const runtime = new OwnerSessionRuntime(h);
    const root = await runtime.openRoot();
    await runtime.prompt(root.id, "root", "prompt");
    const firstEntry = (await runtime.snapshot(root.id)).entries[0].id;
    h.sessions.at(-1)!.sessionManager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "old path" }], timestamp: Date.now(),
    } as any);

    await runtime.branch(root.id, firstEntry);
    await runtime.prompt(root.id, "new path", "prompt");
    const snapshot = await runtime.snapshot(root.id);

    expect(snapshot.id).toBe(root.id);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.map(entry => (entry as any).message?.content)).toEqual([
      "root",
      "new path",
    ]);
    expect(snapshot.tree[0].children).toHaveLength(2);
  });

  it("forks a selected path into an independent child session", async () => {
    const h = harness();
    const runtime = new OwnerSessionRuntime(h);
    const root = await runtime.openRoot();
    await runtime.prompt(root.id, "root", "prompt");
    const parentBefore = await runtime.snapshot(root.id);

    const forked = await runtime.fork(root.id, parentBefore.leafId!);
    const parentAfter = await runtime.snapshot(root.id);

    expect(forked.id).not.toBe(root.id);
    expect(forked.parentSession).toBe(parentBefore.sessionFile);
    expect(forked.entries.map(entry => entry.id)).toEqual(parentBefore.entries.map(entry => entry.id));
    expect(parentAfter.entries).toEqual(parentBefore.entries);
  });

  it("moves external listeners exactly once when branch replaces the SDK session", async () => {
    const h = harness();
    const runtime = new OwnerSessionRuntime(h);
    const root = await runtime.openRoot();
    await runtime.prompt(root.id, "root", "prompt");
    const entryId = (await runtime.snapshot(root.id)).leafId!;
    const received: AgentSessionEvent[] = [];
    const unsubscribe = await runtime.subscribe(root.id, event => received.push(event));
    const oldSession = h.sessions.at(-1)!;

    await runtime.branch(root.id, entryId);
    const replacement = h.sessions.at(-1)!;

    expect(oldSession.unsubscriptionCount).toBe(1);
    expect(replacement.subscriptionCount).toBe(1);
    expect(replacement.listeners.size).toBe(1);
    unsubscribe();
    expect(replacement.listeners.size).toBe(0);
  });
});
