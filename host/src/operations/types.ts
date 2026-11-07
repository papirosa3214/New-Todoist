import type { StreamName } from "../protocol.js";

/** Аргументы пришли не те — операция их не понимает. */
export class BadArgsError extends Error {
  readonly code = "bad_args";
  constructor(message: string) {
    super(message);
    this.name = "BadArgsError";
  }
}

/** Шлюз попросил отменить операцию (или соединение с ним оборвалось). */
export class CancelledError extends Error {
  readonly code = "cancelled";
  constructor(message = "операция отменена") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Команда не уложилась в отведённое время — по образцу builderXcode.ts. */
export class TimeoutError extends Error {
  readonly code = "timeout";
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Операция упёрлась в потолок (4 МБ вывода у bash) и была прервана. */
export class LimitError extends Error {
  readonly code = "limit_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export interface OperationLimits {
  /** Потолок времени bash — 600 с, как в builderXcode.ts. */
  bashTimeoutMs: number;
  /** Потолок вывода bash — 4 МБ, как в builderXcode.ts. */
  bashOutputLimitBytes: number;
}

/**
 * Всё, что операция знает о вызове. `roots` — уже отфильтрованные шлюзом
 * корни (D6/D4), поэтому операция проверяет путь ещё раз сама, но уже по
 * фактическому разрешению, а не по заявленному на входе.
 */
export interface OperationContext {
  roots: string[];
  worktreesBase: string;
  limits: OperationLimits;
  /** Куда уходит поток вывода: клиент оборачивает это в сообщения `chunk`. */
  emit(stream: StreamName, text: string): void;
  signal: AbortSignal;
  now(): number;
}

export type Operation = (args: Record<string, unknown>, context: OperationContext) => Promise<unknown>;

// ───────────────────────── разбор аргументов ─────────────────────────

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new BadArgsError(`«${key}» обязателен и должен быть строкой`);
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadArgsError(`«${key}» должен быть строкой`);
  return value;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BadArgsError(`«${key}» должен быть числом`);
  if (bounds.min !== undefined && value < bounds.min) throw new BadArgsError(`«${key}» меньше ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) throw new BadArgsError(`«${key}» больше ${bounds.max}`);
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new BadArgsError(`«${key}» должен быть true или false`);
  return value;
}

export class NotFoundError extends Error {
  readonly code = "not_found";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}