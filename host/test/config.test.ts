import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, type HostConfigLayer, argLayer, configPath, describeConfig, envLayer, fileLayer, loadConfig, resolveConfig } from "../src/config.js";
import { envKeyReader, KeychainError, macKeychainReader } from "../src/keychain.js";

describe("конфигурация хоста", () => {
  it("требует адрес шлюза", () => {
    expect(() => resolveConfig([])).toThrow(ConfigError);
    expect(() => resolveConfig([])).toThrow(/gatewayUrl/);
  });

  it("проверяет схему адреса", () => {
    expect(() => resolveConfig([{ gatewayUrl: "http://192.168.1.110:5180" }])).toThrow(/ws:\/\/ или wss:\/\//);
    expect(() => resolveConfig([{ gatewayUrl: "не адрес" }])).toThrow(ConfigError);
  });

  it("на маке корнем по умолчанию будет домашняя папка (D6)", () => {
    expect(resolveConfig([{ gatewayUrl: "ws://127.0.0.1:5181/host" }]).roots).toEqual([os.homedir()]);
  });

  it("лимиты bash по умолчанию — как в builderXcode.ts", () => {
    const config = resolveConfig([{ gatewayUrl: "ws://127.0.0.1:5181/host" }]);
    expect(config.bashTimeoutMs).toBe(600_000);
    expect(config.bashOutputLimitBytes).toBe(4 * 1024 * 1024);
  });

  it("слои перекрывают друг друга по порядку", () => {
    const config = resolveConfig([
      { gatewayUrl: "ws://из-файла/host", machineId: "из-файла" },
      { machineId: "из-окружения" },
      { machineId: "из-аргументов" },
    ]);
    expect(config.gatewayUrl).toBe("ws://из-файла/host");
    expect(config.machineId).toBe("из-аргументов");
  });

  it("roots принимаются списком и строкой", () => {
    expect(resolveConfig([{ gatewayUrl: "ws://x/host", roots: ["/a", "/b"] }]).roots).toEqual(["/a", "/b"]);
    expect(resolveConfig([{ gatewayUrl: "ws://x/host", roots: "/a:/b" }]).roots).toEqual(["/a", "/b"]);
  });

  it("пустой roots и не число — ошибка с указанием поля", () => {
    expect(() => resolveConfig([{ gatewayUrl: "ws://x/host", roots: [] }])).toThrow(/roots/);
    expect(() => resolveConfig([{ gatewayUrl: "ws://x/host", heartbeatMs: "быстро" }])).toThrow(/heartbeatMs/);
    expect(() => resolveConfig([{ gatewayUrl: "ws://x/host", logLevel: "громко" }])).toThrow(/logLevel/);
  });

  it("согласованность пауз переподключения проверяется", () => {
    expect(() => resolveConfig([{ gatewayUrl: "ws://x/host", reconnectMinMs: 5_000, reconnectMaxMs: 1_000 }])).toThrow(/reconnectMaxMs/);
  });

  it("флаг без значения — ошибка, а не тихое игнорирование", () => {
    expect(() => argLayer(["--machine-id"])).toThrow(/требует значения/);
  });

  it("путь конфига: флаг > окружение > стандартное место", () => {
    expect(configPath(["--config=/tmp/из-флага.json"], {})).toBe("/tmp/из-флага.json");
    expect(configPath([], { TASKFLOW_HOST_CONFIG: "/tmp/из-окружения.json" })).toBe("/tmp/из-окружения.json");
    expect(configPath([], {})).toBe(path.join(os.homedir(), ".config", "taskflow-host", "config.json"));
  });

  it("показ конфигурации не выводит секрет", () => {
    const text = describeConfig(resolveConfig([{ gatewayUrl: "ws://x/host" }]));
    expect(text).toContain("gatewayUrl");
    // В HostConfig поля ключа нет вовсе, значит и в выводе быть не может.
    expect(text.split("\n").map((line) => line.split("=")[0]!.trim())).not.toContain("key");
    expect(text).not.toMatch(/^key\s*=/m);
  });

  it("ключ, подложенный в файл конфига, игнорируется и не попадает в разбор", () => {
    // Config.json пишет человек: лишние поля там возможны, и разбор обязан их
    // пережить молча, а не тащить дальше по коду.
    const config = resolveConfig([{ gatewayUrl: "ws://x/host", key: "секрет-из-файла" } as HostConfigLayer]);
    expect(describeConfig(config)).not.toContain("секрет-из-файла");
    expect(Object.keys(config)).not.toContain("key");
  });

  describe("файлы и окружение", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-host-config-"));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("читает JSON-файл конфига", () => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ gatewayUrl: "ws://192.168.1.110:5181/host", machineId: "mac" }));
      expect(fileLayer(file)).toEqual({ gatewayUrl: "ws://192.168.1.110:5181/host", machineId: "mac" });
    });

    it("битый JSON — понятная ошибка, а не пустой конфиг", () => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, "{ не json");
      expect(() => fileLayer(file)).toThrow(/не разобран/);
    });

    it("отсутствующий файл — не ошибка", () => {
      expect(fileLayer(path.join(dir, "нет.json"))).toBeUndefined();
    });

    it("переменные окружения читаются", () => {
      const layer = envLayer({ TASKFLOW_HOST_GATEWAY_URL: "ws://из-окружения/host", TASKFLOW_HOST_BASH_TIMEOUT_MS: "1000" });
      expect(layer).toEqual({ gatewayUrl: "ws://из-окружения/host", bashTimeoutMs: "1000" });
    });

    it("пустые переменные считаются незаданными", () => {
      expect(envLayer({ TASKFLOW_HOST_MACHINE_ID: "   " })).toBeUndefined();
    });

    it("loadConfig сводит файл, окружение и аргументы", () => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ gatewayUrl: "ws://из-файла/host", machineId: "из-файла" }));
      const config = loadConfig([], { TASKFLOW_HOST_CONFIG: file });
      expect(config.gatewayUrl).toBe("ws://из-файла/host");
      expect(config.machineId).toBe("из-файла");
    });
  });
});

describe("ключ машины (D7)", () => {
  it("читается из Keychain через security", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const reader = macKeychainReader({
      service: "taskflow-host",
      account: "mac",
      exec: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: "ключ-машины-достаточный\n", stderr: "" };
      },
    });

    expect(await reader.read()).toBe("ключ-машины-достаточный");
    expect(calls[0]?.file).toBe("security");
    expect(calls[0]?.args).toEqual(["find-generic-password", "-a", "mac", "-s", "taskflow-host", "-w"]);
  });

  it("отсутствующая запись Keychain — понятная ошибка, а не пустой ключ", async () => {
    const reader = macKeychainReader({
      service: "taskflow-host",
      account: "mac",
      exec: async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found" }),
    });
    await expect(reader.read()).rejects.toBeInstanceOf(KeychainError);
    await expect(reader.read()).rejects.toThrow(/install-keychain\.sh/);
  });

  it("слишком короткий ключ отвергается", async () => {
    const reader = macKeychainReader({ service: "s", account: "a", exec: async () => ({ code: 0, stdout: "коротко", stderr: "" }) });
    await expect(reader.read()).rejects.toThrow(/короче/);
  });

  it("ключ из окружения берётся только при явном разрешении", async () => {
    await expect(envKeyReader("КЛЮЧ", 4, { КЛЮЧ: "abcd" }).read()).resolves.toBe("abcd");
    await expect(envKeyReader("НЕТ", 4, {}).read()).rejects.toBeInstanceOf(KeychainError);
  });
});