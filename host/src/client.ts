import { EventEmitter } from "node:events";
import os from "node:os";
import WebSocket from "ws";
import type { HostConfig } from "./config.js";
import type { Logger } from "./log.js";
import { OPERATIONS, isKnownOperation } from "./operations/index.js";
import type { Operation, OperationContext } from "./operations/types.js";
import {
  type HostMessage,
  type OpMessage,
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  type StreamName,
  type WelcomeMessage,
  encode,
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
  /** Ключ машины из Keychain. Уходит в адрес подключения, а не в приветствие. */
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

const ERROR_CODES: readonly ProtocolErrorCode[] = [
  "path_denied",
  "bad_args",
  "not_found",
  "cancelled",
  "timeout",
  "limit_exceeded",
];

/**
 * Текст ошибки операции для протокола. Код — если операция его поставила, иначе
 * «internal»: сервер код не проверяет, но роль по нему отличает «не повезло с
 * путём» от «хост сломался».
 */
export function describeOperationError(error: unknown): { error: string; code?: ProtocolErrorCode } {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
    return { error: message, code: code as ProtocolErrorCode };
  }
  return { error: message, code: "internal" };
}

/**
 * Куски потока склеиваются перед отправкой: xcodebuild сыпет вывод построчно,
 * и по кадру на строку сокет превращается в бутылочное горлышко. Буфер свой на
 * каждый поток, иначе stderr перемешался бы с stdout и роль не поняла бы,
 * что было до и после чего.
 *
 * Кадр зовётся `op_chunk`, поле текста — `data`: под эти имена сервер ждёт
 * поток в `deliverChunk` и обрезает его по HOST_MAX_OUTPUT_BYTES.
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
    const data = this.pending.join("");
    this.pending = [];
    this.bytes = 0;
    this.send({ type: "op_chunk", opId: this.opId, stream: this.stream, data });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.bytes = 0;
  }
}

/**
 * Клиент шлюза: сам подключается к .110 и держит канал (D3). Мак засыпает и
 * меняет адрес — поэтому переподключение бесконечное, а сервер ни к маку не
 * ходит.
 *
 * Рукопожатие двухшаговое, и оба шага видны снаружи:
 *   1. ключ уходит в адресе `?key=`, сервер проверяет его ДО принятия хоста и
 *      отвечает ПЕРВЫМ welcome — тот ещё не знает наших корней;
 *   2. хост шлёт `hello` со своими корнями, сервер отвечает ВТОРЫМ welcome с
 *      пересечением. Только второй welcome и есть разрешение.
 *
 * Ключ в приветствие класть нельзя: сервер такого поля не читает, и ключ
 * просто потеряется — с прежней версией хоста это и происходило.
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
  /** Отдельно от phase: «stopped» бывает и в начале жизни, когда connect ещё надо звать. */
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private machineId = "";
  private machineName = "";
  /** Корни, которые шлюз реально разрешил (D4). Пусто — ещё не согласованы. */
  private acceptedRoots: string[] = [];
  private pingMs = 20_000;
  private readyPromise: Promise<void> | undefined;

  private readonly inflight = new Map<string, AbortController>();
  /** Очередь welcome'ов: первый ждёт подключение, второй — наш hello. */
  private welcomeWaiters: Array<(welcome: WelcomeMessage) => void> = [];

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

  get currentMachine(): { id: string; name: string } {
    return { id: this.machineId, name: this.machineName };
  }

  /** Сколько операций хост выполняет прямо сейчас. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Разрешается, когда пришёл второй welcome с корнями. Отклоняется по stop(). */
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

  /**
   * Адрес с ключом в query. Ключ уходит именно так, а не в приветствии: сервер
   * проверяет его в обработчике подключения и по нему же определяет машину.
   */
  private gatewayUrlWithKey(): string {
    const url = new URL(this.config.gatewayUrl);
    url.searchParams.set("key", this.key);
    return url.toString();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setPhase("connecting");
    this.attempts += 1;

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.gatewayUrlWithKey());
    } catch (error) {
      this.log.warn("не удалось открыть соединение", {
        url: this.config.gatewayUrl,
        error: error instanceof Error ? error.message : String(error),
      });
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

    try {
      // Шаг 1: первый welcome приходит сразу после проверки ключа, до нашего
      // hello. Он ничего не разрешает — по нему узнаём, что ключ принят, и
      // забираем имя машины.
      const первый = await this.waitForWelcome(this.config.handshakeTimeoutMs, "шлюз не ответил на подключение");
      if (первый.protocolVersion !== 0 && первый.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(`шлюз говорит по протоколу ${первый.protocolVersion}, хост — по ${PROTOCOL_VERSION}`);
        return;
      }
      this.machineId = первый.machineId || this.config.machineId;
      this.machineName = первый.machineName || this.config.machineId;
      this.pingMs = первый.pingMs > 0 ? первый.pingMs : 20_000;

      // Шаг 2: называем свои корни и ждём ВТОРОЙ welcome — уже с пересечением.
      this.send({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        hostVersion: HOST_VERSION,
        platform: this.platform,
        roots: this.config.roots,
      });

      const окончательный = await this.waitForWelcome(
        this.config.handshakeTimeoutMs,
        "шлюз не подтвердил разрешённые корни после приветствия",
      );
      this.acceptedRoots = окончательный.allowedRoots;
      if (this.acceptedRoots.length === 0) {
        // Пустое пересечение: машина онлайн, но работать ей негде. Лучше явный
        // отказ, чем молчаливое «всё ок», из которого роль потом удивится,
        // что ни одна папка не открылась.
        this.fail("шлюз не разрешил ни одного корня — операции выполнять негде");
        return;
      }

      this.attempts = 0;
      this.setPhase("ready");
      this.startHeartbeat();
      this.log.info("хост онлайн", {
        machine: this.machineName,
        id: this.machineId,
        version: HOST_VERSION,
        host: this.hostname,
        roots: this.acceptedRoots.join(","),
      });
      this.emit("ready");
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Пинг в протоколе шлёт СЕРВЕР, хост только отвечает `pong`. Своего пинга
    // хост не шлёт: сервер его не читает, а лишний кадр лишь раздувает поток.
    // Таймер остаётся сторожем: после сна и смены сети сокет выглядит
    // «открытым», и без проверки обрыв заметен только по первому вызову.
    this.heartbeatTimer = setInterval(() => {
      if (this.phase !== "ready") return;
      if (!this.socket) this.forceClose("сокет пропал");
    }, Math.max(3_000, this.pingMs) * 3);
    this.heartbeatTimer.unref?.();
  }

  private onClose(code: number, reason: string): void {
    if (this.stopped) return;
    this.clearTimers();
    this.abortInflight("соединение с шлюзом оборвалось");
    this.socket = undefined;
    this.acceptedRoots = [];
    this.setPhase("connecting");
    if (this.rejected) {
      // Отказ по ключу или отзыв машины. Переподключение тут бессильно: тот же
      // ключ даст тот же отказ, и хост будет биться в стену до бесконечности,
      // съедая лимит переподключений впустую. Запись в лог остаётся — в launchd
      // её видно, и починить ключ можно руками.
      this.rejected = false;
      this.log.error("хост отвергнут шлюзом — переподключение прекращено, нужен новый ключ");
      return;
    }
    this.log.warn("соединение с шлюзом оборвалось", { code, reason, attempt: this.attempts });
    this.scheduleReconnect();
  }

  /**
   * Шлюз отверг хоста: ключ не подошёл или машина отозвана. Помечаем, чтобы
   * обработчик закрытия не планировал ещё попытку.
   */
  private rejected = false;

  private fail(reason: string): void {
    this.log.error(reason, { url: this.config.gatewayUrl });
    this.setPhase("connecting");
    this.forceClose(reason.slice(0, 100));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(
      this.config.reconnectMaxMs,
      this.config.reconnectMinMs * 2 ** Math.max(0, this.attempts - 1),
    );
    // Разброс: после сна или при смене сети несколько попыток не должны бить в
    // шлюз синхронно.
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.log.info("переподключусь через мс", { delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    // НЕ unref: пока сокета нет, этот таймер — единственное, что держит
    // процесс. С unref Node после обрыва честно писал «переподключусь через
    // мс» и тут же выходил с кодом 0 — мак пропадал до ручного перезапуска
    // (правка 11, 15.10.2026).
  }

  /**
   * Рвём сокет. Переподключение планирует вызывающий: при отказе его планировать
   * нельзя, при обычном обрыве — нужно. Поэтому здесь только закрытие.
   */
  private forceClose(reason: string): void {
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close(4000, reason);
    } catch {
      // Уже закрыт.
    }
  }

  private waitForWelcome(timeoutMs: number, timeoutMessage: string): Promise<WelcomeMessage> {
    return new Promise<WelcomeMessage>((resolve, reject) => {
      const push = (welcome: WelcomeMessage) => {
        clearTimeout(timer);
        resolve(welcome);
      };
      const timer = setTimeout(() => {
        this.welcomeWaiters = this.welcomeWaiters.filter((waiter) => waiter !== push);
        reject(new Error(`${timeoutMessage} (${timeoutMs} мс)`));
      }, timeoutMs);
      timer.unref?.();
      this.welcomeWaiters.push(push);
    });
  }

  private onMessage(raw: string): void {
    const parsed = parseGatewayMessage(raw);
    if (!parsed.ok) {
      this.log.warn("шлюз прислал нечитаемый кадр", { error: parsed.error, raw: raw.slice(0, 200) });
      return;
    }
    const message = parsed.message;

    switch (message.type) {
      case "welcome": {
        // Два welcome разбираются по порядку: первый ждал подключение, второй
        // — наше hello.
        const waiter = this.welcomeWaiters.shift();
        if (waiter) waiter(message);
        else this.log.debug("welcome без ожидающего", { roots: message.allowedRoots.join(",") });
        return;
      }
      case "ping":
        this.send({ type: "pong" });
        return;
      case "op":
        void this.handleOp(message);
        return;
      case "op_cancel":
        this.handleCancel(message.opId);
        return;
      case "error":
        // Отказ по ключу или отзыв машины: тот же ключ даст тот же отказ,
        // поэтому бесконечные переподключения тут бессмысленны.
        this.log.error("шлюз отверг хоста", { error: message.error });
        this.rejected = true;
        this.forceClose(`rejected: ${message.error}`);
        return;
      default:
        this.log.debug("кадр без обработчика", { type: (message as { type: string }).type });
    }
  }

  private handleCancel(opId: string): void {
    const controller = this.inflight.get(opId);
    if (!controller) return;
    this.log.info("отмена операции", { opId });
    controller.abort("отменено шлюзом");
  }

  private async handleOp(message: OpMessage): Promise<void> {
    const { opId } = message;
    const args = (message.args ?? {}) as Record<string, unknown>;
    const name = typeof message.op === "string" ? message.op : "";

    const fail = (text: string, code?: ProtocolErrorCode) => {
      this.send({ type: "op_result", opId, ok: false, error: text, code });
    };

    if (typeof opId !== "string" || !opId) return fail("у вызова нет opId", "bad_args");
    if (!isKnownOperation(name)) return fail(`хост не умеет операцию «${String(message.op)}»`, "bad_args");

    const operation = this.operations[name];
    if (!operation) return fail(`хост не умеет операцию «${name}»`, "bad_args");
    if (this.acceptedRoots.length === 0) {
      return fail("шлюз не разрешил ни одного корня — хост не готов к операциям", "internal");
    }
    if (this.inflight.size >= this.config.maxConcurrentOps) {
      return fail(`хост уже выполняет ${this.inflight.size} операций — подожди`, "internal");
    }

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
      roots: this.acceptedRoots,
      worktreesBase: this.config.worktreesBase,
      limits: {
        bashTimeoutMs: message.timeoutMs ?? this.config.bashTimeoutMs,
        bashOutputLimitBytes: this.config.bashOutputLimitBytes,
      },
      emit: (stream, text) => writers[stream].write(text),
      signal: controller.signal,
      now: this.now,
    };

    try {
      const data = await operation(args, context);
      flushAll();
      // op_result с ok:true. Поля exitCode/stdout/stderr сервер читает для bash;
      // data — наша полезная нагрузка (счётчики, текст прочитанного). Поток
      // вывода сюда НЕ кладём: он уже уехал кадрами op_chunk, и второй раз
      // слать мегабайты по сети незачем.
      const результат = (data ?? {}) as Record<string, unknown>;
      this.send({
        type: "op_result",
        opId,
        ok: true,
        exitCode: typeof результат["exitCode"] === "number" ? (результат["exitCode"] as number) : 0,
        stdout: typeof результат["stdout"] === "string" ? (результат["stdout"] as string) : "",
        stderr: typeof результат["stderr"] === "string" ? (результат["stderr"] as string) : "",
        truncated: результат["truncated"] === true ? true : undefined,
        data,
      });
      this.log.debug("операция выполнена", { opId, op: name });
    } catch (error) {
      flushAll();
      if (controller.signal.aborted && !(error instanceof Error && error.name === "BadArgsError")) {
        this.send({
          type: "op_result",
          opId,
          ok: false,
          error: String(controller.signal.reason ?? "отменено"),
          code: "cancelled",
        });
      } else {
        const { error: текст, code } = describeOperationError(error);
        this.send({ type: "op_result", opId, ok: false, error: текст, code });
      }
      this.log.warn("операция не удалась", {
        opId,
        op: name,
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.log.warn("не отправилось сообщение", {
        type: message.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}