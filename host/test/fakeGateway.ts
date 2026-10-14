import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type GatewayMessage, type HostMessage, type OpName } from "../src/protocol.js";

export interface FakeGatewayOptions {
  /** Неверный ключ: шлюз отвечает reject и закрывает соединение. */
  authorized?: boolean;
  /** Что хост объявил как roots — по умолчанию показываем то, что прислал хост. */
  acceptRoots?: boolean;
  acceptedOperations?: OpName[];
  /** Не отвечать на register — проверка таймаута рукопожатия. */
  silentOnRegister?: boolean;
}

/**
 * Локальный фейковый шлюз на ws: настоящий WebSocket-сервер, настоящие кадры
 * протокола. Нужен, чтобы проверить клиент целиком — приветствие с ключом,
 * онлайн с корнями, вызов операции, поток, отмену и переподключение — не дожидаясь
 * серверной половины из тикета 1.
 */
export class FakeGateway {
  readonly received: HostMessage[] = [];
  readonly sockets: WebSocket[] = [];
  private readonly server: WebSocketServer;
  private readonly options: FakeGatewayOptions;
  private waiters: Array<{ predicate: (message: HostMessage) => boolean; resolve: (message: HostMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

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
    server.on("connection", (socket) => gateway.onConnection(socket));
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

  private onConnection(socket: WebSocket): void {
    this.sockets.push(socket);
    socket.on("close", () => {
      const at = this.sockets.indexOf(socket);
      if (at !== -1) this.sockets.splice(at, 1);
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

  /** Ответ по умолчанию: приветствие → welcome → register → registered, пинги → pong. */
  private handle(message: HostMessage, socket: WebSocket): void {
    switch (message.type) {
      case "hello": {
        if (this.options.authorized === false) {
          this.send(socket, { type: "reject", code: "unauthorized", message: "ключ не найден в реестре" });
          socket.close(4001, "unauthorized");
          return;
        }
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.send(socket, { type: "reject", code: "protocol_mismatch", message: `хочу протокол ${PROTOCOL_VERSION}` });
          socket.close(4002, "rejected: protocol_mismatch");
          return;
        }
        this.send(socket, { type: "welcome", sessionId: "сессия-1", protocolVersion: PROTOCOL_VERSION });
        return;
      }
      case "register": {
        if (this.options.silentOnRegister) return;
        this.send(socket, {
          type: "registered",
          sessionId: "сессия-1",
          acceptedRoots: this.options.acceptRoots === false ? [] : message.roots,
          acceptedOperations: this.options.acceptedOperations,
        });
        return;
      }
      case "ping":
        this.send(socket, { type: "pong", at: message.at });
        return;
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

  /** Ждёт сообщение хоста, подходящее под условие. */
  waitFor(predicate: (message: HostMessage) => boolean, label = "сообщение", timeoutMs = 5_000): Promise<HostMessage> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`шлюз не дождался: ${label} (${timeoutMs} мс). Получено: ${this.received.map((m) => m.type).join(", ")}`));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  /** Ждёт сообщение хоста заданного типа — с уже суженным типом, без приведений. */
  waitForType<T extends HostMessage["type"]>(type: T, label: string = type, timeoutMs = 5_000): Promise<Extract<HostMessage, { type: T }>> {
    return this.waitFor((message) => message.type === type, label, timeoutMs) as Promise<Extract<HostMessage, { type: T }>>;
  }

  ofType<T extends HostMessage["type"]>(type: T): Extract<HostMessage, { type: T }>[] {
    return this.received.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
  }

  /** Все результаты по конкретному вызову. */
  resultsFor(opId: string): Array<Extract<HostMessage, { type: "result" }>> {
    return this.received.filter((message): message is Extract<HostMessage, { type: "result" }> => message.type === "result" && message.opId === opId);
  }

  /** Весь поток вывода по конкретному вызову, склеенный по потокам. */
  streamFor(opId: string): { stdout: string; stderr: string } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    for (const message of this.received) {
      if (message.type !== "chunk" || message.opId !== opId) continue;
      (message.stream === "stderr" ? stderr : stdout).push(message.text);
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