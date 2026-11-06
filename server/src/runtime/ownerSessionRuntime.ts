import fs from "node:fs";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type SessionEntry,
  type SessionInfo,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

export type OwnerSessionPromptMode = "prompt" | "steer" | "follow_up";

export interface OwnerAgentSession {
  readonly sessionManager: SessionManager;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<unknown>;
  followUp(text: string): Promise<unknown>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  navigateTree(entryId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
  subscribe(listener: AgentSessionEventListener): () => void;
  dispose(): void;
}

export interface OwnerSessionSnapshot {
  id: string;
  cwd: string;
  sessionFile?: string;
  parentSession?: string;
  name?: string;
  leafId: string | null;
  isStreaming: boolean;
  isIdle: boolean;
  entries: SessionEntry[];
  tree: SessionTreeNode[];
}

export interface OwnerSessionRuntimeOptions {
  cwd: string;
  sessionDir: string;
  createSession?: (manager: SessionManager) => Promise<OwnerAgentSession>;
}

export class OwnerSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Owner session ${sessionId} not found`);
    this.name = "OwnerSessionNotFoundError";
  }
}

export class OwnerSessionStreamingConflictError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is streaming; choose steer or follow_up`);
    this.name = "OwnerSessionStreamingConflictError";
  }
}

export class OwnerSessionBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerSessionBranchError";
  }
}

type SessionHandle = {
  manager: SessionManager;
  session: OwnerAgentSession;
  listeners: Set<AgentSessionEventListener>;
  unsubscribeSdk?: () => void;
};

async function createDefaultSession(manager: SessionManager): Promise<OwnerAgentSession> {
  const cwd = manager.getCwd();
  const { session } = await createAgentSession({
    cwd,
    sessionManager: manager,
    settingsManager: SettingsManager.create(cwd),
  });
  return session;
}

/**
 * Thin server-side ownership layer over Pi sessions.
 *
 * Pi's SessionManager remains the only transcript/tree store. This class owns
 * live AgentSession objects and translates lifecycle operations without copying
 * their model context into TaskFlow tables.
 */
export class OwnerSessionRuntime {
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly createSession: (manager: SessionManager) => Promise<OwnerAgentSession>;
  private readonly handles = new Map<string, SessionHandle>();
  private rootSessionId?: string;

  constructor(options: OwnerSessionRuntimeOptions) {
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.createSession = options.createSession ?? createDefaultSession;
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  async openRoot(): Promise<OwnerSessionSnapshot> {
    if (this.rootSessionId) return this.snapshot(this.rootSessionId);
    const sessions = await SessionManager.list(this.cwd, this.sessionDir);
    const root = sessions.find(session => !session.parentSessionPath);
    const manager = root
      ? SessionManager.open(root.path, this.sessionDir, this.cwd)
      : SessionManager.create(this.cwd, this.sessionDir);
    const handle = await this.install(manager);
    this.rootSessionId = handle.manager.getSessionId();
    return this.snapshot(this.rootSessionId);
  }

  async list(): Promise<SessionInfo[]> {
    return SessionManager.list(this.cwd, this.sessionDir);
  }

  async open(id: string): Promise<OwnerSessionSnapshot> {
    await this.ensureHandle(id);
    return this.snapshot(id);
  }

  async prompt(id: string, text: string, mode: OwnerSessionPromptMode): Promise<void> {
    const handle = await this.ensureHandle(id);
    if (mode === "prompt") {
      if (handle.session.isStreaming) throw new OwnerSessionStreamingConflictError(id);
      await handle.session.prompt(text);
      return;
    }
    if (mode === "steer") {
      await handle.session.steer(text);
      return;
    }
    await handle.session.followUp(text);
  }

  async abort(id: string): Promise<void> {
    const handle = await this.ensureHandle(id);
    await handle.session.abort();
    await handle.session.waitForIdle();
  }

  async branch(id: string, entryId: string): Promise<OwnerSessionSnapshot> {
    const handle = await this.ensureHandle(id);
    if (!handle.manager.getEntry(entryId)) {
      throw new OwnerSessionBranchError(`Entry ${entryId} does not belong to session ${id}`);
    }
    if (!handle.session.isIdle) {
      throw new OwnerSessionBranchError(`Session ${id} must be idle before branching`);
    }
    const result = await handle.session.navigateTree(entryId, { summarize: false });
    if (result.cancelled) throw new OwnerSessionBranchError(`Branch navigation cancelled for ${id}`);

    const sessionFile = handle.manager.getSessionFile();
    if (sessionFile) {
      const manager = SessionManager.open(sessionFile, this.sessionDir, this.cwd);
      manager.branch(entryId);
      await this.replace(handle, manager);
    }
    return this.snapshot(id);
  }

  async fork(id: string, entryId: string): Promise<OwnerSessionSnapshot> {
    const parent = await this.ensureHandle(id);
    if (!parent.session.isIdle) {
      throw new OwnerSessionBranchError(`Session ${id} must be idle before forking`);
    }
    const parentFile = parent.manager.getSessionFile();
    if (!parentFile) throw new OwnerSessionBranchError(`Session ${id} is not persisted yet`);
    if (!parent.manager.getEntry(entryId)) {
      throw new OwnerSessionBranchError(`Entry ${entryId} does not belong to session ${id}`);
    }

    // createBranchedSession mutates its manager, so use a throwaway manager.
    // The live parent handle and its active leaf remain untouched.
    const forkBuilder = SessionManager.open(parentFile, this.sessionDir, this.cwd);
    const forkFile = forkBuilder.createBranchedSession(entryId);
    if (!forkFile) throw new OwnerSessionBranchError(`Pi did not persist fork for ${id}`);
    const forkManager = SessionManager.open(forkFile, this.sessionDir, this.cwd);
    const fork = await this.install(forkManager);
    return this.snapshot(fork.manager.getSessionId());
  }

  async subscribe(id: string, listener: (event: AgentSessionEvent) => void): Promise<() => void> {
    const handle = await this.ensureHandle(id);
    handle.listeners.add(listener);
    this.attachSdkSubscription(handle);
    return () => {
      handle.listeners.delete(listener);
      if (handle.listeners.size === 0) this.detachSdkSubscription(handle);
    };
  }

  async snapshot(id: string): Promise<OwnerSessionSnapshot> {
    const handle = await this.ensureHandle(id);
    const header = handle.manager.getHeader();
    return {
      id: handle.manager.getSessionId(),
      cwd: handle.manager.getCwd(),
      sessionFile: handle.manager.getSessionFile(),
      parentSession: header?.parentSession,
      name: handle.manager.getSessionName(),
      leafId: handle.manager.getLeafId(),
      isStreaming: handle.session.isStreaming,
      isIdle: handle.session.isIdle,
      entries: handle.manager.getEntries(),
      tree: handle.manager.getTree(),
    };
  }

  private async ensureHandle(id: string): Promise<SessionHandle> {
    const current = this.handles.get(id);
    if (current) return current;
    const sessionFile = SessionManager.findById(this.cwd, id, this.sessionDir);
    if (!sessionFile) throw new OwnerSessionNotFoundError(id);
    return this.install(SessionManager.open(sessionFile, this.sessionDir, this.cwd));
  }

  private async install(manager: SessionManager): Promise<SessionHandle> {
    const id = manager.getSessionId();
    const existing = this.handles.get(id);
    if (existing) return existing;
    const session = await this.createSession(manager);
    const handle: SessionHandle = { manager, session, listeners: new Set() };
    this.handles.set(id, handle);
    return handle;
  }

  private async replace(handle: SessionHandle, manager: SessionManager): Promise<void> {
    const hadListeners = handle.listeners.size > 0;
    this.detachSdkSubscription(handle);
    handle.session.dispose();
    handle.manager = manager;
    handle.session = await this.createSession(manager);
    if (hadListeners) this.attachSdkSubscription(handle);
  }

  private attachSdkSubscription(handle: SessionHandle): void {
    if (handle.unsubscribeSdk || handle.listeners.size === 0) return;
    handle.unsubscribeSdk = handle.session.subscribe(event => {
      for (const listener of handle.listeners) listener(event);
    });
  }

  private detachSdkSubscription(handle: SessionHandle): void {
    handle.unsubscribeSdk?.();
    handle.unsubscribeSdk = undefined;
  }
}
