// Юнит-тесты чистой логики эскалации (lib/escalationEvaluator.ts) — без
// поднятия Fastify и без БД. Покрывает контракт, на который опирается
// и scheduler, и роуты: шаг `selectSteps` выбирает корректно по приоритету
// и часам, `stepKey` совпадает с типом уведомления, `parseSteps` не
// падает на мусоре, `validateRuleInput` ловит кривые настройки, окно
// тишины работает через полночь, `previewNotifications` считает потолок
// за горизонт.
import { describe, expect, it } from "vitest";
import {
  defaultSteps,
  hoursOverdue,
  isInQuietWindow,
  localClock,
  parseSteps,
  previewNotifications,
  selectSteps,
  stepKey,
  validateRuleInput,
  type EscalationRule,
  type EscalationTask,
} from "../src/lib/escalationEvaluator.js";

const TZ = "Europe/Moscow";

const baseRule: EscalationRule = {
  enabled: true,
  quiet_from: "22:00",
  quiet_to: "08:00",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  steps: defaultSteps(),
};

function mkTask(over: Partial<EscalationTask> = {}): EscalationTask {
  return {
    id: "t1",
    title: "Полить цветы",
    priority: 1,
    due_date: "2026-10-04",
    status: "active",
    ...over,
  };
}

// Построить «сейчас» как объект, который ждёт hoursOverdue. Используем
// фиксированную TZ, чтобы тест не зависел от локальной TZ машины.
function fixedNow(ymd: string, hour: number, minute: number, second = 0) {
  return { ymd, hour, minute, second };
}

describe("stepKey — единый формат между БД и типом уведомления", () => {
  it('формирует "p<priority>_h<after_hours>"', () => {
    expect(stepKey(1, 1)).toBe("p1_h1");
    expect(stepKey(2, 4)).toBe("p2_h4");
    expect(stepKey(3, 24)).toBe("p3_h24");
    expect(stepKey(4, 72)).toBe("p4_h72");
  });
});

describe("parseSteps — защита от мусора в steps_json", () => {
  it("дефолт, если строка не парсится", () => {
    const got = parseSteps("not-json{");
    expect(got.map((s) => s.after_hours)).toEqual(defaultSteps().map((s) => s.after_hours));
  });
  it("дефолт, если массив пустой", () => {
    const got = parseSteps("[]");
    expect(got).toEqual(defaultSteps());
  });
  it("отбрасывает битые элементы, оставляет валидные", () => {
    const got = parseSteps(
      JSON.stringify([
        { after_hours: 2, priority_max: 1, channels: ["inapp"] },
        { after_hours: -1, priority_max: 1, channels: ["inapp"] },
        { after_hours: 5, priority_max: 9, channels: ["inapp"] },
        { after_hours: 5, priority_max: 2, channels: ["email"] },
        { after_hours: 5, priority_max: 2, channels: ["inapp", "apns"] },
      ]),
    );
    expect(got).toEqual([
      { after_hours: 2, priority_max: 1, channels: ["inapp"] },
      { after_hours: 5, priority_max: 2, channels: ["inapp", "apns"] },
    ]);
  });
});

describe("validateRuleInput — отсекает кривые PUT", () => {
  it("объект — обязателен", () => {
    expect(validateRuleInput(null)).toContain("тело запроса — объект");
    expect(validateRuleInput("x")).toContain("тело запроса — объект");
  });
  it("часы тишины — HH:MM (00..23)", () => {
    const errs = validateRuleInput({
      enabled: true,
      quiet_from: "25:00",
      quiet_to: "8",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      steps_json: "[]",
    });
    expect(errs).toEqual(expect.arrayContaining(["quiet_from: HH:MM", "quiet_to: HH:MM"]));
  });
  it("дни недели — числа 1..7, не пусто", () => {
    const errs = validateRuleInput({
      enabled: true,
      quiet_from: "22:00",
      quiet_to: "08:00",
      weekdays: [],
      steps_json: "[]",
    });
    expect(errs).toEqual(expect.arrayContaining(["weekdays: хотя бы один день"]));
  });
  it("валидный объект — пустой массив ошибок", () => {
    expect(
      validateRuleInput({
        enabled: false,
        quiet_from: "22:00",
        quiet_to: "08:00",
        weekdays: [1, 2, 3, 4, 5],
        steps_json: JSON.stringify(defaultSteps()),
      }),
    ).toEqual([]);
  });
});

describe("hoursOverdue — только просрочка, не будущее", () => {
  it("сегодняшний due_date — ровно столько часов сейчас", () => {
    expect(hoursOverdue("2026-10-04", fixedNow("2026-10-04", 10, 30))).toBe(10.5);
  });
  it("из-за вчера — 24 + часы сегодня", () => {
    expect(hoursOverdue("2026-10-03", fixedNow("2026-10-04", 10, 30))).toBe(34.5);
  });
  it("будущий due_date — отрицательная бесконечность (не просрочка)", () => {
    expect(hoursOverdue("2026-10-10", fixedNow("2026-10-04", 10, 30))).toBe(Number.NEGATIVE_INFINITY);
  });
  it("битый due_date — отрицательная бесконечность", () => {
    expect(hoursOverdue("xxx", fixedNow("2026-10-04", 10, 30))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("isInQuietWindow — тишина через полночь", () => {
  it("22:30 в окне 22:00..08:00 — тишина", () => {
    expect(isInQuietWindow(baseRule, 22, 30, 4)).toBe(true);
  });
  it("07:30 в окне 22:00..08:00 — тишина", () => {
    expect(isInQuietWindow(baseRule, 7, 30, 4)).toBe(true);
  });
  it("10:00 в окне 22:00..08:00 — бодрствуем", () => {
    expect(isInQuietWindow(baseRule, 10, 0, 4)).toBe(false);
  });
  it("дни недели: воскресенье (7) при weekdays=[1..6] — тишина", () => {
    const rule = { ...baseRule, weekdays: [1, 2, 3, 4, 5, 6] };
    expect(isInQuietWindow(rule, 10, 0, 7)).toBe(true);
  });
  it("отключённое правило — тишина", () => {
    expect(isInQuietWindow({ ...baseRule, enabled: false }, 10, 0, 4)).toBe(true);
  });
});

describe("localClock — разворачивает Date в локальные поля под TZ", () => {
  it("Москва: дата и время", () => {
    // 2026-10-04T07:30:00Z = 10:30 MSK.
    const d = new Date("2026-10-04T07:30:00Z");
    const c = localClock(d, TZ);
    expect(c.ymd).toBe("2026-10-04");
    expect(c.hour).toBe(10);
    expect(c.minute).toBe(30);
    // 2026-10-04 — воскресенье.
    expect(c.weekdayMon1to7).toBe(7);
  });
  it("полночь по Москве = 21:00 предыдущего дня UTC, дата — московская", () => {
    const d = new Date("2026-10-03T21:00:00Z");
    const c = localClock(d, TZ);
    expect(c.ymd).toBe("2026-10-04");
    expect(c.hour).toBe(0);
  });
});

describe("selectSteps — соответствует спеке §3.2", () => {
  // Фиксируем «сейчас» как UTC 07:30:00Z, что под TZ Europe/Moscow =
  // 10:30 воскресенья 2026-10-04. Воскресенье (weekday=7) — в дефолтных
  // weekdays [1..7] не отсекается. 10:30 — вне окна 22:00..08:00.
  // Логика «priority_max — нижняя граница, не верхняя» (спека §1.1):
  // pm=1 действует только на priority=1, pm=4 — на ВСЕ. В дефолтных
  // шагах это значит: priority=1 (самый срочный) попадает под все
  // шаги; priority=4 (фоновая) — только под шаг с pm=4.
  const now = new Date("2026-10-04T07:30:00Z");

  it("priority=1, due_date сегодня (overdue=10.5ч) — шаги 1ч и 4ч", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 1, due_date: "2026-10-04" }),
      now,
      TZ,
    );
    expect(steps.map((s) => s.after_hours)).toEqual([1, 4]);
  });
  it("priority=2, due_date сегодня — шаг 4ч (pm=2, after<=10.5)", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 2, due_date: "2026-10-04" }),
      now,
      TZ,
    );
    expect(steps.map((s) => s.after_hours)).toEqual([4]);
  });
  it("priority=3, due_date сегодня — пусто (24ч > 10.5ч)", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 3, due_date: "2026-10-04" }),
      now,
      TZ,
    );
    expect(steps).toEqual([]);
  });
  it("priority=1, due_date 4 дня назад (overdue=106.5ч) — все 4 шага", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 1, due_date: "2026-09-30" }),
      now,
      TZ,
    );
    expect(steps.map((s) => s.after_hours)).toEqual([1, 4, 24, 72]);
  });
  it("priority=4, due_date 4 дня назад — только шаг 72ч (pm=4)", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 4, due_date: "2026-09-30" }),
      now,
      TZ,
    );
    expect(steps.map((s) => s.after_hours)).toEqual([72]);
  });
  it("completed — пусто", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ status: "completed", due_date: "2026-09-30" }),
      now,
      TZ,
    );
    expect(steps).toEqual([]);
  });
  it("null priority трактуется как 4 (спека §6)", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: null, due_date: "2026-09-30" }),
      now,
      TZ,
    );
    expect(steps.map((s) => s.after_hours)).toEqual([72]);
  });
  it("тишина — пусто (23:00 MSK)", () => {
    const nowQuiet = new Date("2026-10-04T20:00:00Z");
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 1, due_date: "2026-10-04" }),
      nowQuiet,
      TZ,
    );
    expect(steps).toEqual([]);
  });
  it("будущий due_date — пусто", () => {
    const steps = selectSteps(
      baseRule,
      mkTask({ priority: 1, due_date: "2026-10-10" }),
      now,
      TZ,
    );
    expect(steps).toEqual([]);
  });
});

describe("previewNotifications — потолок за горизонт", () => {
  it("считает максимум за days=7: P1 (priority=1) получает больше, чем P3 (priority=3)", () => {
    const tasks = [
      mkTask({ id: "p1", priority: 1, due_date: "2026-10-01" }),
      mkTask({ id: "p3", priority: 3, due_date: "2026-10-01" }),
    ];
    const items = previewNotifications(baseRule, tasks, 7);
    // P1 (priority=1) попадает под все шаги, P3 (priority=3) — только под
    // шаги с priority_max>=3 (24ч, 72ч в дефолте). У P1 строго больше.
    const a = items.filter((i) => i.task_id === "p1").length;
    const b = items.filter((i) => i.task_id === "p3").length;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
  });
  it("отключённое правило — пусто", () => {
    const tasks = [mkTask({ priority: 1, due_date: "2026-10-01" })];
    expect(previewNotifications({ ...baseRule, enabled: false }, tasks, 7)).toEqual([]);
  });
  it("days=0 — пусто", () => {
    const tasks = [mkTask({ priority: 1, due_date: "2026-10-01" })];
    expect(previewNotifications(baseRule, tasks, 0)).toEqual([]);
  });
});
