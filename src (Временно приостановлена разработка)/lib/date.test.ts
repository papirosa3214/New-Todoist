// Юнит-тесты хелперов дат для разделителей суток в ленте чата.
// «Сегодня» / «Вчера» считаются московским днём, поэтому в тестах
// время подбирается так, чтобы оно гарантированно лежало в нужных
// сутках по Москве даже при запуске в зонах западнее UTC.
import { describe, expect, it } from "vitest";
import { formatDaySeparator, getMskDayKey, todayStr } from "./date";

// SQLite datetime('now') хранит время в UTC. Берём полдень по Москве
// (= 09:00 UTC), чтобы при любом TZ на тестовом стенде сутки не
// перепрыгнули.
const MSK_NOON_TODAY = todayStr() + " 09:00:00";
const MSK_NOON_YESTERDAY = shiftDays(todayStr(), -1) + " 09:00:00";
const MSK_NOON_TWO_DAYS_AGO = shiftDays(todayStr(), -2) + " 09:00:00";
const MSK_NOON_FAR_PAST = "2024-03-15 09:00:00";

function shiftDays(yyyyMmDd: string, days: number): string {
  // Локальная арифметика, как у addDays(), но не импортируем её —
  // тест должен быть самодостаточным и читаться без прыжков по файлу.
  const d = new Date(yyyyMmDd + "T00:00:00");
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("getMskDayKey", () => {
  it("сегодня по Москве — сегодняшняя дата", () => {
    expect(getMskDayKey(MSK_NOON_TODAY)).toBe(todayStr());
  });

  it("полночь UTC предыдущего дня = сегодня по Москве (сдвиг зоны)", () => {
    // 21:00 предыдущего дня UTC = 00:00 МСК текущего. По «наивному»
    // парсингу без зоны это «вчера», а по Москве — уже сегодня.
    const yesterdayUtc = shiftDays(todayStr(), -1) + " 21:00:00";
    expect(getMskDayKey(yesterdayUtc)).toBe(todayStr());
  });

  it("две даты одного московского дня дают одинаковый ключ", () => {
    const morning = todayStr() + " 01:00:00"; // 04:00 МСК
    const evening = todayStr() + " 16:00:00"; // 19:00 МСК
    expect(getMskDayKey(morning)).toBe(todayStr());
    expect(getMskDayKey(evening)).toBe(todayStr());
  });
});

describe("formatDaySeparator", () => {
  it("сегодня → «Сегодня»", () => {
    expect(formatDaySeparator(MSK_NOON_TODAY)).toBe("Сегодня");
  });

  it("вчера → «Вчера»", () => {
    expect(formatDaySeparator(MSK_NOON_YESTERDAY)).toBe("Вчера");
  });

  it("позавчера текущего года → «день месяц» (без года)", () => {
    const out = formatDaySeparator(MSK_NOON_TWO_DAYS_AGO);
    // Год опускаем — в текущем году он и так считывается из шапки.
    expect(out).toMatch(/^\d{1,2} [а-я]+$/);
  });

  it("прошлый год → «день месяц год»", () => {
    // 2024-й заведомо не текущий при любом разумном now().
    expect(formatDaySeparator(MSK_NOON_FAR_PAST)).toBe("15 мар 2024");
  });
});
