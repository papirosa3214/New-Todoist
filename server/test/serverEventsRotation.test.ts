// Серверный журнал событий: ротация и лимит хранения (карточка e87cd93f,
// шаг «Настройка ротации логов, ограничения хранения и фильтрации
// секретов», доработка по D1). Без ротации таблица `server_events`
// бесконечно росла, и 200-дневная запись QA-копии лежала как ни в чём не
// бывало. Здесь проверяем, что `pruneServerEvents` действительно
// удаляет старые строки и не трогает свежие, что планировщик
// `startServerEventsRetention` запускается и работает.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  DEFAULT_SERVER_EVENTS_RETENTION_DAYS,
  DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS,
  getServerEventsRetentionDays,
  getServerEventsRotationIntervalMs,
  logServerEvent,
  pruneServerEvents,
  setServerEventsRetentionDays,
  setServerEventsRotationIntervalMs,
  startServerEventsRetention,
  stopAllServerEventsRetention,
} from "../src/lib/serverEvents.js";

migrate();
runMigrations();

function countAll(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM server_events").get() as { n: number }).n;
}

function countOldAndFreshMessages(): {
  prune: number;
  fresh: number;
} {
  const rows = db
    .prepare(
      `SELECT message FROM server_events
         WHERE message LIKE 'unit-rotation:%'`,
    )
    .all() as Array<{ message: string }>;
  let prune = 0;
  let fresh = 0;
  for (const r of rows) {
    if (r.message.includes(":prune:")) prune += 1;
    else if (r.message.includes(":fresh:")) fresh += 1;
  }
  return { prune, fresh };
}

function insertBackdated(message: string, ageMs: number, now: number): void {
  const created = new Date(now - ageMs).toISOString();
  db.prepare(
    `INSERT INTO server_events (
       id, scope, kind, message, created_at
     ) VALUES (?, 'system', 'unhandled_error', ?, ?)`,
  ).run(`sev_test_${Math.random().toString(36).slice(2)}`, message, created);
}

beforeEach(() => {
  // На каждом прогоне чистим «наш» маркер, чтобы счётчики не
  // пересекались. Соседние unit-тесты используют свой префикс
  // `unit-test:`, его не трогаем.
  db.exec("DELETE FROM server_events WHERE message LIKE 'unit-rotation:%'");
  setServerEventsRetentionDays(null);
  setServerEventsRotationIntervalMs(null);
});

afterEach(() => {
  stopAllServerEventsRetention();
  db.exec("DELETE FROM server_events WHERE message LIKE 'unit-rotation:%'");
  setServerEventsRetentionDays(null);
  setServerEventsRotationIntervalMs(null);
});

describe("getServerEventsRetentionDays", () => {
  it("возвращает дефолт, если override не задан", () => {
    expect(getServerEventsRetentionDays()).toBe(DEFAULT_SERVER_EVENTS_RETENTION_DAYS);
  });

  it("программный override выигрывает над дефолтом", () => {
    setServerEventsRetentionDays(42);
    expect(getServerEventsRetentionDays()).toBe(42);
    setServerEventsRetentionDays(null);
    expect(getServerEventsRetentionDays()).toBe(DEFAULT_SERVER_EVENTS_RETENTION_DAYS);
  });

  it("null сбрасывает override", () => {
    setServerEventsRetentionDays(7);
    setServerEventsRetentionDays(null);
    expect(getServerEventsRetentionDays()).toBe(DEFAULT_SERVER_EVENTS_RETENTION_DAYS);
  });

  it("отрицательное или NaN-значение — ошибка", () => {
    expect(() => setServerEventsRetentionDays(-1)).toThrow();
    expect(() => setServerEventsRetentionDays(Number.NaN)).toThrow();
  });
});

describe("getServerEventsRotationIntervalMs", () => {
  it("возвращает дефолт, если override не задан", () => {
    expect(getServerEventsRotationIntervalMs()).toBe(DEFAULT_SERVER_EVENTS_ROTATION_INTERVAL_MS);
  });

  it("0 отключает планировщик (не ставит интервал)", () => {
    setServerEventsRotationIntervalMs(0);
    expect(getServerEventsRotationIntervalMs()).toBe(0);
  });
});

describe("pruneServerEvents", () => {
  it("удаляет только строки старше retentionDays, свежие оставляет", () => {
    const now = Date.now();
    // 200 дней назад (как в QA-воспроизведении) — старше 180-дневного
    // порога, должно уйти.
    insertBackdated("unit-rotation:prune:200d", 200 * 24 * 60 * 60_000, now);
    // 1 день назад — свежо, должно остаться.
    insertBackdated("unit-rotation:fresh:1d", 24 * 60 * 60_000, now);
    // Свежая запись через logServerEvent — должна остаться.
    logServerEvent({
      scope: "lifecycle",
      kind: "process_boot",
      message: "unit-rotation:fresh:boot",
    });

    const result = pruneServerEvents({ retentionDays: 180, now: new Date(now) });
    expect(result.removed).toBe(1);
    expect(result.retentionDays).toBe(180);

    const { prune, fresh } = countOldAndFreshMessages();
    expect(prune).toBe(0);
    expect(fresh).toBe(2);
  });

  it("retentionDays = 0 удаляет всё под маркером", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:1h", 60 * 60_000, now);
    insertBackdated("unit-rotation:prune:2h", 2 * 60 * 60_000, now);
    insertBackdated("unit-rotation:fresh:1m", 60_000, now);

    const result = pruneServerEvents({ retentionDays: 0, now: new Date(now) });
    expect(result.removed).toBeGreaterThanOrEqual(3);

    const { prune, fresh } = countOldAndFreshMessages();
    expect(prune).toBe(0);
    expect(fresh).toBe(0);
  });

  it("очень большой retention — оставляет всё как есть", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:100d", 100 * 24 * 60 * 60_000, now);
    insertBackdated("unit-rotation:fresh:1d", 24 * 60 * 60_000, now);

    const result = pruneServerEvents({ retentionDays: 1000, now: new Date(now) });
    expect(result.removed).toBe(0);

    const { prune, fresh } = countOldAndFreshMessages();
    expect(prune).toBe(1);
    expect(fresh).toBe(1);
  });

  it("возвращает корректные числа removed/remaining/threshold", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:300d", 300 * 24 * 60 * 60_000, now);

    const totalBefore = countAll();
    const result = pruneServerEvents({ retentionDays: 180, now: new Date(now) });
    expect(result.retentionDays).toBe(180);
    expect(typeof result.threshold).toBe("string");
    expect(typeof result.ranAt).toBe("string");
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.remaining).toBe(totalBefore - result.removed);
  });
});

describe("startServerEventsRetention", () => {
  it("первый тик чистки запускается сразу при intervalMs > 0", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:500d", 500 * 24 * 60 * 60_000, now);

    const handle = startServerEventsRetention({
      intervalMs: 60_000,
      retentionDays: 30,
      now: new Date(now),
    });
    expect(handle.intervalMs).toBe(60_000);
    expect(handle.lastResult).not.toBeNull();
    expect(handle.lastResult!.removed).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it("intervalMs=0 не ставит таймер, но делает первый прогон", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:200d", 200 * 24 * 60 * 60_000, now);

    const handle = startServerEventsRetention({
      intervalMs: 0,
      retentionDays: 30,
      now: new Date(now),
    });
    expect(handle.intervalMs).toBe(0);
    expect(handle.lastResult).not.toBeNull();
    handle.stop();
  });

  it("stop() идемпотентен и снимает все активные планировщики", () => {
    const now = Date.now();
    insertBackdated("unit-rotation:prune:200d", 200 * 24 * 60 * 60_000, now);

    const handle = startServerEventsRetention({
      intervalMs: 60_000,
      retentionDays: 30,
      now: new Date(now),
    });
    expect(handle.lastResult).not.toBeNull();
    handle.stop();
    handle.stop(); // второй вызов не должен бросить
    // После stopAll — запись всё равно удалена первым тиком.
    const { prune } = countOldAndFreshMessages();
    expect(prune).toBe(0);
  });
});
