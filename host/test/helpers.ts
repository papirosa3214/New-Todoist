import { createLog } from "../src/log.js";
import type { HostConfig } from "../src/config.js";
import type { OperationContext } from "../src/operations/types.js";
import type { StreamName } from "../src/protocol.js";

/** Лог, который не пишет в stderr: иначе вывод тестов превращается в кашу. */
export function silentLog() {
  return createLog("test", { sink: () => {} });
}

/** Контекст операции для тестов: корни — временная папка, лимиты маленькие. */
export function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    roots: [],
    worktreesBase: "",
    limits: { bashTimeoutMs: 8_000, bashOutputLimitBytes: 64 * 1024 },
    emit: () => {},
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

/** Собирает поток операции в строки, чтобы проверить, что он не потерялся. */
export function collectStream(): { emit: (stream: StreamName, text: string) => void; text: (stream?: StreamName) => string; count: number } {
  const parts: Record<StreamName, string[]> = { stdout: [], stderr: [] };
  let count = 0;
  return {
    emit(stream, text) {
      parts[stream].push(text);
      count += 1;
    },
    text(stream = "stdout") {
      return parts[stream].join("");
    },
    get count() {
      return count;
    },
  };
}

export function testConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    gatewayUrl: "ws://127.0.0.1:1/host",
    machineId: "mac",
    roots: [],
    worktreesBase: "",
    keychainService: "taskflow-host",
    keychainAccount: "mac",
    heartbeatMs: 1_000,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    handshakeTimeoutMs: 3_000,
    bashTimeoutMs: 8_000,
    bashOutputLimitBytes: 64 * 1024,
    maxConcurrentOps: 4,
    logLevel: "error",
    ...overrides,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ждёт выполнения условия. Тесты с сокетами иначе флакают по таймингу. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "условие"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`не дождались: ${label} (${timeoutMs} мс)`);
}