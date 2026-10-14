// Протокол «хост ↔ шлюз» (тикет 1 — серверная половина, тикет 2 — хост).
//
// ВНИМАНИЕ, ВРЕМЕННЫЙ ФАЙЛ: по условию тикета 1 общий модуль описания
// сообщений кладёт серверная половина и называет путь и имя экспорта. До этого
// момента здесь лежит локальная копия контракта, написанная по плану:
// приветствие с ключом → онлайн+корни → вызов операции → поток → отмена →
// результат/ошибка → пинг. Когда модуль тикета 1 появится, достаточно заменить
// импорт в client.ts и operations/index.ts — форма сообщений совпадать должна,
// расхождения по именам полей чинятся здесь точечно.
//
// Все сообщения — JSON-текст в одном кадре WebSocket. Поток вывода идёт
// отдельными сообщениями `chunk`, а не одним большим результатом: сборка Xcode
// идёт минутами и должна быть видна по мере поступления.

export const PROTOCOL_VERSION = 1;

/** Операции, которые хост умеет выполнять. Набор совпадает с планом (тикет 2). */
export const OP_NAMES = ["bash", "read", "write", "edit", "grep", "find", "ls", "git_worktree"] as const;
export type OpName = (typeof OP_NAMES)[number];

export type StreamName = "stdout" | "stderr";

/** Коды ошибок. Шлюз показывает их пользователю, поэтому тексты на русском. */
export type ProtocolErrorCode =
  | "unauthorized"
  | "protocol_mismatch"
  | "unknown_operation"
  | "operation_disabled"
  | "too_many_ops"
  | "path_denied"
  | "bad_args"
  | "not_found"
  | "conflict"
  | "limit_exceeded"
  | "cancelled"
  | "timeout"
  | "internal";

// ───────────────────────── сообщения хоста → шлюзу ─────────────────────────

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  /** Ключ машины из Keychain. Шлюз сверяет хэш с реестром (D4, D7). */
  key: string;
  machineId: string;
  hostVersion: string;
  platform: string;
  hostname: string;
  pid: number;
}

/** Хост называет свои корни и версию — шлюз отвечает, какие из корней разрешены. */
export interface RegisterMessage {
  type: "register";
  machineId: string;
  hostVersion: string;
  platform: string;
  hostname: string;
  roots: string[];
  operations: OpName[];
}

export interface ChunkMessage {
  type: "chunk";
  opId: string;
  stream: StreamName;
  text: string;
}

export interface ResultMessage {
  type: "result";
  opId: string;
  ok: boolean;
  data?: unknown;
  error?: ProtocolError;
}

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  /** Свободное поле для деталей (код возврата, путь, имя операции). */
  detail?: Record<string, unknown>;
}

export interface PingMessage {
  type: "ping";
  /** Время отправки в мс — шлюз отвечает тем же значением, хост считает RTT. */
  at: number;
}

export interface PongMessage {
  type: "pong";
  at: number;
}

export type HostMessage = HelloMessage | RegisterMessage | ChunkMessage | ResultMessage | PingMessage | PongMessage;

// ───────────────────────── сообщения шлюза → хосту ─────────────────────────

export interface WelcomeMessage {
  type: "welcome";
  sessionId: string;
  protocolVersion: number;
  /** Интервал пинга, который шлюз хочет видеть. */
  heartbeatMs?: number;
}

export interface RegisteredMessage {
  type: "registered";
  sessionId: string;
  /** Корни, которые шлюз реально разрешил — работаем только с ними. */
  acceptedRoots: string[];
  /** Подмножество возможностей, которое шлюз разрешил этой машине. */
  acceptedOperations?: OpName[];
  heartbeatMs?: number;
}

export interface CallMessage {
  type: "call";
  opId: string;
  op: OpName | string;
  args?: Record<string, unknown>;
}

export interface CancelMessage {
  type: "cancel";
  opId: string;
  /** Причина — попадает в текст ошибки операции. */
  reason?: string;
}

/** Шлюз отверг хост: ключ не тот, версия протокола не та, машина отозвана. */
export interface RejectMessage {
  type: "reject";
  code: ProtocolErrorCode;
  message: string;
}

export type GatewayMessage = WelcomeMessage | RegisteredMessage | CallMessage | CancelMessage | RejectMessage | PingMessage | PongMessage;

// ───────────────────────── разбор сообщений ─────────────────────────

export class ProtocolError_ extends Error {}

export type ParseResult = { ok: true; message: GatewayMessage } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Разбор кадра от шлюза. Всё, чего мы не понимаем, — не повод рвать соединение:
 * шлюз может прислать поле, которого в копии протокола ещё нет, поэтому
 * неизвестный `type` пропускаем, а невалидный `call` — отклоняем явно.
 */
export function parseGatewayMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "кадр не разобран как JSON" };
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") return { ok: false, error: "в кадре нет строкового поля type" };

  const type = parsed["type"];
  switch (type) {
    case "welcome":
    case "registered":
    case "call":
    case "cancel":
    case "reject":
    case "ping":
    case "pong":
      return { ok: true, message: parsed as unknown as GatewayMessage };
    default:
      return { ok: true, message: parsed as unknown as GatewayMessage };
  }
}

export function encode(message: HostMessage | GatewayMessage): string {
  return JSON.stringify(message);
}

/** Операция, о которой шлюз просит, но которой нет в наборе хоста. */
export function isOpName(value: unknown): value is OpName {
  return typeof value === "string" && (OP_NAMES as readonly string[]).includes(value);
}