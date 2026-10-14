import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostClientOptions, HostClient } from "../src/client.js";
import { type HostMessage, PROTOCOL_VERSION } from "../src/protocol.js";
import { FakeGateway } from "./fakeGateway.js";
import { silentLog, testConfig, waitFor } from "./helpers.js";

describe("хост против фейкового шлюза", () => {
  let gateway: FakeGateway;
  let client: HostClient | undefined;
  let root: string;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-client-")));
    fs.mkdirSync(path.join(root, "Проекты", "TaskFlowNativeBuild"), { recursive: true });
    fs.writeFileSync(path.join(root, "Проекты", "TaskFlowNativeBuild", "Package.swift"), "let a = 1\n");
    gateway = await FakeGateway.start();
  });

  afterEach(async () => {
    await client?.stop();
    client = undefined;
    await gateway.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Поднимает хоста и дожидается, пока он станет онлайн. */
  async function startClient(overrides: Partial<HostClientOptions> = {}): Promise<HostClient> {
    const host = new HostClient({
      config: testConfig({ gatewayUrl: gateway.url, roots: [root] }),
      key: "ключ-машины-для-теста",
      log: silentLog(),
      hostname: "test-mac",
      platform: "darwin",
      ...overrides,
    });
    client = host;
    host.start();
    await host.whenReady();
    return host;
  }

  function socket(): WebSocket {
    const first = gateway.sockets[0];
    if (!first) throw new Error("шлюз не видит соединения хоста");
    return first;
  }

  it("подключается сам, шлёт ключ в приветствии и объявляет корни с операциями", async () => {
    await startClient();

    const hello = await gateway.waitForType("hello");
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.key).toBe("ключ-машины-для-теста");
    expect(hello.machineId).toBe("mac");
    expect(hello.platform).toBe("darwin");

    const register = await gateway.waitForType("register");
    expect(register.roots).toEqual([root]);
    expect(register.operations).toEqual(["bash", "read", "write", "edit", "grep", "find", "ls", "git_worktree"]);
  });

  it("выполняет операцию ls и отдаёт результат по opId", async () => {
    await startClient();
    gateway.send(socket(), { type: "call", opId: "вызов-1", op: "ls", args: { path: path.join(root, "Проекты/TaskFlowNativeBuild") } });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-1", "результат ls")) as Extract<HostMessage, { type: "result" }>;
    expect(result.ok).toBe(true);
    const data = result.data as { path: string; entries: Array<{ name: string }> };
    expect(data.path).toBe(path.join(root, "Проекты/TaskFlowNativeBuild"));
    expect(data.entries.map((entry) => entry.name)).toEqual(["Package.swift"]);
  });

  it("bash отдаёт вывод потоком, а в результате — код возврата и счётчики", async () => {
    await startClient();
    gateway.send(socket(), {
      type: "call",
      opId: "вызов-2",
      op: "bash",
      args: { command: "printf 'первая\\n'; printf 'вторая\\n'; exit 0" },
    });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-2", "результат bash")) as Extract<HostMessage, { type: "result" }>;
    expect(result.ok).toBe(true);
    expect((result.data as { exitCode: number }).exitCode).toBe(0);
    expect(gateway.streamFor("вызов-2").stdout).toBe("первая\nвторая\n");
  });

  it("отмена шлюзом доходит до команды и приходит результатом с cancelled", async () => {
    await startClient();
    gateway.send(socket(), { type: "call", opId: "вызов-3", op: "bash", args: { command: "echo начало; sleep 30" } });
    await gateway.waitFor((m) => m.type === "chunk" && m.opId === "вызов-3", "первый кусок вывода");

    gateway.send(socket(), { type: "cancel", opId: "вызов-3", reason: "роль передумала" });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-3", "результат после отмены")) as Extract<HostMessage, { type: "result" }>;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("cancelled");
    expect(gateway.streamFor("вызов-3").stdout).toContain("начало");
  });

  it("путь вне разрешённых корней отклоняется с path_denied", async () => {
    await startClient();
    gateway.send(socket(), { type: "call", opId: "вызов-4", op: "read", args: { path: "/etc/hosts" } });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-4", "результат отказа")) as Extract<HostMessage, { type: "result" }>;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("path_denied");
    expect(result.error?.message).toContain("вне разрешённых корней");
  });

  it("операция, которой хост не умеет, отклоняется как unknown_operation", async () => {
    await startClient();
    gateway.send(socket(), { type: "call", opId: "вызов-5", op: "deploy", args: {} });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-5", "результат неизвестной операции")) as Extract<HostMessage, { type: "result" }>;
    expect(result.error?.code).toBe("unknown_operation");
  });

  it("операция, выключенная шлюзом, не выполняется и файл не появляется", async () => {
    await gateway.stop();
    gateway = await FakeGateway.start({ acceptedOperations: ["bash", "ls"] });
    await startClient();

    gateway.send(socket(), { type: "call", opId: "вызов-6", op: "write", args: { path: path.join(root, "x"), content: "y" } });
    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вызов-6", "результат выключенной операции")) as Extract<HostMessage, { type: "result" }>;
    expect(result.error?.code).toBe("operation_disabled");
    expect(fs.existsSync(path.join(root, "x"))).toBe(false);
  });

  it("шлюз, не разрешивший ни одного корня, не оставляет хост готовым к работе", async () => {
    await gateway.stop();
    gateway = await FakeGateway.start({ acceptRoots: false });

    const host = new HostClient({
      config: testConfig({ gatewayUrl: gateway.url, roots: [root] }),
      key: "ключ-машины-для-теста",
      log: silentLog(),
    });
    client = host;
    host.start();

    await gateway.waitForType("register", "попытка зарегистрироваться");
    await waitFor(() => host.currentPhase !== "handshaking", 5_000, "хост снял рукопожатие");
    expect(host.currentPhase).not.toBe("ready");
  });

  it("после обрыва соединения хост сам переподключается и снова онлайн", async () => {
    const host = await startClient();
    const helloCountBefore = gateway.ofType("hello").length;

    gateway.dropConnections();
    await waitFor(() => gateway.ofType("hello").length > helloCountBefore, 10_000, "повторное приветствие");
    await waitFor(() => host.currentPhase === "ready", 10_000, "хост снова онлайн");
    expect(host.currentSession).toBe("сессия-1");
  });

  it("отказ по ключу не превращается в бесконечные попытки подключиться", async () => {
    await gateway.stop();
    gateway = await FakeGateway.start({ authorized: false });

    const host = new HostClient({
      config: testConfig({ gatewayUrl: gateway.url, roots: [root], reconnectMinMs: 20, reconnectMaxMs: 40 }),
      key: "неверный-ключ-машины",
      log: silentLog(),
    });
    client = host;
    host.start();

    await gateway.waitForType("hello", "первое приветствие");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(gateway.ofType("hello").length).toBe(1);
  });

  it("тишина в пингах обрывает канал и хост переподключается", async () => {
    await startClient();
    // Шлюз перестаёт отвечать на ping: тишина в два интервала означает мёртвый канал.
    const original = gateway.send.bind(gateway);
    (gateway as unknown as { send: (target: WebSocket, message: { type: string }) => void }).send = (target, message) => {
      if (message.type === "pong") return;
      original(target, message as never);
    };

    await waitFor(() => gateway.ofType("hello").length >= 2, 12_000, "переподключение после тишины в пингах");
  });

  it("слишком много одновременных операций — отказ, а не очередь", async () => {
    await gateway.stop();
    gateway = await FakeGateway.start();
    await startClient({ config: testConfig({ gatewayUrl: gateway.url, roots: [root], maxConcurrentOps: 1 }) });

    gateway.send(socket(), { type: "call", opId: "долгая", op: "bash", args: { command: "sleep 5" } });
    await waitFor(() => client?.inflightCount === 1, 5_000, "первая операция заняла место");
    gateway.send(socket(), { type: "call", opId: "вторая", op: "ls", args: { path: root } });

    const result = (await gateway.waitFor((m) => m.type === "result" && m.opId === "вторая", "отказ по занятости")) as Extract<HostMessage, { type: "result" }>;
    expect(result.error?.code).toBe("too_many_ops");

    gateway.send(socket(), { type: "cancel", opId: "долгая" });
  });
});