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
  subtaskWorkRefusal,
  LEASE_MINUTES,
} from "../src/agentState.js";

const executor = { isOwner: false, isExecutor: true };
const owner = { isOwner: true, isExecutor: false };
const both = { isOwner: true, isExecutor: true };
const stranger = { isOwner: false, isExecutor: false };
const reviewer = { isOwner: false, isExecutor: false, isReviewer: true };

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

  // 20.08.2026: обязательная приёмка отменена, поэтому вернуть задачу из
  // review может и исполнитель — но по-прежнему только через state, где
  // обязателен комментарий. claim в review не лезет: молчаливое
  // возобновление работы не должно проходить мимо ленты.
  it("review -> in_progress: владелец и исполнитель, только через state", () => {
    expect(canTransition("review", "in_progress", owner, "state")).toBe(true);
    expect(canTransition("review", "in_progress", executor, "state")).toBe(
      true,
    );
    expect(canTransition("review", "in_progress", owner, "claim")).toBe(false);
    expect(canTransition("review", "in_progress", executor, "claim")).toBe(
      false,
    );
    expect(canTransition("review", "in_progress", reviewer, "state")).toBe(true);
    expect(canTransition("review", "in_progress", reviewer, "claim")).toBe(false);
  });

  it("любое -> NULL: только владелец", () => {
    expect(canTransition("in_progress", null, owner, "state")).toBe(true);
    expect(canTransition("blocked", null, owner, "state")).toBe(true);
    expect(canTransition("review", null, owner, "state")).toBe(true);
    expect(canTransition("in_progress", null, executor, "state")).toBe(false);
  });

  it("Reviewer не получает другие переходы", () => {
    expect(canTransition(null, "in_progress", reviewer, "state")).toBe(false);
    expect(canTransition("in_progress", "blocked", reviewer, "state")).toBe(false);
    expect(canTransition("review", null, reviewer, "state")).toBe(false);
  });

  it("создатель, взявший свою же задачу, держит обе роли разом", () => {
    expect(canTransition(null, "in_progress", both, "claim")).toBe(true);
    expect(canTransition("in_progress", null, both, "state")).toBe(true);
  });

  it("недопустимые переходы отклоняются", () => {
    expect(canTransition("blocked", "review", executor, "state")).toBe(false);
    expect(canTransition("review", "blocked", executor, "state")).toBe(false);
    expect(canTransition("review", "review", owner, "state")).toBe(false);
    expect(
      canTransition(
        "review",
        "in_progress",
        { isOwner: false, isExecutor: false },
        "state",
      ),
    ).toBe(false);
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

describe("subtaskWorkRefusal — правила работы над шагом", () => {
  const ai = {
    isAi: true,
    taskAgentState: "in_progress" as const,
    hasResult: true,
  };

  it("агент не берёт шаг под задачей, которую никто не взял", () => {
    const r = subtaskWorkRefusal({
      ...ai,
      taskAgentState: null,
      from: null,
      to: "in_progress",
    });
    expect(r?.code).toBe(400);
    expect(r?.error).toContain("claim");
  });

  it("под взятой задачей шаг в работу проходит", () => {
    expect(
      subtaskWorkRefusal({ ...ai, from: null, to: "in_progress" }),
    ).toBeNull();
  });

  it("владельца это правило не касается — он правит шаги руками", () => {
    expect(
      subtaskWorkRefusal({
        ...ai,
        isAi: false,
        taskAgentState: null,
        from: null,
        to: "in_progress",
      }),
    ).toBeNull();
  });

  // Приёмка шагов отменена 20.08.2026, а 21.08.2026 выяснилось, что одного
  // текста правила исполнителю мало: агент наставил review пяти шагам
  // подряд, хотя оно записано и в его инструкциях, и в памяти. Теперь
  // правило держит сервер.
  it("агент не ставит review на шаг — ни из работы, ни из блокировки", () => {
    for (const from of ["in_progress", "blocked", null] as const) {
      const r = subtaskWorkRefusal({ ...ai, from, to: "review" });
      expect(r?.code).toBe(400);
      expect(r?.error).toContain("галочкой");
      expect(r?.error).toContain("на всю задачу");
    }
  });

  it("владельцу review на шаге по-прежнему доступен", () => {
    expect(
      subtaskWorkRefusal({
        ...ai,
        isAi: false,
        from: "in_progress",
        to: "review",
      }),
    ).toBeNull();
  });

  it("блокировка шага требует причины — молча упереться нельзя", () => {
    expect(
      subtaskWorkRefusal({
        ...ai,
        hasResult: false,
        from: "in_progress",
        to: "blocked",
      })?.code,
    ).toBe(400);
    expect(
      subtaskWorkRefusal({ ...ai, from: "in_progress", to: "blocked" }),
    ).toBeNull();
  });

  // Предел длины итога у агента проверяется теперь на ЗАКРЫТИИ шага
  // галочкой (routes/subtasks.ts, тест в subtaskDone.test.ts): путь через
  // review агенту закрыт, и оставлять проверку только там значило бы её
  // потерять.

  it("человека предел длины не касается", () => {
    expect(
      subtaskWorkRefusal({
        ...ai,
        isAi: false,
        from: "in_progress",
        to: "review",
        resultLength: 900,
      }),
    ).toBeNull();
  });

  it("продление аренды (тело без state) не проверяется", () => {
    expect(
      subtaskWorkRefusal({
        ...ai,
        taskAgentState: null,
        hasResult: false,
        from: "in_progress",
        to: undefined,
      }),
    ).toBeNull();
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
