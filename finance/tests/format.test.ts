/**
 * Правила раздела 5 дизайн-системы: единый формат денег, дат и числительных.
 */
import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatDateWithTime,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatSignedMoney,
  periodLabel,
  periodRange,
  plural,
  todayIso,
} from "@/lib/format";

const NBSP = " ";

describe("деньги", () => {
  it("всегда два знака, тире типографское и валюта", () => {
    expect(formatMoney(-1250, "RUB")).toBe(`−1${NBSP}250,00${NBSP}₽`);
    expect(formatMoney(0, "RUB")).toBe(`0,00${NBSP}₽`);
  });

  it("доход получает явный плюс, расход минус", () => {
    expect(formatSignedMoney(1250, "RUB")).toBe(`+1${NBSP}250,00${NBSP}₽`);
    expect(formatSignedMoney(-1250, "RUB")).toBe(`−1${NBSP}250,00${NBSP}₽`);
  });

  it("компактная запись для осей и подписей", () => {
    expect(formatMoneyCompact(-12500, "RUB")).toBe(`−12,5${NBSP}тыс${NBSP}₽`);
    expect(formatMoneyCompact(1200000, "RUB")).toBe(`1,2${NBSP}млн${NBSP}₽`);
    expect(formatMoneyCompact(950, "RUB")).toBe(`950,00${NBSP}₽`);
  });

  it("проценты с одним знаком", () => {
    expect(formatPercent(42)).toBe("42%");
    expect(formatPercent(12.36)).toBe("12,4%");
  });
});

describe("даты", () => {
  it("дата операции не сдвигается часовым поясом", () => {
    expect(formatDate("2026-10-10")).toBe("10.10.2026");
    expect(formatDateWithTime("2026-10-10T14:32:00.000Z")).toBe(`10.10.2026,${NBSP}14:32`);
  });

  it("битая дата не роняет экран", () => {
    expect(formatDate("не дата")).toBe("не дата");
  });
});

describe("числительные", () => {
  const forms: [string, string, string] = ["счёт", "счёта", "счетов"];

  it("выбирает форму по числу", () => {
    expect(plural(1, forms)).toBe("счёт");
    expect(plural(2, forms)).toBe("счёта");
    expect(plural(5, forms)).toBe("счетов");
    expect(plural(11, forms)).toBe("счетов");
    expect(plural(21, forms)).toBe("счёт");
  });
});

describe("период", () => {
  it("неделя — это 7 дней, а не 8", () => {
    const label = periodLabel("week", { from: "2026-10-06", to: "2026-10-12" });
    expect(label).toBe(`Неделя · 06${NBSP}октября – 12${NBSP}октября`);
  });

  it("подпись и границы периода считаются одним способом", () => {
    const range = periodRange("week");
    expect(dayCount(range)).toBe(7);
    // Подпись без переданного диапазона должна совпасть с границами из periodRange.
    expect(periodLabel("week")).toBe(periodLabel("week", range));
    expect(periodLabel("month")).toBe(periodLabel("month", periodRange("month")));
  });

  it("произвольный диапазон берётся из строки периода", () => {
    expect(periodRange("2026-01-01_2026-03-31")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("сегодня по московскому времени, не по UTC", () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

function dayCount({ from, to }: { from: string; to: string }): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}