import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogLevel } from "./log.js";

/**
 * Конфигурация хоста. Собирается из трёх слоёв, каждый перекрывает предыдущий:
 *   1) значения по умолчанию ниже,
 *   2) JSON-файл (по умолчанию ~/.config/taskflow-host/config.json),
 *   3) переменные окружения TASKFLOW_HOST_* и флаги командной строки.
 * Файл — единственное, что переживает перезапуск демона; ключа в нём нет (D7).
 */
export interface HostConfig {
  /** WebSocket-шлюз на .110. Точка подключения — единственное, что меняется при смене порта. */
  gatewayUrl: string;
  /** Идентификатор машины в реестре (D4). На маке — "mac". */
  machineId: string;
  /** Разрешённые корни (D6). Всё, что операция трогает, должно лежать внутри одного из них. */
  roots: string[];
  /** Базовый каталог для worktree ролей — образец worktreesBase() из roleWorkspace.ts. */
  worktreesBase: string;
  /** Служба и учётка в Keychain мака, где лежит ключ (D7). */
  keychainService: string;
  keychainAccount: string;
  /** Интервал пинга. Шлюз считает машину офлайн, если пингов нет дольше двух интервалов. */
  heartbeatMs: number;
  /** Пауза перед первой попыткой переподключения и её потолок: сон мака и смена Wi-Fi дают разные задержки. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** Сколько ждеть ответа шлюза на приветствие, прежде чем считать соединение мёртвым. */
  handshakeTimeoutMs: number;
  /** Потолок для bash — как в builderXcode.ts, где таймаут 600 с. */
  bashTimeoutMs: number;
  /** Потолок вывода bash — как в builderXcode.ts: 4 МБ, дальше процесс убивается. */
  bashOutputLimitBytes: number;
  /** Сколько операций одновременно держит хост. Роль зовёт инструменты по одному, потолок — страховка от залипания шлюза. */
  maxConcurrentOps: number;
  logLevel: LogLevel;
}

// Слой приходит из файла, окружения или аргументов — то есть из непроверенного
// источника. Поэтому значения здесь любые: разбирает и проверяет их resolveConfig.
export type HostConfigLayer = { [K in keyof HostConfig]?: unknown };

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "taskflow-host", "config.json");

/** На маке os.homedir() — это /Users/max, то есть ровно корень из D6. */
export function defaultRoots(): string[] {
  return [os.homedir()];
}

export function defaultConfig(): HostConfig {
  return {
    gatewayUrl: "",
    machineId: "mac",
    roots: defaultRoots(),
    worktreesBase: path.join(os.homedir(), ".local", "state", "taskflow-runs", "worktrees"),
    keychainService: "taskflow-host",
    keychainAccount: "mac",
    heartbeatMs: 30_000,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000,
    handshakeTimeoutMs: 20_000,
    bashTimeoutMs: 600_000,
    bashOutputLimitBytes: 4 * 1024 * 1024,
    maxConcurrentOps: 8,
    logLevel: "info",
  };
}

export class ConfigError extends Error {}

function readNumber(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${field}: ожидалось положительное число, получено «${String(value)}»`);
  return n;
}

function readLogLevel(value: unknown, field: string): LogLevel {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  if (typeof value !== "string" || !levels.includes(value as LogLevel)) {
    throw new ConfigError(`${field}: ожидалось одно из ${levels.join(", ")}, получено «${String(value)}»`);
  }
  return value as LogLevel;
}

function readRoots(value: unknown): string[] {
  const parts = (Array.isArray(value) ? value : String(value).split(/[:,]/))
    .map((part) => String(part).trim())
    .filter(Boolean);
  if (parts.length === 0) throw new ConfigError("roots: нужен хотя бы один разрешённый корень");
  return parts.map((part) => (part.startsWith("~") ? path.join(os.homedir(), part.slice(1)) : part));
}

const NUMBER_FIELDS = [
  "heartbeatMs",
  "reconnectMinMs",
  "reconnectMaxMs",
  "handshakeTimeoutMs",
  "bashTimeoutMs",
  "bashOutputLimitBytes",
  "maxConcurrentOps",
] as const;

/**
 * Сводит слои в один конфиг и проверяет его. Бросает ConfigError с понятным
 * текстом: демон запускает launchd, и молчаливый откат на умолчания означал бы
 * хост, подключившийся не туда.
 */
export function resolveConfig(layers: Array<HostConfigLayer | undefined>): HostConfig {
  const base = defaultConfig();
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value;
    }
  }

  const config = { ...base } as HostConfig & { logLevel: LogLevel };
  if (typeof merged["gatewayUrl"] === "string") config.gatewayUrl = merged["gatewayUrl"].trim();
  if (typeof merged["machineId"] === "string" && merged["machineId"].trim()) config.machineId = merged["machineId"].trim();
  if (merged["roots"] !== undefined) config.roots = readRoots(merged["roots"]);
  if (typeof merged["worktreesBase"] === "string" && merged["worktreesBase"].trim()) {
    config.worktreesBase = path.resolve(merged["worktreesBase"].trim());
  }
  if (typeof merged["keychainService"] === "string" && merged["keychainService"].trim()) config.keychainService = merged["keychainService"].trim();
  if (typeof merged["keychainAccount"] === "string" && merged["keychainAccount"].trim()) config.keychainAccount = merged["keychainAccount"].trim();
  for (const field of NUMBER_FIELDS) {
    if (merged[field] !== undefined) config[field] = readNumber(merged[field], field);
  }
  if (merged["logLevel"] !== undefined) config.logLevel = readLogLevel(merged["logLevel"], "logLevel");

  if (!config.gatewayUrl) throw new ConfigError("gatewayUrl: не задан. Пропиши его в конфиге или TASKFLOW_HOST_GATEWAY_URL — без него хосту некуда подключаться");
  let parsed: URL;
  try {
    parsed = new URL(config.gatewayUrl);
  } catch {
    throw new ConfigError(`gatewayUrl: «${config.gatewayUrl}» не похоже на адрес`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new ConfigError(`gatewayUrl: нужен ws:// или wss://, получено «${parsed.protocol}»`);
  if (config.reconnectMaxMs < config.reconnectMinMs) throw new ConfigError("reconnectMaxMs меньше reconnectMinMs — пауза переподключения не сойдётся");
  return config;
}

/** Слой из переменных окружения. Пустые строки считаются «не задано». */
export function envLayer(env: NodeJS.ProcessEnv = process.env): HostConfigLayer | undefined {
  const layer: HostConfigLayer = {};
  const set = <K extends keyof HostConfigLayer>(key: K, value: string | undefined) => {
    if (value !== undefined && value.trim() !== "") layer[key] = value.trim() as never;
  };
  set("gatewayUrl", env["TASKFLOW_HOST_GATEWAY_URL"]);
  set("machineId", env["TASKFLOW_HOST_MACHINE_ID"]);
  set("roots", env["TASKFLOW_HOST_ROOTS"]);
  set("worktreesBase", env["TASKFLOW_HOST_WORKTREES_BASE"]);
  set("keychainService", env["TASKFLOW_HOST_KEYCHAIN_SERVICE"]);
  set("keychainAccount", env["TASKFLOW_HOST_KEYCHAIN_ACCOUNT"]);
  set("logLevel", env["TASKFLOW_HOST_LOG_LEVEL"]);
  const numbers: Record<string, string | undefined> = {
    heartbeatMs: env["TASKFLOW_HOST_HEARTBEAT_MS"],
    reconnectMinMs: env["TASKFLOW_HOST_RECONNECT_MIN_MS"],
    reconnectMaxMs: env["TASKFLOW_HOST_RECONNECT_MAX_MS"],
    handshakeTimeoutMs: env["TASKFLOW_HOST_HANDSHAKE_TIMEOUT_MS"],
    bashTimeoutMs: env["TASKFLOW_HOST_BASH_TIMEOUT_MS"],
    bashOutputLimitBytes: env["TASKFLOW_HOST_BASH_OUTPUT_LIMIT_BYTES"],
    maxConcurrentOps: env["TASKFLOW_HOST_MAX_CONCURRENT_OPS"],
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (value !== undefined && value.trim() !== "") layer[key as keyof HostConfigLayer] = value.trim() as never;
  }
  return Object.keys(layer).length > 0 ? layer : undefined;
}

/** Слой из файла. Отсутствующий файл — не ошибка: конфиг может целиком прийти из окружения. */
export function fileLayer(configPath: string): HostConfigLayer | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ConfigError(`не читается конфиг ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ожидался объект JSON");
    return parsed as HostConfigLayer;
  } catch (error) {
    throw new ConfigError(`конфиг ${configPath} не разобран: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Слой из аргументов командной строки: `--gateway-url=ws://…`, `--roots=/Users/max`. */
export function argLayer(argv: string[] = process.argv.slice(2)): HostConfigLayer | undefined {
  const layer: HostConfigLayer = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const key = match[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = match[2];
    if (value === undefined) throw new ConfigError(`флаг --${match[1]} требует значения, например --${match[1]}=…`);
    (layer as Record<string, unknown>)[key] = value;
  }
  return Object.keys(layer).length > 0 ? layer : undefined;
}

/** Путь конфига: явный флаг > переменная окружения > стандартное место. */
export function configPath(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): string {
  const explicit = argv.find((arg) => arg.startsWith("--config="))?.slice("--config=".length);
  return explicit || env["TASKFLOW_HOST_CONFIG"]?.trim() || DEFAULT_CONFIG_PATH;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): HostConfig {
  return resolveConfig([fileLayer(configPath(argv, env)), envLayer(env), argLayer(argv)]);
}

/** Настройки для показа без ключа: `--print-config` и проверка установки. */
export function describeConfig(config: HostConfig): string {
  const rows: Array<[string, string]> = [
    ["gatewayUrl", config.gatewayUrl],
    ["machineId", config.machineId],
    ["roots", config.roots.join(", ")],
    ["worktreesBase", config.worktreesBase],
    ["keychainService", config.keychainService],
    ["keychainAccount", config.keychainAccount],
    ["heartbeatMs", String(config.heartbeatMs)],
    ["reconnectMinMs", String(config.reconnectMinMs)],
    ["reconnectMaxMs", String(config.reconnectMaxMs)],
    ["bashTimeoutMs", String(config.bashTimeoutMs)],
    ["bashOutputLimitBytes", String(config.bashOutputLimitBytes)],
    ["maxConcurrentOps", String(config.maxConcurrentOps)],
    ["logLevel", config.logLevel],
  ];
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${key.padEnd(width)} = ${value}`).join("\n");
}