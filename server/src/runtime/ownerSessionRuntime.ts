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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createSpawnChildSessionTool,
  type ChildSessionSpawnRequest,
  type SpawnedChildSession,
} from "./spawnChildSessionTool.js";
import { getModelRuntime } from "./PiRuntimeAdapter.js";
import type { OwnerSessionProfile } from "./ownerAssistantProfile.js";
import { ROLE_NAMES, roleTitle } from "../roleRouting.js";

export type OwnerSessionPromptMode = "prompt" | "steer" | "follow_up";
export type OwnerSessionRelation = "root" | "fork" | "subagent";
export type OwnerSessionListItem = SessionInfo & { relation: OwnerSessionRelation };

const SESSION_RELATION_ENTRY = "taskflow.session-relation";
const VOICE_ENTRY = "taskflow.voice";
export const OWNER_ROOT_DEFAULT_MODEL = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
} as const;

export interface OwnerAgentSession {
  readonly sessionManager: SessionManager;
  readonly isStreaming: boolean;
  /// Текущая модель сессии (объект каталога Pi).
  readonly model?: any;
  /// Смена модели: Pi проверяет авторизацию и пишет model_change.
  setModel?(model: any): Promise<void>;
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
  model: { provider: string; id: string } | null;
  relation: OwnerSessionRelation;
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
  createSession?: (manager: SessionManager, options?: OwnerSessionCreateOptions) => Promise<OwnerAgentSession>;
  /** Профиль Помощника для сессий разговора (корень, новая, ответвление). */
  assistantProfile?: (sessionId: string, role?: string) => Promise<OwnerSessionProfile>;
}

export interface OwnerSessionCreateOptions {
  tools?: readonly string[];
  customTools?: ToolDefinition[];
  modelRef?: { provider: string; id: string };
  /** Сессия разговора владельца — с профилем Помощника; субагент — без. */
  assistant?: boolean;
  /** Субагент-роль (владелец 13.11.2026: «субагенты — это и есть роли»):
   *  сессия с профилем этой роли — её инструкция, навыки и инструменты. */
  role?: string;
  profile?: OwnerSessionProfile;
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

export class OwnerSessionModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerSessionModelError";
  }
}

type SessionHandle = {
  manager: SessionManager;
  session: OwnerAgentSession;
  listeners: Set<AgentSessionEventListener>;
  unsubscribeSdk?: () => void;
};

async function createDefaultSession(
  manager: SessionManager,
  options: OwnerSessionCreateOptions = {},
): Promise<OwnerAgentSession> {
  const cwd = manager.getCwd();
  const modelRuntime = options.modelRef ? await getModelRuntime() : undefined;
  const model = options.modelRef
    ? modelRuntime?.getModel(options.modelRef.provider, options.modelRef.id)
    : undefined;
  if (options.modelRef && !model) {
    throw new Error(`Owner session model ${options.modelRef.provider}/${options.modelRef.id} is unavailable`);
  }
  const profile = options.profile;
  const customTools = [...(profile?.customTools ?? []), ...(options.customTools ?? [])];
  const { session } = await createAgentSession({
    cwd,
    sessionManager: manager,
    settingsManager: SettingsManager.create(cwd),
    modelRuntime,
    model,
    ...(profile ? { resourceLoader: profile.resourceLoader as any } : {}),
    tools: options.tools
      ? [...options.tools]
      : profile
        ? [...profile.toolNames, ...(options.customTools ?? []).map(tool => tool.name)]
        : undefined,
    customTools: customTools.length ? customTools : undefined,
  });
  if (profile) {
    profile.install(session);
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
      dispose();
      void profile.dispose();
    };
  }
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
  private readonly createSession: (
    manager: SessionManager,
    options?: OwnerSessionCreateOptions,
  ) => Promise<OwnerAgentSession>;
  private readonly handles = new Map<string, SessionHandle>();
  private readonly globalListeners = new Set<(sessionId: string, event: AgentSessionEvent) => void>();
  private rootSessionId?: string;

  constructor(options: OwnerSessionRuntimeOptions) {
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.createSession = options.createSession ?? (async (manager, createOptions = {}) => createDefaultSession(manager, {
      ...createOptions,
      customTools: createOptions.customTools ?? [this.childToolFor(manager)],
      profile: (createOptions.assistant || createOptions.role) && options.assistantProfile
        ? await options.assistantProfile(manager.getSessionId(), createOptions.role)
        : undefined,
    }));
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

  /** Замер контекста живой сессии — в форме замера чата, чтобы приложение
   *  показало то же кольцо (владелец 12.11.2026: «где у нас контекст»). */
  async contextUsage(id: string) {
    const handle = await this.ensureHandle(id);
    let usage: any;
    try { usage = (handle.session as any).getContextUsage?.(); } catch { usage = undefined; }
    const model = this.modelRef(handle.session);
    const measured = usage && typeof usage.tokens === "number" && typeof usage.contextWindow === "number";
    return {
      roleID: "session",
      sessionID: id,
      model: model?.id ?? null,
      provider: model?.provider ?? null,
      tokens: measured ? usage.tokens : null,
      contextWindow: measured ? usage.contextWindow : null,
      measuredAt: new Date().toISOString(),
      status: measured ? "measured" : "no_session",
      isEstimate: false,
      breakdown: null,
    };
  }

  /** Есть ли сессия владельца с таким id (голосовой мост различает чат и сессию). */
  hasSession(id: string): boolean {
    if (this.handles.has(id)) return true;
    try { return Boolean(SessionManager.findById(this.cwd, id, this.sessionDir)); } catch { return false; }
  }

  /** Реплика голосового разговора в сессии (владелец 12.11.2026): запись
   *  `taskflow.voice` в файле сессии — модель видит её на следующем ходу.
   *  Повтор того же события голоса не дублирует запись. */
  appendVoice(id: string, eventId: string, role: "user" | "assistant", text: string): string {
    const manager = this.voiceManager(id);
    const existing = manager.getEntries().find(entry =>
      entry.type === "custom_message" && (entry as any).customType === VOICE_ENTRY
      && (entry as any).details?.eventId === eventId);
    if (existing) return existing.id;
    const label = role === "user" ? "Владелец голосом" : "Помощник голосом";
    return manager.appendCustomMessageEntry(VOICE_ENTRY, `${label}: ${text}`, true, { role, eventId, text });
  }

  /** Последние реплики сессии для голоса: текст и голос вперемешку, по порядку. */
  voiceContext(id: string, limit = 40): Array<{ id: string; role: "user" | "assistant"; text: string }> {
    const out: Array<{ id: string; role: "user" | "assistant"; text: string }> = [];
    for (const entry of this.voiceManager(id).getBranch() as any[]) {
      if (entry.type === "custom_message" && entry.customType === VOICE_ENTRY && entry.details?.text) {
        out.push({ id: entry.id, role: entry.details.role === "assistant" ? "assistant" : "user", text: String(entry.details.text) });
        continue;
      }
      if (entry.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry.message.content;
      const text = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "";
      if (text.trim()) out.push({ id: entry.id, role, text: text.slice(0, 12000) });
    }
    return out.slice(-limit);
  }

  private voiceManager(id: string): SessionManager {
    const handle = this.handles.get(id);
    if (handle) return handle.manager;
    const file = SessionManager.findById(this.cwd, id, this.sessionDir);
    if (!file) throw new OwnerSessionNotFoundError(id);
    return SessionManager.open(file, this.sessionDir, this.cwd);
  }

  /** Новая сессия разговора рядом с прежними (владелец 12.11.2026: сессий сколько угодно). */
  async createRoot(): Promise<OwnerSessionSnapshot> {
    const handle = await this.install(SessionManager.create(this.cwd, this.sessionDir));
    return this.snapshot(handle.manager.getSessionId());
  }

  async list(): Promise<OwnerSessionListItem[]> {
    const sessions = await SessionManager.list(this.cwd, this.sessionDir);
    return sessions.map(session => ({
      ...session,
      relation: this.relation(SessionManager.open(session.path, this.sessionDir, this.cwd)),
    }));
  }

  async open(id: string): Promise<OwnerSessionSnapshot> {
    await this.ensureHandle(id);
    return this.snapshot(id);
  }

  async prompt(id: string, text: string, mode: OwnerSessionPromptMode): Promise<void> {
    const handle = await this.ensureHandle(id);
    if (mode === "prompt") {
      if (handle.session.isStreaming) throw new OwnerSessionStreamingConflictError(id);
      // Подтверждаем приём, а не конец ответа: ответ с инструментами идёт
      // минутами, а клиент видит его событиями. Сбой хода приходит событием
      // сессии; здесь только запись в журнал.
      void handle.session.prompt(text).catch(error => {
        console.warn(`[owner-sessions] ход сессии ${id} оборвался:`, error);
      });
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
    forkManager.appendCustomEntry(SESSION_RELATION_ENTRY, { kind: "fork" });
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
      model: this.modelRef(handle.session),
      relation: this.relation(handle.manager),
      name: handle.manager.getSessionName(),
      leafId: handle.manager.getLeafId(),
      isStreaming: handle.session.isStreaming,
      isIdle: handle.session.isIdle,
      entries: handle.manager.getBranch().filter(entry => !this.isRelationEntry(entry)),
      tree: handle.manager.getTree(),
    };
  }

  subscribeAll(listener: (sessionId: string, event: AgentSessionEvent) => void): () => void {
    this.globalListeners.add(listener);
    for (const handle of this.handles.values()) this.attachSdkSubscription(handle);
    return () => {
      this.globalListeners.delete(listener);
      for (const handle of this.handles.values()) {
        if (handle.listeners.size === 0) this.detachSdkSubscription(handle);
      }
    };
  }

  /**
   * Переключение модели живой сессии.
   *
   * Модель принадлежит сессии, а не клиенту: Pi сам проверяет авторизацию
   * провайдера и пишет model_change в транскрипт, поэтому выбор переживает
   * перезапуск сервера и виден в истории.
   */
  async setModel(id: string, modelRef: { provider: string; id: string }): Promise<OwnerSessionSnapshot> {
    const handle = await this.ensureHandle(id);
    if (handle.session.isStreaming) throw new OwnerSessionStreamingConflictError(id);
    if (!handle.session.setModel) throw new OwnerSessionModelError(`Session ${id} does not support model switching`);
    const modelRuntime = await getModelRuntime();
    const model = modelRuntime?.getModel(modelRef.provider, modelRef.id);
    if (!model) throw new OwnerSessionModelError(`Model ${modelRef.provider}/${modelRef.id} is unavailable`);
    try {
      await handle.session.setModel(model);
    } catch (error) {
      throw new OwnerSessionModelError(error instanceof Error ? error.message : String(error));
    }
    return this.snapshot(id);
  }

  private modelRef(session: OwnerAgentSession): { provider: string; id: string } | null {
    const model = session.model as { provider?: unknown; id?: unknown } | undefined;
    if (typeof model?.provider !== "string" || typeof model?.id !== "string") return null;
    return { provider: model.provider, id: model.id };
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
    const session = await this.createSession(manager, this.defaultCreateOptions(manager));
    const handle: SessionHandle = { manager, session, listeners: new Set() };
    this.handles.set(id, handle);
    this.attachSdkSubscription(handle);
    return handle;
  }

  private async replace(handle: SessionHandle, manager: SessionManager): Promise<void> {
    const hadListeners = handle.listeners.size > 0 || this.globalListeners.size > 0;
    this.detachSdkSubscription(handle);
    handle.session.dispose();
    handle.manager = manager;
    handle.session = await this.createSession(manager, this.defaultCreateOptions(manager));
    if (hadListeners) this.attachSdkSubscription(handle);
  }

  private attachSdkSubscription(handle: SessionHandle): void {
    if (handle.unsubscribeSdk || (handle.listeners.size === 0 && this.globalListeners.size === 0)) return;
    handle.unsubscribeSdk = handle.session.subscribe(event => {
      for (const listener of handle.listeners) listener(event);
      const id = handle.manager.getSessionId();
      for (const listener of this.globalListeners) listener(id, event);
    });
  }

  private detachSdkSubscription(handle: SessionHandle): void {
    handle.unsubscribeSdk?.();
    handle.unsubscribeSdk = undefined;
  }

  private childToolFor(parentManager: SessionManager): ToolDefinition {
    return createSpawnChildSessionTool({
      parentSessionId: parentManager.getSessionId(),
      get parentSessionFile() { return parentManager.getSessionFile() ?? ""; },
      // Субагенты — роли команды (владелец 13.11.2026), кроме самого Помощника.
      roles: Object.fromEntries(ROLE_NAMES.filter(key => key !== "secretary").map(key => [key, roleTitle(key) || key])),
      spawn: request => this.spawnChild(request),
    });
  }

  private async spawnChild(request: ChildSessionSpawnRequest): Promise<SpawnedChildSession> {
    const parent = await this.ensureHandle(request.parentSessionId);
    const parentFile = parent.manager.getSessionFile();
    if (!parentFile || parentFile !== request.parentSessionFile) {
      throw new OwnerSessionBranchError(`Parent session ${request.parentSessionId} is not persisted`);
    }
    const cwd = request.cwd || parent.manager.getCwd();
    const manager = SessionManager.create(cwd, this.sessionDir, { parentSession: parentFile });
    manager.appendCustomEntry(SESSION_RELATION_ENTRY, { kind: "subagent", ...(request.role ? { role: request.role } : {}) });
    // Роль — со своим профилем; вложенных субагентов у субагента нет.
    const session = await this.createSession(manager, request.role
      ? { role: request.role, customTools: [] }
      : { tools: request.tools, customTools: [] });
    const handle: SessionHandle = { manager, session, listeners: new Set() };
    this.handles.set(manager.getSessionId(), handle);
    this.attachSdkSubscription(handle);
    return {
      id: manager.getSessionId(),
      parentSession: parentFile,
      session,
    };
  }

  private relation(manager: SessionManager): OwnerSessionRelation {
    if (!manager.getHeader()?.parentSession) return "root";
    const marker = [...manager.getEntries()].reverse().find(entry => this.isRelationEntry(entry)) as any;
    return marker?.data?.kind === "subagent" ? "subagent" : "fork";
  }

  private defaultCreateOptions(manager: SessionManager): OwnerSessionCreateOptions {
    const relation = this.relation(manager);
    if (relation === "subagent") {
      const marker = [...manager.getEntries()].reverse().find(entry => this.isRelationEntry(entry)) as any;
      const role = typeof marker?.data?.role === "string" ? marker.data.role : undefined;
      return role ? { role, customTools: [] } : {};
    }
    if (relation !== "root") return { assistant: true };
    const hasPersistedModel = manager.getBranch().some(entry => entry.type === "model_change");
    return hasPersistedModel ? { assistant: true } : { assistant: true, modelRef: OWNER_ROOT_DEFAULT_MODEL };
  }

  private isRelationEntry(entry: SessionEntry): boolean {
    return entry.type === "custom" && (entry as any).customType === SESSION_RELATION_ENTRY;
  }
}
