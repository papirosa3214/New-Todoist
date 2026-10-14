import { WebSocket, WebSocketServer } from "ws";
import {
  HOST_MAX_OUTPUT_BYTES,
  type GatewayMessage,
  type HostMessage,
  PROTOCOL_VERSION,
} from "../src/protocol.js";

export interface FakeGatewayOptions {
  /** Неверный ключ: шлюз отвечает error и закрывает соединение. */
  authorized?: boolean;
  /** Что разрешить хосту: по умолчанию ровно то, что он объявил. */
  acceptRoots?: boolean;
  /** Явное пересечение корней — по умолчанию берётся из hello хоста. */
  allowedRoots?: string[];
  /** Не отвечать на hello вторым welcome — проверка таймаута рукопожатия. */
  silentOnHello?: boolean;
}

/**
 * Локальный фейковый шлюз на ws: настоящий WebSocket-сервер, настоящие кадры
 * протокола — ровно те, что ждёт сервер тикета 1. Нужен, чтобы проверить клиент
 * целиком (ключ в адресе, два welcome, вызов операции, поток, отмена,
 * переподключение), не дожидаясь серверной половины.
 *
 * Поведение повторяет `server/src/index.ts` и `server/src/host/gateway.ts`:
 *   1. ключ читается из query при подключении, ДО первого кадра от хоста;
 *   2. не подошёл — `error: "unauthorized"` и закрытие;
 *   3. подошёл — ПЕРВЫЙ welcome сразу, с серверными корнями;
 *   4. на `hello` — ВТОРОЙ welcome с пересечением корней.
 */
export class FakeGateway {
  readonly received: HostMessage[] = [];
  readonly sockets: WebSocket[] = [];
  /** Ключи, с которыми к нам реально подключались — проверка «ключ в адресе». */
  readonly keysSeen: string[] = [];
  private readonly server: WebSocketServer;
  private readonly options: FakeGatewayOptions;
  private waiters: Array<{
    predicate: (message: HostMessage) => boolean;
    resolve: (message: HostMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(server: WebSocketServer, options: FakeGatewayOptions) {
    this.server = server;
    this.options = options;
  }

  static async start(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const gateway = new FakeGateway(server, options);
    server.on("connection", (socket, req) => gateway.onConnection(socket, req.url ?? ""));
    return gateway;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("шлюз не слушает порт");
    return `ws://127.0.0.1:${address.port}/host`;
  }

  get connectionCount(): number {
    return this.sockets.length;
  }

  private onConnection(socket: WebSocket, url: string): void {
    this.sockets.push(socket);
    let key = "";
    try {
      key = new URL(url, "ws://localhost").searchParams.get("key") ?? "";
    } catch {
      key = "";
    }
    this.keysSeen.push(key);

    socket.on("close", () => {
      const at = this.sockets.indexOf(socket);
      if (at !== -1) this.sockets.splice(at, 1);
    });

    // Проверка ключа — ДО первого кадра от хоста, ровно как в index.ts.
    if (this.options.authorized === false) {
      this.send(socket, { type: "error", error: "unauthorized" });
      socket.close(4001, "unauthorized");
      return;
    }

    // Первый welcome — сразу после проверки ключа, с серверными корнями.
    this.send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      machineId: "машина-1",
      machineName: "mac",
      // До hello сервер наших корней ещё не знает — отдаём все, что разрешены.
      allowedRoots: ["/Users/max"],
      pingMs: 20_000,
      maxOutputBytes: HOST_MAX_OUTPUT_BYTES,
      defaultTimeoutMs: 600_000,
    });

    socket.on("message", (raw) => {
      let message: HostMessage;
      try {
        message = JSON.parse(String(raw)) as HostMessage;
      } catch {
        return;
      }
      this.received.push(message);
      for (const waiter of this.waiters.slice()) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
      this.handle(message, socket);
    });
  }

  private handle(message: HostMessage, socket: WebSocket): void {
    switch (message.type) {
      case "hello": {
        if (this.options.silentOnHello) return;
        // Второй welcome — окончательный, с пересечением корней.
        const разрешённые =
          this.options.allowedRoots ??
          (this.options.acceptRoots === false ? [] : (message.roots ?? ["/Users/max"]));
        this.send(socket, {
          type: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          machineId: "машина-1",
          machineName: "mac",
          allowedRoots: разрешённые,
          pingMs: 20_000,
          maxOutputBytes: HOST_MAX_OUTPUT_BYTES,
          defaultTimeoutMs: 600_000,
        });
        return;
      }
      // Ветки для ping/pong от хоста нет: в протоколе пинг шлёт СЕРВЕР, а хост
      // только отвечает. Если хост всё же пришлёт ping — это лишний кадр, его
      // просто игнорируем, а не отвечаем вторым.
      default:
        return;
    }
  }

  send(socket: WebSocket, message: GatewayMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  /** Послать всем открытым сокетам (обычно один). */
  broadcast(message: GatewayMessage): void {
    for (const socket of this.sockets) this.send(socket, message);
  }

  /** Вызвать операцию на подключённом хосте. */
  callOp(opId: string, op: string, args: Record<string, unknown> = {}, timeoutMs?: number): void {
    this.broadcast({ type: "op", opId, op, args, timeoutMs });
  }

  /** Отменить операцию. */
  cancelOp(opId: string): void {
    this.broadcast({ type: "op_cancel", opId });
  }

  /** Ждёт сообщение хоста, подходящее под условие. */
  waitFor(
    predicate: (message: HostMessage) => boolean,
    label = "сообщение",
    timeoutMs = 5_000,
  ): Promise<HostMessage> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<HostMessage>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(
            new Error(
              `шлюз не дождался: ${label} (${timeoutMs} мс). Получено: ${this.received.map((m) => m.type).join(", ")}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Ждёт сообщение хоста заданного типа — с уже суженным типом, без приведений. */
  waitForType<T extends HostMessage["type"]>(
    type: T,
    label: string = type,
    timeoutMs = 5_000,
  ): Promise<Extract<HostMessage, { type: T }>> {
    return this.waitFor(
      (message) => message.type === type,
      label,
      timeoutMs,
    ) as Promise<Extract<HostMessage, { type: T }>>;
  }

  ofType<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<HostMessage, { type: T }> => message.type === type,
    );
  }

  /** Все результаты по конкретному вызову. */
  resultsFor(opId: string): Array<Extract<HostMessage, { type: "op_result" }>> {
    return this.received.filter(
      (message): message is Extract<HostMessage, { type: "op_result" }> =>
        message.type === "op_result" && message.opId === opId,
    );
  }

  /** Первый результат по вызову — проще, чем ждать все. */
  resultFor(opId: string): Extract<HostMessage, { type: "op_result" }> | undefined {
    return this.resultsFor(opId)[0];
  }

  /** Весь поток вывода по вызову, склеенный по потокам. */
  streamFor(opId: string): { stdout: string; stderr: string } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    for (const message of this.received) {
      if (message.type !== "op_chunk" || message.opId !== opId) continue;
      (message.stream === "stderr" ? stderr : stdout).push(message.data);
    }
    return { stdout: stdout.join(""), stderr: stderr.join("") };
  }

  /** Рвёт все соединения без close-кадра — проверка переподключения хоста. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}