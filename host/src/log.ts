// Логи хоста идут в stderr: launchd перенаправляет stdout/stderr в файлы,
// заданные в plist, поэтому отдельный файл дергать не нужно и при ручном
// запуске из терминала вывод остаётся в том же месте.
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export interface LogOptions {
  level?: LogLevel;
  /** Куда писать. По умолчанию stderr — его читает launchd. */
  sink?: (line: string) => void;
  /** Метка времени. В тестах подменяется, чтобы строки были сравнимы. */
  now?: () => Date;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLog(component: string, options: LogOptions = {}): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => void process.stderr.write(line + "\n"));
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    // Пишем построчно: одно поле с переводом строки порвало бы строку в journald/log.
    const head = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${message.replace(/\s+/g, " ").trim()}`;
    const rest = fields && Object.keys(fields).length > 0 ? " " + Object.entries(fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(" ") : "";
    sink(head + rest);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (sub) => createLog(`${component}/${sub}`, options),
  };
}