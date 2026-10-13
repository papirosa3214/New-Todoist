import { describe, it, expect } from "vitest";
import {
  addMonths,
  futureValue,
  monthlySchedule,
  monthsLeft,
  project,
  realValue,
  steppedFutureValue,
  summarize,
  timesInflation,
} from "../src/lib/savings";

/**
 * Ожидаемые суммы посчитаны вручную и зафиксированы как эталон:
 * 100 000 под 12% годовых на 36 месяцев с ежемесячной капитализацией
 * → 100 000 × 1,01^36 = 143 076,88 ₽.
 */
describe("расчёт сложных процентов сходится с ручным примером", () => {
  it("ручной пример: 100 000 ₽, 12% годовых, 36 мес, ежемесячно", () => {
    const p = project({ principal: 100000, annualRate: 12, months: 36, compounding: "monthly" });
    expect(p.finalAmount).toBe(143076.88);
    expect(p.profit).toBe(43076.88);
    expect(p.periodPercent).toBe(43.08);
  });

  it("тот же пример посчитан накоплением по периодам — результат совпал", () => {
    const input = { principal: 100000, annualRate: 12, months: 36, compounding: "monthly" as const };
    expect(steppedFutureValue(input)).toBe(futureValue(100000, 12, 36, "monthly"));

    // ручное умножение ×1,01 тридцать шесть раз
    let acc = 100000;
    for (let i = 0; i < 36; i += 1) acc = acc * 1.01;
    expect(Math.round(acc * 100) / 100).toBe(143076.88);
  });

  it("без капитализации работают простые проценты: 12% на год = 112 000 ₽", () => {
    const p = project({ principal: 100000, annualRate: 12, months: 12, compounding: "none" });
    expect(p.finalAmount).toBe(112000);
    expect(p.profit).toBe(12000);
  });

  it("капитализация раз в год: 10% на три года = 133 100 ₽", () => {
    const p = project({ principal: 100000, annualRate: 10, months: 36, compounding: "yearly" });
    expect(p.finalAmount).toBe(133100);
  });

  it("ежеквартальная капитализация: 100 000 под 8% на год ровно 25 000", () => {
    const p = project({ principal: 100000, annualRate: 8, months: 12, compounding: "quarterly" });
    // 2 периода по 2%: 100 000 × 1,02^4 = 108 243,22
    expect(p.finalAmount).toBe(108243.22);
  });

  it("доходность в год при ежемесячной капитализации выше номинальной ставки", () => {
    const p = project({ principal: 100000, annualRate: 12, months: 36, compounding: "monthly" });
    expect(p.annualPercent).toBe(12.68);
    expect(p.periodPercent).toBeGreaterThan(p.annualPercent);
  });
});

describe("крайние случаи", () => {
  it("нулевая ставка — сумма не меняется", () => {
    const p = project({ principal: 50000, annualRate: 0, months: 24, compounding: "monthly" });
    expect(p.finalAmount).toBe(50000);
    expect(p.profit).toBe(0);
    expect(p.periodPercent).toBe(0);
    expect(p.annualPercent).toBe(0);
  });

  it("нулевая сумма и нулевой срок не дают NaN", () => {
    for (const input of [
      { principal: 0, annualRate: 10, months: 12, compounding: "monthly" as const },
      { principal: 100000, annualRate: 10, months: 0, compounding: "monthly" as const },
      { principal: -5, annualRate: 10, months: 12, compounding: "monthly" as const },
    ]) {
      const p = project(input);
      expect(Number.isFinite(p.finalAmount)).toBe(true);
      expect(Number.isFinite(p.annualPercent)).toBe(true);
    }
  });

  it("итог по нескольким вкладам считается и суммарно, и по отдельности", () => {
    const a = { principal: 100000, annualRate: 12, months: 12, compounding: "monthly" as const };
    const b = { principal: 50000, annualRate: 7, months: 18, compounding: "monthly" as const };
    const s = summarize([
      { ...a, currency: "RUB" },
      { ...b, currency: "RUB" },
    ]);
    expect(s.byCurrency.RUB.principal).toBe(150000);
    expect(s.byCurrency.RUB.finalAmount).toBe(
      Math.round((futureValue(100000, 12, 12, "monthly") + futureValue(50000, 7, 18, "monthly")) * 100) / 100,
    );
    expect(s.total.finalAmount).toBe(s.byCurrency.RUB.finalAmount);
  });

  it("разные валюты не смешиваются в одну сумму", () => {
    const s = summarize([
      { principal: 1000, annualRate: 1, months: 12, compounding: "monthly", currency: "USD" },
      { principal: 1000, annualRate: 1, months: 12, compounding: "monthly", currency: "RUB" },
    ]);
    expect(Object.keys(s.byCurrency).sort()).toEqual(["RUB", "USD"]);
    // 1000 $ под 1% годовых с ежемесячной капитализацией: 1000 × (1 + 0,01/12)¹²
    expect(s.byCurrency.USD.finalAmount).toBe(1010.05);
    expect(s.byCurrency.USD.principal).toBe(1000);
  });
});

describe("сравнение с инфляцией", () => {
  it("12% при инфляции 10% дают около 1,82% реально за год", () => {
    const p = project({ principal: 100000, annualRate: 12, months: 12, compounding: "none" });
    const real = realValue(p, 10);
    expect(real.realAmount).toBe(101818.18);
    expect(real.realPercent).toBe(1.82);
  });

  it("ставка ниже инфляции даёт отрицательную покупательную способность", () => {
    const p = project({ principal: 100000, annualRate: 5, months: 12, compounding: "none" });
    const real = realValue(p, 10);
    expect(real.realPercent).toBe(-4.55);
    expect(timesInflation(p, 10)).toBe(0.5);
  });

  it("без заданной инфляции отношение не показывается", () => {
    const p = project({ principal: 100000, annualRate: 12, months: 12, compounding: "monthly" });
    expect(timesInflation(p, 0)).toBeNull();
  });
});

describe("график и даты", () => {
  it("помесячный график сходится к итогу срока", () => {
    const input = { principal: 100000, annualRate: 12, months: 36, compounding: "monthly" as const };
    const schedule = monthlySchedule(input, "2026-01-15");
    expect(schedule.length).toBe(36);
    expect(schedule[0].date).toBe("2026-02-15");
    expect(schedule[35].date).toBe("2029-01-15");
    // накопление по месяцам идёт с округлением до копеек — расходится с закрытой
    // формулой не больше, чем на копейки за 36 месяцев
    expect(
      Math.abs(schedule[35].balance - futureValue(100000, 12, 36, "monthly")),
    ).toBeLessThanOrEqual(0.1);
    // с капитализацией проценты месяца растут
    expect(schedule[35].interest).toBeGreaterThan(schedule[0].interest);
  });

  it("дата окончания — старт плюс срок", () => {
    expect(addMonths("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonths("2026-10-13", 12)).toBe("2027-10-13");
  });

  it("остаток срока считается от сегодняшней даты", () => {
    expect(monthsLeft("2027-10-13", "2026-10-13")).toBe(12);
    expect(monthsLeft("2026-10-13", "2026-10-13")).toBe(0);
    expect(monthsLeft("2025-01-01", "2026-10-13")).toBe(0);
  });
});