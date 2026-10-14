import { EventEmitter } from "node:events";
import os from "node:os";
import WebSocket from "ws";
import type { HostConfig } from "./config.js";
import type { Logger } from "./log.js";
import { OPERATIONS, isKnownOperation } from "./operations/index.js";
import type { Operation, OperationContext } from "./operations/types.js";
import {
  type CallMessage,
  type GatewayMessage,
  type HostMessage,
  type OpName,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolErrorCode,
  type StreamName,
  encode,
  isOpName,
  parseGatewayMessage,
} from "./protocol.js";

export const HOST_VERSION = "0.1.0";

/** Минимальный срез WebSocket, которого хватает хосту. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export type ClientPhase = "stopped" | "connecting" | "handshaking" | "ready";

export interface HostClientOptions {
  config: HostConfig;
  /** Ключ машины из Keychain. */
  key: string;
  log: Logger;
  createSocket?: SocketFactory;
  hostname?: string;
  platform?: string;
  now?: () => number;
  /** Операции хоста; по умолчанию полный набор. */
  operations?: Record<string, Operation>;
}

function defaultSocketFactory(url: string): SocketLike {
  const socket = new WebSocket(url, { handshakeTimeout: 20_000, maxPayload: 8 * 1024 * 1024 });
  return socket as unknown as SocketLike;
}

const ERROR_CODES: readonly ProtocolErrorCode[] = ["path_denied", "bad_args", "not_found", "cancelled", "timeout", "limit_exceeded"];

/** Классифицирует ошибку операции в код протокола — по нему шлюз решает, чья это вина. */
export function toProtocolError(error: unknown): ProtocolError {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
    return { code: code as ProtocolErrorCode, message };
  }
  return { code: "internal", message };
}

/**
 * Кадры `chunk` склеиваются перед отправкой: xcodebuild сыпет вывод построчно,
 * и по кадру на строку сокет превращается в бутылочное горлышко. Буфер свой на
 * каждый поток, иначе stderr перемешался бы с stdout и роль не поняла бы,
 * что было до и после чего.
 */
class ChunkWriter {
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bytes = 0;

  constructor(
    private readonly stream: StreamName,
    private readonly opId: string,
    private readonly send: (message: HostMessage) => void,
    private readonly flushMs = 50,
    private readonly maxBytes = 64 * 1024,
  ) {}

  write(text: string): void {
    if (!text) return;
    this.pending.push(text);
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes >= this.maxBytes) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    this.pending = [];
    this.bytes = 0;
    this.send({ type: "chunk", opId: this.opId, stream: this.stream, text });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.bytes = 0;
  }
}

/**
 * Клиент шлюза: сам подключается к .110, здоровается ключом, сообщает корни и
 * держит канал (D3). Мак засыпает и меняет адрес — поэтому переподключение
 * бесконечное, а сервер ни к маку не ходит.
 */
export class HostClient extends EventEmitter {
  private readonly config: HostConfig;
  private readonly key: string;
  private readonly log: Logger;
  private readonly createSocket: SocketFactory;
  private readonly operations: Record<string, Operation>;
  private readonly hostname: string;
  private readonly platform: string;
  private readonly now: () => number;

  private socket: SocketLike | undefined;
  private phase: ClientPhase = "stopped";
  /** Отдельно от phase: фаза «stopped» бывает и в начале жизни, когда connect вызывать надо. */
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private sessionId: string | undefined;
  /** Корни, которые шлюз реально разрешил (D4). Пусто — ещё не согласованы. */
  private acceptedRoots: string[] = [];
  private acceptedOperations: OpName[] = [];
  private lastPongAt = 0;
  private readonly inflight = new Map<string, AbortController>();
  private readonly waiters = new Map<string, (message: GatewayMessage) => void>();
  private readyPromise: Promise<void> | undefined;

  constructor(options: HostClientOptions) {
    super();
    this.setMaxListeners(0);
    this.config = options.config;
    this.key = options.key;
    this.log = options.log;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.operations = options.operations ?? (OPERATIONS as unknown as Record<string, Operation>);
    this.hostname = options.hostname ?? os.hostname();
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  get currentPhase(): ClientPhase {
    return this.phase;
  }

  /** Корни для операций: согласованные шлюзом, а пока те, что заявил хост. */
  get roots(): string[] {
    return this.acceptedRoots.length > 0 ? this.acceptedRoots : this.config.roots;
  }

  /** Пусто — шлюз не сузил набор, значит разрешены все операции хоста. */
  get allowedOperations(): OpName[] {
    return this.acceptedOperations;
  }

  get currentSession(): string | undefined {
    return this.sessionId;
  }

  /** Сколько операций хост выполняет прямо сейчас. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Разрешается, когда хост онлайн и корни согласованы. Отклоняется по stop(). */
  whenReady(): Promise<void> {
    this.readyPromise ??= new Promise<void>((resolve, reject) => {
      if (this.phase === "ready") resolve();
      this.once("ready", resolve);
      this.once("stopped", () => reject(new Error("хост остановлен до подключения")));
    });
    return this.readyPromise;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.phase = "stopped";
    this.clearTimers();
    this.abortInflight("хост останавливается");
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close(1000, "stop");
    } catch {
      // Уже закрыт — ничего страшного.
    }
    this.emit("stopped");
  }

  private setPhase(phase: ClientPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit("phase", phase);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
  }

  private abortInflight(reason: string): void {
    for (const controller of this.inflight.values()) controller.abort(reason);
    this.inflight.clear();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setPhase("connecting");
    this.attempts += 1;

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.config.gatewayUrl);
    } catch (error) {
      this.log.warn("не удалось открыть соединение", { url: this.config.gatewayUrl, error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => void this.onOpen());
    socket.on("message", (...args: never[]) => {
      const raw = args[0] as unknown;
      this.onMessage(typeof raw === "string" ? raw : String(raw));
    });
    socket.on("error", (...args: never[]) => {
      const error = args[0] as unknown;
      // close придёт следом и запланирует переподключение — второй раз не планируем.
      this.log.debug("ошибка сокета", { error: error instanceof Error ? error.message : String(error) });
    });
    socket.on("close", (...args: never[]) => {
      const code = typeof args[0] === "number" ? args[0] : 0;
      const reason = args.length > 1 ? String(args[1]) : "";
      this.onClose(code, reason);
    });
  }

  private async onOpen(): Promise<void> {
    this.setPhase("handshaking");
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      key: this.key,
      machineId: this.config.machineId,
      hostVersion: HOST_VERSION,
      platform: this.platform,
      hostname: this.hostname,
      pid: process.pid,
    });

    try {
      const welcome = await this.waitFor("welcome", this.config.handshakeTimeoutMs, "шлюз не ответил на приветствие");
      const version = (welcome as { protocolVersion?: number }).protocolVersion;
      if (typeof version === "number" && version !== PROTOCOL_VERSION) {
        this.fail(`шлюз говорит по протоколу ${version}, хост — по ${PROTOCOL_VERSION}`);
        return;
      }
      this.sessionId = (welcome as { sessionId?: string }).sessionId;

      this.send({
        type: "register",
        machineId: this.config.machineId,
        hostVersion: HOST_VERSION,
        platform: this.platform,
        hostname: this.hostname,
        roots: this.config.roots,
        operations: Object.keys(this.operations) as OpName[],
      });

      const registered = await this.waitFor("registered", this.config.handshakeTimeoutMs, "шлюз не подтвердил регистрацию машины");
      this.acceptedRoots = readRoots(registered);
      this.acceptedOperations = readOperations(registered);
      if (this.acceptedRoots.length === 0) {
        this.fail("шлюз не разрешил ни одного корня — операции выполнять негде");
        return;
      }

      this.attempts = 0;
      this.lastPongAt = this.now();
      this.setPhase("ready");
      this.startHeartbeat();
      this.log.info("хост онлайн", {
        machine: this.config.machineId,
        version: HOST_VERSION,
        session: this.sessionId,
        roots: this.acceptedRoots.join(","),
        operations: this.acceptedOperations.join(",") || "все",
      });
      this.emit("ready");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = Math.max(1_000, this.config.heartbeatMs);
    this.heartbeatTimer = setInterval(() => {
      if (this.phase !== "ready") return;
      // Тишина в два интервала — соединение мертво, хоть сокет и открыт (сон и
      // смена сети оставляют именно такое). Рвём сами и переподключаемся.
      if (this.now() - this.lastPongAt > interval * 2) {
        this.log.warn("шлюз не отвечает на пинги — переподключаюсь");
        this.forceClose("ping timeout");
        return;
      }
      this.send({ type: "ping", at: this.now() });
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private onClose(code: number, reason: string): void {
    if (this.stopped) return;
    this.clearTimers();
    this.abortInflight("соединение с шлюзом оборвалось");
    this.socket = undefined;
    if (this.rejected) {
      this.rejected = false;
      this.setPhase("connecting");
      return;
    }
    this.setPhase("connecting");
    this.log.warn("соединение с шлюзом оборвалось", { code, reason, attempt: this.attempts });
    this.scheduleReconnect();
  }

  /**
   * Шлюз отверг хоста (отозван ключ, не та версия протокола). Переподключение
   * тут бессильно — тот же ключ получит тот же отказ, — поэтому помечаем и не
   * мучаемся, а запись в лог видна в launchd.
   */
  private rejected = false;

  private fail(reason: string): void {
    this.log.error(reason, { url: this.config.gatewayUrl });
    this.setPhase("connecting");
    this.forceClose(reason.slice(0, 100), true);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.max(0, this.attempts - 1));
    // Разброс: после сна или при смене сети несколько попыток не должны бить в
    // шлюз синхронно.
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.log.info("переподключусь через мс", { delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private forceClose(reason: string, rejected = false): void {
    if (rejected) this.rejected = true;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close(4000, reason);
    } catch {
      // Уже закрыт.
    }
    this.scheduleReconnect();
  }

  private waitFor(type: string, timeoutMs: number, timeoutMessage: string): Promise<GatewayMessage> {
    return new Promise<GatewayMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(type);
        reject(new Error(`${timeoutMessage} (${timeoutMs} мс)`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(type, (message) => {
        clearTimeout(timer);
        this.waiters.delete(type);
        resolve(message);
      });
    });
  }

  private onMessage(raw: string): void {
    const parsed = parseGatewayMessage(raw);
    if (!parsed.ok) {
      this.log.warn("шлюз прислал нечитаемый кадр", { error: parsed.error, raw: raw.slice(0, 200) });
      return;
    }
    const message = parsed.message;
    const waiter = this.waiters.get(message.type);
    if (waiter) {
      waiter(message);
      return;
    }

    switch (message.type) {
      case "call":
        void this.handleCall(message as CallMessage);
        return;
      case "cancel":
        this.handleCancel(message as { opId: string; reason?: string });
        return;
      case "reject":
        this.rejected = true;
        this.log.error("шлюз отверг хоста", { code: message.code, message: message.message });
        this.forceClose(`rejected: ${message.code}`);
        return;
      case "ping":
        this.send({ type: "pong", at: (message as { at?: number }).at ?? this.now() });
        return;
      case "pong":
        this.lastPongAt = this.now();
        return;
      default:
        this.log.debug("сообщение без обработчика", { type: message.type });
    }
  }

  private handleCancel(message: { opId: string; reason?: string }): void {
    const controller = this.inflight.get(message.opId);
    if (!controller) return;
    this.log.info("отмена операции", { opId: message.opId, reason: message.reason });
    controller.abort(message.reason ?? "отменено шлюзом");
  }

  private async handleCall(message: CallMessage): Promise<void> {
    const { opId } = message;
    const args = (message.args ?? {}) as Record<string, unknown>;
    const name = typeof message.op === "string" ? message.op : "";

    const fail = (code: ProtocolErrorCode, text: string) => {
      this.send({ type: "result", opId, ok: false, error: { code, message: text } });
    };

    if (typeof opId !== "string" || !opId) return fail("bad_args", "у вызова нет opId");
    if (!isKnownOperation(name)) return fail("unknown_operation", `хост не умеет операцию «${String(message.op)}»`);
    if (this.acceptedOperations.length > 0 && !this.acceptedOperations.includes(name)) {
      return fail("operation_disabled", `операция «${name}» отключена шлюзом для этой машины`);
    }
    if (this.inflight.size >= this.config.maxConcurrentOps) {
      return fail("too_many_ops", `хост уже выполняет ${this.inflight.size} операций — подожди`);
    }

    const operation = this.operations[name];
    if (!operation) return fail("unknown_operation", `хост не умеет операцию «${name}»`);

    const controller = new AbortController();
    this.inflight.set(opId, controller);

    const writers: Record<StreamName, ChunkWriter> = {
      stdout: new ChunkWriter("stdout", opId, (m) => this.send(m)),
      stderr: new ChunkWriter("stderr", opId, (m) => this.send(m)),
    };
    const flushAll = () => {
      writers.stdout.flush();
      writers.stderr.flush();
    };

    const context: OperationContext = {
      roots: this.roots,
      worktreesBase: this.config.worktreesBase,
      limits: { bashTimeoutMs: this.config.bashTimeoutMs, bashOutputLimitBytes: this.config.bashOutputLimitBytes },
      emit: (stream, text) => writers[stream].write(text),
      signal: controller.signal,
      now: this.now,
    };

    try {
      const data = await operation(args, context);
      flushAll();
      this.send({ type: "result", opId, ok: true, data });
      this.log.debug("операция выполнена", { opId, op: name });
    } catch (error) {
      flushAll();
      if (controller.signal.aborted && !(error instanceof Error && error.name === "BadArgsError")) {
        this.send({ type: "result", opId, ok: false, error: { code: "cancelled", message: String(controller.signal.reason ?? "отменено") } });
      } else {
        this.send({ type: "result", opId, ok: false, error: toProtocolError(error) });
      }
      this.log.warn("операция не удалась", { opId, op: name, error: error instanceof Error ? error.message : String(error) });
    } finally {
      writers.stdout.dispose();
      writers.stderr.dispose();
      this.inflight.delete(opId);
    }
  }

  private send(message: HostMessage): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(encode(message));
    } catch (error) {
      this.log.warn("не отправилось сообщение", { type: message.type, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readRoots(message: GatewayMessage): string[] {
  const roots = (message as { acceptedRoots?: unknown }).acceptedRoots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((root): root is string => typeof root === "string" && root.trim() !== "").map((root) => root.trim());
}

function readOperations(message: GatewayMessage): OpName[] {
  const operations = (message as { acceptedOperations?: unknown }).acceptedOperations;
  if (!Array.isArray(operations)) return [];
  return operations.filter((op): op is OpName => isOpName(op));
}