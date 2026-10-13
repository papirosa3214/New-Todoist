/**
 * FIN-05 и правило 5.6 дизайн-системы: накопления на одну дату не зависят от
 * периода, нули не показываются, валюты не складываются.
 */
import { describe, expect, it } from "vitest";

import {
  addMonths,
  amountsByCurrency,
  buildNetWorthSeries,
  isZeroAmount,
  monthRange,
  netWorthWindow,
  sortCurrencies,
} from "@/lib/series";

// История: счёт открыт в январе с 100 000 ₽, дальше операции за полтора года.
const MONTHLY_NET = [
  { month: "2026-01", value: 51000 },
  { month: "2026-02", value: -20000 },
  { month: "2026-03", value: -15000 },
  { month: "2026-04", value: 12000 },
  { month: "2026-05", value: -8000 },
  { month: "2026-06", value: -9000 },
  { month: "2026-07", value: -7000 },
  { month: "2026-08", value: -6000 },
  { month: "2026-09", value: -5000 },
  { month: "2026-10", value: -4000 },
];
const OPENING = [{ month: "2026-01", value: 100000 }];

function series(args: { from: string; to: string }) {
  const w = netWorthWindow(args);
  return buildNetWorthSeries({
    monthlyNet: MONTHLY_NET,
    openingByMonth: OPENING,
    windowFrom: w.windowFrom,
    windowTo: w.windowTo,
  });
}

describe("накопления", () => {
  it("значение на дату одно и то же при любом периоде", () => {
    const month = series({ from: "2026-09-13", to: "2026-10-13" });
    const year = series({ from: "2025-10-13", to: "2026-10-13" });
    const quarter = series({ from: "2026-07-13", to: "2026-10-13" });

    const valueOn = (rows: Array<{ month: string; amount: number }>, m: string) =>
      rows.find((r) => r.month === m)?.amount;

    for (const m of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
      expect(valueOn(month, m)).toBe(valueOn(year, m));
      expect(valueOn(quarter, m)).toBe(valueOn(year, m));
    }
  });

  it("считает всю историю, а не только операции внутри периода", () => {
    const rows = series({ from: "2026-10-13", to: "2026-10-13" });
    const october = rows.find((r) => r.month === "2026-10");
    // 100 000 + (51 000 − 20 000 − 15 000 + 12 000 − 8 000 − 9 000 − 7 000 − 6 000 − 5 000 − 4 000)
    expect(october?.amount).toBe(89000);
  });

  it("на «Месяце» показывает не одну точку", () => {
    const rows = series({ from: "2026-09-13", to: "2026-10-13" });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[rows.length - 1].month).toBe("2026-10");
  });

  it("окно длиннее года не обрезается", () => {
    const rows = series({ from: "2024-01-01", to: "2026-10-13" });
    expect(rows.length).toBe(34);
    expect(rows[rows.length - 1].month).toBe("2026-10");
  });

  it("счёт, открытый позже, добавляется со своего месяца", () => {
    const rows = buildNetWorthSeries({
      monthlyNet: [{ month: "2026-03", value: -100 }],
      openingByMonth: [
        { month: "2026-01", value: 1000 },
        { month: "2026-03", value: 5000 },
      ],
      windowFrom: "2026-01",
      windowTo: "2026-03",
    });
    expect(rows).toEqual([
      { month: "2026-01", amount: 1000 },
      { month: "2026-02", amount: 1000 },
      { month: "2026-03", amount: 5900 },
    ]);
  });
});

describe("месяцы", () => {
  it("сдвигается через границу года", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(addMonths("2026-10", -6)).toBe("2026-04");
  });

  it("перечисляет месяцы включительно", () => {
    expect(monthRange("2026-09", "2026-11")).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(monthRange("2026-10", "2026-10")).toEqual(["2026-10"]);
  });
});

describe("деньги по валютам", () => {
  it("не показывает нулевые строки", () => {
    expect(isZeroAmount(0)).toBe(true);
    expect(isZeroAmount(0.004)).toBe(true);
    expect(isZeroAmount(0.01)).toBe(false);
    expect(
      amountsByCurrency([
        { currency: "RUB", value: 100 },
        { currency: "USD", value: 5 },
        { currency: "USD", value: -5 },
      ]),
    ).toEqual([{ currency: "RUB", value: 100 }]);
  });

  it("рубли первыми, остальные по алфавиту", () => {
    expect(sortCurrencies(["USD", "RUB", "EUR", "RUB"])).toEqual(["RUB", "EUR", "USD"]);
  });

  it("округляет до копеек, чтобы суммы не дрожали", () => {
    expect(amountsByCurrency([{ currency: "RUB", value: 0.1 + 0.2 }])).toEqual([
      { currency: "RUB", value: 0.3 },
    ]);
  });
});