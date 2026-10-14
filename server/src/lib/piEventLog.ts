// Лог между нашим кодом и Pi SDK. MAK-75 пункт 1а.
//
// Зачем: 05.10 в 23:59 три запуска ушли в 429 у провайдера, таблица
// provider_limits осталась пустой, карточки висели. Причина — не поймана:
// ни один слой не смотрел, ЧТО именно вернул Pi. Этот файл — та точка
// между нашим кодом и SDK, где видно всё, что Pi говорит наружу,
// включая stopReason/errorMessage с кодом 429.
//
// Ничего не решает и ни на что не влияет: только пишет в файл. Файл —
// единственный источник правды о том, что реально прислал SDK.
//
// Включение: PI_EVENT_LOG=1 (путь переопределяется PI_EVENT_LOG_PATH).
// По умолчанию выключен, чтобы не жечь диск на живых сервисах.

import fs from "node:fs";
import path from "node:path";

const ENABLED = process.env.PI_EVENT_LOG === "1";

/** Коды, ради которых лог и затевался: провайдер упёрся в лимит. */
const LIMIT_PATTERNS = [/\b429\b/, /rate[ _-]?limit/i, /too many requests/i, /quota/i];

function logFilePath(): string {
  const override = process.env.PI_EVENT_LOG_PATH?.trim();
  if (override) return override;
  return path.join(process.cwd(), "logs", "pi-events.log");
}

/** Обрезать, чтобы одно простырное тело ответа не съело диск. */
function clip(value: unknown, max = 2000): unknown {
  if (typeof value === "string") {
    return value.length > max
      ? `${value.slice(0, max)}…[обрезано ${value.length - max}]`
      : value;
  }
  return value;
}

/** Плоские поля события — то, что нужно для разбора, без вложенных простыней. */
function summarize(event: { type: string; [k: string]: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: event.type,
    ts: new Date().toISOString(),
  };
  for (const key of [
    "sessionId",
    "runId",
    "stopReason",
    "errorMessage",
    "finalError",
    "willRetry",
    "success",
    "model",
    "provider",
    "retryCount",
    "reason",
  ]) {
    if (event[key] !== undefined) out[key] = clip(event[key]);
  }
  // messages нужны для разбора хода: именно в них лежит errorMessage.
  if (Array.isArray(event.messages)) {
    out.messages = clip(JSON.stringify(event.messages), 4000);
  }
  return out;
}

/** Есть ли в событии признак лимита провайдера. */
export function isProviderLimitSignal(event: unknown): boolean {
  const text = typeof event === "string" ? event : JSON.stringify(event ?? "");
  if (!text) return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Пишет событие Pi в лог. Молча выключена, если PI_EVENT_LOG не задан. */
export function logPiEvent(
  taskId: string | null,
  event: { type: string; [k: string]: unknown },
): void {
  if (!ENABLED) return;
  const entry = {
    task: taskId,
    ...summarize(event),
    limitSignal: isProviderLimitSignal(event),
  };
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    // Признак лимита дублируем в stderr — его видно в обычном логе сервиса
    // без чтения файла, и это тот самый случай из журнала находок.
    if (entry.limitSignal) {
      console.warn(
        `[pi-event] ПРИЗНАК ЛИМИТА ПРОВАЙДЕРА task=${taskId} type=${event.type}: ${clip(
          JSON.stringify(event),
          300,
        )}`,
      );
    }
  } catch {
    // Логгер не имеет права ронять запуск из-за своей поломки.
  }
}
