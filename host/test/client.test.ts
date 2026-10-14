import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostClient } from "../src/client.js";
import { FakeGateway } from "./fakeGateway.js";
import { silentLog, sleep, testConfig, waitFor } from "./helpers.js";

const KEY = "tfh_тестовый-ключ";

// Корень операций — временная папка, а не /Users/max. Тесты обязаны идти на
// обеих машинах, а /Users/max существует только на маке: на .110 операция с
// таким путём честно отказывает с path_denied, и проверка падает не по делу.
let корень: string;
beforeAll(() => {
  корень = mkdtempSync(path.join(tmpdir(), "taskflow-host-"));
});
afterAll(() => {
  rmSync(корень, { recursive: true, force: true });
});

async function startHost(
  gateway: FakeGateway,
  overrides: Parameters<typeof testConfig>[0] = {},
  operations?: Record<string, never>,
): Promise<HostClient> {
  const client = new HostClient({
    config: testConfig({ gatewayUrl: gateway.url, roots: [корень], ...overrides }),
    key: KEY,
    log: silentLog(),
    ...(operations ? { operations } : {}),
  });
  client.start();
  return client;
}

describe("хост против фейкового шлюза", () => {
  it("ключ уходит в адрес подключения, а не в приветствие", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    // Ключ обязан быть в query: сервер проверяет его в обработчике подключения,
    // до первого кадра, и по нему определяет машину.
    expect(gateway.keysSeen[0]).toBe(KEY);

    const hello = gateway.ofType("hello")[0];
    expect(hello).toBeDefined();
    // В приветствии ключа быть НЕ должно — сервер такого поля не читает.
    expect(JSON.stringify(hello ?? {})).not.toContain(KEY);

    await client.stop();
    await gateway.stop();
  });

  it("приветствие несёт корни и версию хоста", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    const hello = gateway.ofType("hello")[0];
    expect(hello?.roots).toEqual([корень]);
    expect(hello?.protocolVersion).toBe(1);
    expect(typeof hello?.hostVersion).toBe("string");

    await client.stop();
    await gateway.stop();
  });

  it("рукопожатие двухшаговое: сначала welcome, потом наш hello и второй welcome", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    // Хост обязан быть готов только после hello: без него сервер корни ещё не
    // согласовал, и работать негде.
    expect(gateway.received[0]?.type).toBe("hello");

    await client.stop();
    await gateway.stop();
  });

  it("шлюз не разрешил ни одного корня — хост не становится готовым", async () => {
    const gateway = await FakeGateway.start({ allowedRoots: [] });
    const client = await startHost(gateway);

    await waitFor(() => client.currentPhase === "connecting", 3_000, "хост не готов после пустых корней");
    expect(client.roots).toEqual([корень]); // заявленные, но не согласованные

    await client.stop();
    await gateway.stop();
  });

  it("выполняет операцию ls и отдаёт результат по opId", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-1", "ls", { path: корень });
    const result = await gateway.waitForType("op_result", "результат ls");
    expect(result.opId).toBe("оп-1");
    expect(result.ok).toBe(true);

    await client.stop();
    await gateway.stop();
  });

  it("поток вывода приходит кадрами op_chunk с полем data", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-2", "bash", { command: "printf привет" });
    const result = await gateway.waitForType("op_result", "результат bash");
    expect(result.opId).toBe("оп-2");

    const поток = gateway.streamFor("оп-2");
    expect(поток.stdout).toContain("привет");

    // Имя кадра и имя поля — ровно те, что читает сервер в deliverChunk.
    const кадры = gateway.received.filter((m) => m.type === "op_chunk");
    expect(кадры.length).toBeGreaterThan(0);
    expect((кадры[0] as { data?: unknown }).data).toBeDefined();

    await client.stop();
    await gateway.stop();
  });

  it("результат несёт exitCode, а не только data", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-3", "bash", { command: "exit 3" });
    const result = await gateway.waitForType("op_result", "результат bash");
    expect(result.ok).toBe(true);
    // Ненулевой код — это данные, а не ошибка: роль читает его сама.
    expect((result as { exitCode?: number }).exitCode).toBe(3);

    await client.stop();
    await gateway.stop();
  });

  it("отмена шлюзом доходит до команды и приходит результатом с cancelled", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-4", "bash", { command: "sleep 30" });
    await waitFor(() => client.inflightCount === 1, 3_000, "операция не запустилась");
    gateway.cancelOp("оп-4");

    const result = await gateway.waitForType("op_result", "результат отменённой операции");
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("cancelled");

    await client.stop();
    await gateway.stop();
  });

  it("путь вне разрешённых корней отклоняется с path_denied", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-5", "read", { path: "/etc/passwd" });
    const result = await gateway.waitForType("op_result", "результат чтения вне корня");
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("path_denied");

    await client.stop();
    await gateway.stop();
  });

  it("операция, которой хост не умеет, отклоняется", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.callOp("оп-6", "взорвать", {});
    const result = await gateway.waitForType("op_result", "результат неизвестной операции");
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toContain("взорвать");

    await client.stop();
    await gateway.stop();
  });

  it("после обрыва соединения хост сам переподключается и снова онлайн", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    // Считаем ПОПЫТКИ подключения, а не живые сокеты: обрыв делает terminate(),
    // и старый сокет выпадает из sockets раньше, чем успевает прийти новый.
    // По connectionCount здесь легко промахнуться на одну и не заметить.
    const было = gateway.keysSeen.length;
    gateway.dropConnections();
    await waitFor(() => gateway.keysSeen.length > было, 5_000, "хост не переподключился");
    await waitFor(() => client.currentPhase === "ready", 5_000, "хост снова не готов");

    await client.stop();
    await gateway.stop();
  });

  it("отказ по ключу не превращается в бесконечные попытки подключаться", async () => {
    const gateway = await FakeGateway.start({ authorized: false });
    const client = await startHost(gateway);

    // Шлюз отвечает error и закрывает сокет. Хост не должен считать это
    // «обрывом» и не должен стучаться снова тем же ключом раз за разом.
    // Считаем ПОПЫТКИ подключения, а не живые сокеты: отказавшийся сокет сразу
    // закрывается, и connectionCount вернулся бы в ноль независимо от того,
    // хост переподключается или нет.
    await waitFor(() => gateway.keysSeen.length > 0, 3_000, "хост не подключился вовсе");
    const было = gateway.keysSeen.length;
    await sleep(800);
    expect(gateway.keysSeen.length).toBe(было);

    await client.stop();
    await gateway.stop();
  });

  it("слишком много одновременных операций — отказ, а не очередь", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway, { maxConcurrentOps: 1 });
    await client.whenReady();

    gateway.callOp("первая", "bash", { command: "sleep 5" });
    await waitFor(() => client.inflightCount === 1, 3_000, "первая операция не пошла");
    gateway.callOp("вторая", "ls", { path: корень });

    const result = await gateway.waitForType("op_result", "отказ по лимиту операций");
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toContain("операций");

    await client.stop();
    await gateway.stop();
  });

  it("на ping шлюза хост отвечает pong", async () => {
    const gateway = await FakeGateway.start();
    const client = await startHost(gateway);
    await client.whenReady();

    gateway.broadcast({ type: "ping" });
    const pong = await gateway.waitForType("pong", "ответ на ping");
    expect(pong).toBeDefined();

    await client.stop();
    await gateway.stop();
  });

  it("шлюз, не ответивший на hello вторым welcome, роняет рукопожатие по таймауту", async () => {
    const gateway = await FakeGateway.start({ silentOnHello: true });
    const client = new HostClient({
      config: testConfig({ gatewayUrl: gateway.url, roots: ["/Users/max"], handshakeTimeoutMs: 300 }),
      key: KEY,
      log: silentLog(),
    });
    client.start();

    await waitFor(() => client.currentPhase === "connecting", 3_000, "хост не откатился после таймаута");
    expect(client.currentPhase).not.toBe("ready");

    await client.stop();
    await gateway.stop();
  });
});