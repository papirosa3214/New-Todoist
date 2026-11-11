// Шлюз хостов: подключение по ключу, онлайн/офлайн, вызов операции с потоком и
// отменой, отзыв (тикет 1 «Сервер: реестр машин и шлюз хостов»).
//
// Тестовый клиент здесь — настоящий WebSocket через `ws`: условие приёмки
// «тестовый клиент с ключом подключается» иначе проверялось бы на подделке.
// Операции хоста не выполняются: тестовый хост на них отвечает сам, сценарием
// — всё, что важно серверу: он принял вызов, отдал поток, принял отмену.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { issueMachineKey } from "../src/host/machines.js";
import {
  isMachineOnline,
  runOperation,
  resetHostGatewaysForTests,
  revokeHostMachine,
} from "../src/host/gateway.js";
import { HOST_PROTOCOL_VERSION } from "../src/host/protocol.js";
import { redactSensitiveQueryForTest } from "../src/index.js";

/** Тестовый хост: подключается по ключу и отвечает на операции сценарием. */
class FakeHost {
  readonly socket: WebSocket;
  readonly полученные: any[] = [];
  /** Что хост сделает с очередным вызовом операции. По умолчанию — успех. */
  ответить: (op: any) => void = (op) => {
    this.socket.send(
      JSON.stringify({ type: "op_chunk", opId: op.opId, stream: "stdout", data: "строка\n" }),
    );
    this.socket.send(
      JSON.stringify({ type: "op_result", opId: op.opId, ok: true, exitCode: 0, stdout: "строка\n" }),
    );
  };

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const сообщение = JSON.parse(raw.toString());
      this.полученные.push(сообщение);
      if (сообщение.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (сообщение.type === "op") this.ответить(сообщение);
    });
  }

  static async подключиться(
    url: string,
    opts: { key?: string } = {},
  ): Promise<FakeHost> {
    const socket = new WebSocket(`${url}?key=${opts.key ?? "ПУСТО"}`);
    const хост = new FakeHost(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return хост;
  }

  /** Сообщения данного типа, пришедшие к хосту. */
  of(type: string) {
    return this.полученные.filter((м) => м.type === type);
  }

  /** Дождаться сообщения данного типа — для отмены и пингов, которые приходят
   *  не сразу, а по ходу работы вызова. */
  async ждать(type: string, сколькоMs = 3000): Promise<any> {
    const уже = this.of(type)[0];
    if (уже) return уже;
    return new Promise((resolve, reject) => {
      const таймер = setTimeout(
        () => reject(new Error(`хост не получил ${type} за ${сколькоMs}мс`)),
        сколькоMs,
      );
      const слушатель = (raw: any) => {
        const сообщение = JSON.parse(raw.toString());
        if (сообщение.type !== type) return;
        clearTimeout(таймер);
        socket_off(this.socket, слушатель);
        resolve(сообщение);
      };
      this.socket.on("message", слушатель);
    });
  }

  async закрыть() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const закрыт = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await закрыт;
  }
}

function socket_off(socket: WebSocket, listener: (raw: any) => void) {
  socket.off("message", listener);
}

/** Дождаться, пока условие станет правдой. Состояние «офлайн» пишется в базу
 *  по событию закрытия сокета, а оно приходит не в ту же миллисекунду. */
async function ждатьУсловия(условие: () => boolean, сколькоMs = 3000) {
  const край = Date.now() + сколькоMs;
  while (Date.now() < край) {
    if (условие()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("условие не наступило");
}

describe("Шлюз хостов: подключение, операции, отзыв", () => {
  let app: FastifyInstance;
  let url: string;
  let машина: { id: string; name: string; token: string };
  const хосты: FakeHost[] = [];

  async function хостДля(машинаId: string): Promise<FakeHost> {
    const { token } = issueMachineKey({ name: `машина-${машинаId.slice(0, 4)}`, allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    return хост;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const адрес = app.server.address();
    if (!адрес || typeof адрес === "string") throw new Error("сервер не слушает TCP");
    url = `ws://127.0.0.1:${адрес.port}/host-ws`;
  });

  afterAll(async () => {
    for (const хост of хосты) await хост.закрыть().catch(() => {});
    resetHostGatewaysForTests();
    await app.close();
  });

  beforeEach(() => {
    resetHostGatewaysForTests();
  });

  it("машина с верным ключом подключается и видна онлайн", async () => {
    const выданная = issueMachineKey({ name: "mac", allowedRoots: ["/Users/max"] });
    машина = выданная;

    const хост = await FakeHost.подключиться(url, { key: выданная.token });
    хосты.push(хост);

    const welcome = await хост.ждать("welcome");
    expect(welcome.machineId).toBe(выданная.machine.id);
    expect(welcome.protocolVersion).toBe(HOST_PROTOCOL_VERSION);

    expect(isMachineOnline(выданная.machine.id)).toBe(true);
  });

  it("с неверным ключом — отказ, и машина не появляется в реестре как онлайн", async () => {
    const выданная = issueMachineKey({ name: "mac-чужой", allowedRoots: ["/Users/max"] });

    const отказ = await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(`${url}?key=tfh_заведомо_неверный`);
      socket.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      socket.once("error", () => resolve({ type: "closed_without_message" }));
    });

    expect(отказ.type).toBe("error");
    expect(отказ.error).toBe("unauthorized");
    expect(isMachineOnline(выданная.machine.id)).toBe(false);
  });

  it("разрыв соединения переводит машину в офлайн", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-обрыв", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    await хост.ждать("welcome");
    expect(isMachineOnline(machine.id)).toBe(true);

    await хост.закрыть();

    await ждатьУсловия(() => !isMachineOnline(machine.id));
    expect(isMachineOnline(machine.id)).toBe(false);
  });

  it("ключ машины не попадает в журнал запросов открытым текстом", async () => {
    // Регрессия того же класса, что 08.09.2026 с пользовательскими токенами:
    // параметр называется `key`, а не `token`, и без строки в SENSITIVE_QUERY_KEYS
    // ключ каждой машины писался бы в журнал при каждом подключении хоста.
    const { token } = issueMachineKey({ name: "mac-лог", allowedRoots: ["/Users/max"] });
    const строка = redactSensitiveQueryForTest(`/host-ws?key=${token}`);
    expect(строка).not.toContain(token);
    expect(строка).toContain("key=***");
  });

  it("вызов операции возвращает поток и результат", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-операция", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    await хост.ждать("welcome");

    const куски: string[] = [];
    const результат = await runOperation(
      machine.id,
      "bash",
      { command: "echo строка" },
      { onChunk: (кусок) => куски.push(кусок.data) },
    );

    expect(результат.ok).toBe(true);
    expect(куски).toEqual(["строка\n"]);
    // Кадр и поле результата совпали — текст один, не дважды.
    expect((результат as { stdout?: string }).stdout).toBe("строка\n");
    // Сервер должен отдать хосту ровно тот вызов, который запросили.
    expect(хост.of("op")[0].op).toBe("bash");
    expect(хост.of("op")[0].args.command).toBe("echo строка");
  });

  it("пустой stdout в op_result не стирает текст, пришедший кадрами", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-кадры", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    await хост.ждать("welcome");
    хост.ответить = (op) => {
      хост.socket.send(JSON.stringify({ type: "op_chunk", opId: op.opId, stream: "stdout", data: "commit 649f627\n" }));
      хост.socket.send(JSON.stringify({ type: "op_chunk", opId: op.opId, stream: "stdout", data: "main\n" }));
      хост.socket.send(JSON.stringify({ type: "op_chunk", opId: op.opId, stream: "stderr", data: "warn\n" }));
      // Живой хост кладёт текст в кадры, а в op_result оставляет пустые строки.
      хост.socket.send(JSON.stringify({
        type: "op_result", opId: op.opId, ok: true, exitCode: 0, stdout: "", stderr: "",
      }));
    };

    const результат = await runOperation(machine.id, "bash", { command: "git log -1" });

    expect(результат.ok).toBe(true);
    expect((результат as { stdout?: string; stderr?: string; exitCode?: number }).exitCode).toBe(0);
    expect((результат as { stdout?: string }).stdout).toBe("commit 649f627\nmain\n");
    expect((результат as { stderr?: string }).stderr).toBe("warn\n");
  });

  it("отмена доходит до хоста, а вызов падает ошибкой отмены, а не висит", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-отмена", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    await хост.ждать("welcome");

    // Хост на отмену не отвечает результатом — как реальный процесс, который
    // ещё думает. Вызов обязан упасть по отмене, а не ждать результата вечно.
    хост.ответить = () => {};
    const контроллер = new AbortController();
    const вызов = runOperation(machine.id, "bash", { command: "sleep 100" }, {
      signal: контроллер.signal,
    });
    // Отказ ловим сразу же: иначе между abort() и await промежуток, и Vitest
    // видит необработанный reject.
    const отказ = вызов.then(() => null, (err: Error) => err);
    await хост.ждать("op");

    контроллер.abort();

    const отмена = await хост.ждать("op_cancel");
    expect(отмена.opId).toBe(хост.of("op")[0].opId);
    expect((await отказ)?.message).toMatch(/отмен/);
  });

  it("ошибка от хоста приходит к вызывающему как неуспех, а не как исключение сервера", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-ошибка", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    await хост.ждать("welcome");
    хост.ответить = (op) =>
      хост.socket.send(
        JSON.stringify({ type: "op_result", opId: op.opId, ok: false, error: "нет такого пути" }),
      );

    const результат = await runOperation(machine.id, "read", { path: "/nope" });

    expect(результат.ok).toBe(false);
    expect((результат as any).error).toBe("нет такого пути");
  });

  it("вызов офлайн-машины падает сразу, а не ждёт", async () => {
    const { machine } = issueMachineKey({ name: "mac-офлайн", allowedRoots: ["/Users/max"] });

    await expect(
      runOperation(machine.id, "bash", { command: "ls" }),
    ).rejects.toThrow(/офлайн|не на связи/i);
  });

  it("отзыв закрывает живой сокет и машина больше не принимается", async () => {
    const { machine, token } = issueMachineKey({ name: "mac-отзыв", allowedRoots: ["/Users/max"] });
    const хост = await FakeHost.подключиться(url, { key: token });
    хосты.push(хост);
    await хост.ждать("welcome");

    revokeHostMachine(machine.id, "проверка отзыва");

    await ждатьУсловия(() => !isMachineOnline(machine.id));
    // Сокет должен быть закрыт, а не просто забыт: оставленный открытый сокет
    // продолжил бы принимать операции от машины, которую уже отозвали.
    await ждатьУсловия(() => хост.socket.readyState === WebSocket.CLOSED);

    // И новый вход по тому же ключу — отказ.
    const повтор = await new Promise<any>((resolve) => {
      const socket = new WebSocket(`${url}?key=${token}`);
      socket.on("message", (raw) => resolve(JSON.parse(raw.toString())));
      socket.once("error", () => resolve({ type: "closed_without_message" }));
    });
    expect(повтор.error).toBe("unauthorized");
  });
});