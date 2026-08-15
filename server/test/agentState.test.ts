// Базовые тесты матрицы переходов agent_state (agentState.ts) — шаг
// «Базовые тесты состояний агента и один сквозной сценарий» задачи
// b376ab48. Чистая логика, без HTTP и без записи в базу: canTransition,
// commentRequiredFor, isStale, leaseExpiresAt — все четыре не трогают db
// напрямую (см. agentState.ts), но модуль всё равно импортирует db.ts
// (для logEvent), поэтому DB_PATH обязан быть выставлен до импорта —
// см. test/setup.ts (vitest.config.ts, setupFiles).
import { describe, it, expect } from "vitest";
import {
  canTransition,
  commentRequiredFor,
  isStale,
  leaseExpiresAt,
  LEASE_MINUTES,
} from "../src/agentState.js";

const executor = { isOwner: false, isExecutor: true };
const owner = { isOwner: true, isExecutor: false };
const both = { isOwner: true, isExecutor: true };
const stranger = { isOwner: false, isExecutor: false };

describe("canTransition — матрица переходов (AGENT-PROTOCOL.md, «Матрица переходов»)", () => {
  it("NULL -> in_progress: только исполнитель, через claim или state", () => {
    expect(canTransition(null, "in_progress", executor, "claim")).toBe(true);
    expect(canTransition(null, "in_progress", executor, "state")).toBe(true);
    expect(canTransition(null, "in_progress", stranger, "claim")).toBe(false);
  });

  it("in_progress -> review/blocked: только исполнитель, через state", () => {
    expect(canTransition("in_progress", "review", executor, "state")).toBe(
      true,
    );
    expect(canTransition("in_progress", "blocked", executor, "state")).toBe(
      true,
    );
    expect(canTransition("in_progress", "review", owner, "state")).toBe(false);
  });

  it("blocked -> in_progress: исполнитель, через claim или state", () => {
    expect(canTransition("blocked", "in_progress", executor, "claim")).toBe(
      true,
    );
    expect(canTransition("blocked", "in_progress", executor, "state")).toBe(
      true,
    );
  });

  it("in_progress -> in_progress (перезахват): только claim, только с истёкшей арендой", () => {
    const expired = { isOwner: false, isExecutor: true, leaseExpired: true };
    const alive = { isOwner: false, isExecutor: true, leaseExpired: false };
    expect(canTransition("in_progress", "in_progress", expired, "claim")).toBe(
      true,
    );
    // Тот же перезахват через /state запрещён — этой строки не было в
    // AGENT-API.md до 15.08.2026, разошлась с кодом (см. коммит "Свести
    // две таблицы переходов").
    expect(canTransition("in_progress", "in_progress", expired, "state")).toBe(
      false,
    );
    expect(canTransition("in_progress", "in_progress", alive, "claim")).toBe(
      false,
    );
  });

  it("review -> in_progress: только владелец, только через state", () => {
    expect(canTransition("review", "in_progress", owner, "state")).toBe(true);
    expect(canTransition("review", "in_progress", owner, "claim")).toBe(false);
    expect(canTransition("review", "in_progress", executor, "state")).toBe(
      false,
    );
  });

  it("любое -> NULL: только владелец", () => {
    expect(canTransition("in_progress", null, owner, "state")).toBe(true);
    expect(canTransition("blocked", null, owner, "state")).toBe(true);
    expect(canTransition("review", null, owner, "state")).toBe(true);
    expect(canTransition("in_progress", null, executor, "state")).toBe(false);
  });

  it("создатель, взявший свою же задачу, держит обе роли разом", () => {
    expect(canTransition(null, "in_progress", both, "claim")).toBe(true);
    expect(canTransition("in_progress", null, both, "state")).toBe(true);
  });

  it("недопустимые переходы отклоняются", () => {
    expect(canTransition("blocked", "review", executor, "state")).toBe(false);
    expect(canTransition("review", "blocked", executor, "state")).toBe(false);
    expect(canTransition("review", "review", owner, "state")).toBe(false);
  });
});

describe("commentRequiredFor", () => {
  it("обязателен для blocked и review", () => {
    expect(commentRequiredFor("in_progress", "blocked")).toBe(true);
    expect(commentRequiredFor("in_progress", "review")).toBe(true);
  });

  it("обязателен при возврате review -> in_progress", () => {
    expect(commentRequiredFor("review", "in_progress")).toBe(true);
  });

  it("не обязателен для остальных переходов", () => {
    expect(commentRequiredFor(null, "in_progress")).toBe(false);
    expect(commentRequiredFor("blocked", "in_progress")).toBe(false);
    expect(commentRequiredFor("in_progress", null)).toBe(false);
  });
});

describe("isStale / leaseExpiresAt", () => {
  it("нет heartbeat — не просрочено (задача не в работе)", () => {
    expect(isStale(null)).toBe(false);
    expect(leaseExpiresAt(null)).toBe(null);
  });

  it(`heartbeat старше ${LEASE_MINUTES} минут — просрочено`, () => {
    const old = new Date(Date.now() - (LEASE_MINUTES + 1) * 60_000);
    const sqliteFormat = old.toISOString().slice(0, 19).replace("T", " ");
    expect(isStale(sqliteFormat)).toBe(true);
  });

  it("свежий heartbeat — не просрочено", () => {
    const fresh = new Date(Date.now() - 30_000);
    const sqliteFormat = fresh.toISOString().slice(0, 19).replace("T", " ");
    expect(isStale(sqliteFormat)).toBe(false);
  });

  it("формат SQLite (без Z/T) читается как UTC, не как локальное время", () => {
    // Регрессия на комментарий в agentState.ts (parseSqliteUtc): голый
    // `new Date("YYYY-MM-DD HH:MM:SS")` парсится Node как ЛОКАЛЬНОЕ время,
    // а SQLite datetime('now') пишет UTC — на любом непустом смещении от
    // UTC (например, сервер на UTC+3) свежий heartbeat выглядел бы
    // постоянно (неверно) просроченным. Проверяем то же самое числом, а
    // не только true/false: leaseExpiresAt должен попасть в ±2с от
    // now + LEASE_MINUTES, независимо от часового пояса машины, где
    // выполняется тест.
    const nowUtc = new Date();
    const sqliteFormat = nowUtc.toISOString().slice(0, 19).replace("T", " ");
    const expires = leaseExpiresAt(sqliteFormat)!;
    const expectedMs = nowUtc.getTime() + LEASE_MINUTES * 60_000;
    expect(Math.abs(expires.getTime() - expectedMs)).toBeLessThan(2000);
  });
});
