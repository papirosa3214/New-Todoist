import crypto from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AuthSessionNotFoundError } from "./errors.js";

// AuthSession — короткоживущая сущность вокруг интерактивного login() Pi
// (спека §4-6). Причина появления: OAuth нельзя делать одним синхронным
// HTTP-запросом. Pi выдаёт auth_url и ждёт, пока пользователь откроет
// ссылку и (иногда) введёт manual_code. Если HTTP-ответ TaskFlow отдаётся
// только после завершения login(), пользователь никогда не увидит
// auth_url вовремя — deadlock. Поэтому POST /auth запускает login в фоне
// и сразу возвращает authSessionId, а события идут отдельным потоком.

export type AuthSessionStatus =
  | "starting"
  | "waiting_user"
  | "processing"
  | "connected"
  | "failed"
  | "cancelled";

/** Запрос ввода, который Pi ждёт от пользователя. UI показывает его и
 *  отправляет ответ через POST /auth/:id/input. */
export interface AuthPromptRequest {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export type AuthSessionEventType =
  | "auth_url"
  | "device_code"
  | "prompt"
  | "progress"
  | "info"
  | "success"
  | "error"
  | "cancelled";

export interface AuthSessionEvent {
  seq: number;
  at: string;
  type: AuthSessionEventType;
  data: Record<string, unknown>;
}

export interface AuthSessionView {
  id: string;
  provider: string;
  status: AuthSessionStatus;
  createdAt: string;
  expiresAt: string;
  currentPrompt: AuthPromptRequest | null;
  error: string | null;
  events: AuthSessionEvent[];
}

const SESSION_TTL_MS = 10 * 60 * 1000;

/** Маппит AuthEvent из Pi SDK в наш AuthSessionEventType. */
function mapAuthEventType(type: unknown): AuthSessionEventType | null {
  switch (type) {
    case "auth_url":
      return "auth_url";
    case "device_code":
      return "device_code";
    case "progress":
      return "progress";
    case "info":
      return "info";
    default:
      return null;
  }
}

export class AuthSession {
  readonly id: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly expiresAt: string;

  status: AuthSessionStatus = "starting";
  error: string | null = null;

  private readonly events: AuthSessionEvent[] = [];
  private readonly subscribers = new Set<(event: AuthSessionEvent) => void>();
  private readonly abortController = new AbortController();
  private pending: {
    request: AuthPromptRequest;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    /** Снимает abort-listener конкретного prompt'а. */
    cleanup: () => void;
  } | null = null;
  private seq = 0;
  private settled = false;

  constructor(provider: string) {
    this.id = `auth_${crypto.randomUUID()}`;
    this.provider = provider;
    const now = Date.now();
    this.createdAt = new Date(now).toISOString();
    this.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get currentPrompt(): AuthPromptRequest | null {
    return this.pending?.request ?? null;
  }

  get finished(): boolean {
    return this.settled;
  }

  private push(type: AuthSessionEventType, data: Record<string, unknown>): void {
    const event: AuthSessionEvent = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      data,
    };
    this.events.push(event);
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // подписчик (SSE) мог отвалиться — не роняем login из-за этого.
      }
    }
  }

  /** Событие от Pi (notify). */
  notify(raw: unknown): void {
    if (this.settled) return;
    if (!raw || typeof raw !== "object") return;
    const ev = raw as Record<string, unknown>;
    const type = mapAuthEventType(ev.type);
    if (!type) return;
    if (type === "auth_url") {
      if (typeof ev.url !== "string") return;
      this.status = "waiting_user";
      this.push("auth_url", {
        url: ev.url,
        instructions: typeof ev.instructions === "string" ? ev.instructions : undefined,
      });
      return;
    }
    if (type === "device_code") {
      if (typeof ev.userCode !== "string" || typeof ev.verificationUri !== "string") return;
      this.status = "waiting_user";
      this.push("device_code", {
        userCode: ev.userCode,
        verificationUri: ev.verificationUri,
        intervalSeconds: typeof ev.intervalSeconds === "number" ? ev.intervalSeconds : undefined,
        expiresInSeconds: typeof ev.expiresInSeconds === "number" ? ev.expiresInSeconds : undefined,
      });
      return;
    }
    this.push(type, {
      message: typeof ev.message === "string" ? ev.message : "",
    });
  }

  /** Снимает pending prompt: очищает currentPrompt, отписывает abort-
   *  listener и завершает ожидающий Promise (resolve "" нельзя — это
   *  выглядело бы как пустой ввод пользователя, поэтому reject). */
  private clearPending(reason: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.cleanup();
    pending.reject(new Error(reason));
  }

  /** Запрос ввода от Pi. Промис резолвится, когда пользователь пришлёт
   *  значение через POST /auth/:id/input, либо reject'ится при отмене.
   *
   *  Учитываем signal конкретного prompt'а: Pi документирует его как
   *  «abort, если шаг разрешился извне» — например, manual_code-ввод
   *  проиграл гонку callback-серверу. По abort обязаны очистить pending
   *  (currentPrompt → null) и отклонить Promise, иначе login повиснет. */
  prompt(raw: unknown): Promise<string> {
    if (this.settled) {
      return Promise.reject(new Error("Auth session is not active"));
    }
    const p = (raw ?? {}) as Record<string, unknown>;
    const type = (p.type ?? "text") as AuthPromptRequest["type"];
    const request: AuthPromptRequest = {
      type,
      message: typeof p.message === "string" ? p.message : "",
      placeholder: typeof p.placeholder === "string" ? p.placeholder : undefined,
      options: Array.isArray(p.options)
        ? (p.options as Array<{ id: string; label: string; description?: string }>)
        : undefined,
    };
    const rawSignal = p.signal as AbortSignal | undefined;
    const signal =
      rawSignal && typeof rawSignal.addEventListener === "function"
        ? rawSignal
        : undefined;

    this.status = "waiting_user";
    this.push("prompt", { request });

    const promise = new Promise<string>((resolve, reject) => {
      const entry = {
        request,
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        if (this.pending === entry) this.pending = null;
        entry.cleanup();
        reject(new Error("Auth prompt aborted"));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending = entry;
    });
    // Промпт могут снять извне (cancel/finish) — тогда reject остаётся без
    // наблюдателя. Пометим его обработанным, чтобы Node не падал на
    // unhandledRejection; настоящий ожидающий (SDK login) получит свой reject.
    promise.catch(() => { /* handled elsewhere */ });
    return promise;
  }

  /** Ответ пользователя на pending prompt. */
  submitInput(value: string): void {
    const pending = this.pending;
    if (!pending) {
      throw new Error("no pending prompt");
    }
    this.pending = null;
    pending.cleanup();
    this.status = "processing";
    this.push("info", { message: "Input received" });
    pending.resolve(value);
  }

  /** Успешное завершение login Pi (credentials записаны SDK). */
  markConnected(): void {
    if (this.settled) return;
    this.settled = true;
    // К моменту успеха никакого prompt висеть не должно: callback победил,
    // manual_code проиграл гонку и уже снят своим signal'ом. На всякий
    // случай снимаем — currentPrompt обязан стать null.
    this.clearPending("Auth session finished");
    this.status = "connected";
    this.push("success", { provider: this.provider });
  }

  /** Ошибка login Pi. */
  markFailed(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.clearPending("Auth session failed");
    this.status = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    this.push("error", { provider: this.provider, message: this.error });
  }

  /** Отмена пользователем. */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.status = "cancelled";
    this.clearPending("Auth session cancelled");
    this.abortController.abort(new Error("Auth session cancelled"));
    this.push("cancelled", { provider: this.provider });
  }

  get expired(): boolean {
    return Date.now() > Date.parse(this.expiresAt);
  }

  subscribe(listener: (event: AuthSessionEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Все события, начиная с seq > since (для переподключения SSE). */
  eventsSince(since: number): AuthSessionEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  toView(): AuthSessionView {
    return {
      id: this.id,
      provider: this.provider,
      status: this.status,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      currentPrompt: this.currentPrompt,
      error: this.error,
      events: [...this.events],
    };
  }
}

/**
 * Менеджер AuthSession. Хранит сессии в памяти процесса: это короткоживущие
 * сущности (10 минут), переживать рестарт им не нужно — незавершённый OAuth
 * просто начинается заново.
 */
export class AuthSessionManager {
  private readonly sessions = new Map<string, AuthSession>();

  /** Стартует OAuth login Pi в фоне и сразу возвращает сессию. */
  startOAuth(provider: string, rt: ModelRuntime): AuthSession {
    this.prune();
    const session = new AuthSession(provider);
    this.sessions.set(session.id, session);

    const interaction = {
      signal: session.signal,
      notify: (event: unknown) => session.notify(event),
      prompt: (prompt: unknown) => session.prompt(prompt),
    };

    rt.login(provider, "oauth", interaction as never)
      .then(() => session.markConnected())
      .catch((error: unknown) => {
        // Если пользователь отменил сессию — cancel() уже проставил статус
        // cancelled; не перетираем его failed'ом от abort'а.
        if (session.status === "cancelled") return;
        session.markFailed(error);
      });

    return session;
  }

  get(id: string): AuthSession | undefined {
    this.prune();
    return this.sessions.get(id);
  }

  require(id: string): AuthSession {
    const session = this.get(id);
    if (!session) throw new AuthSessionNotFoundError(id);
    return session;
  }

  submitInput(id: string, value: string): void {
    this.require(id).submitInput(value);
  }

  cancel(id: string): void {
    const session = this.get(id);
    if (session) session.cancel();
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.finished || session.expired) {
        // Завершённые держим ещё немного, чтобы клиент успел дочитать
        // финальное событие; по TTL удаляем.
        if (session.expired) this.sessions.delete(id);
      }
    }
  }
}

/** Singleton — используется и адаптером, и HTTP-роутом (SSE/input/cancel). */
export const authSessionManager = new AuthSessionManager();
