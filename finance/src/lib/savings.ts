/**
 * Расчёты по накоплениям и вкладам.
 *
 * Модуль чистый: без БД, React и сетевых вызовов. Формулы одинаковые и для
 * сохранённых вкладов, и для сценария «а если положу», поэтому проверяются
 * обычными тестами (tests/savings.test.ts).
 *
 * Все проценты — годовые, в долях берутся как pct / 100.
 * Сложный процент: A = P * (1 + r / m) ^ (m * t),
 * где m — число капитализаций в год, t — срок в годах.
 * Без капитализации: A = P * (1 + r * t).
 */

export const COMPOUNDING_OPTIONS = [
  { value: "monthly", label: "Ежемесячно (12 раз в год)" },
  { value: "quarterly", label: "Ежеквартально (4 раза в год)" },
  { value: "yearly", label: "Ежегодно (1 раз в год)" },
  { value: "none", label: "Без капитализации (простые проценты)" },
] as const;

export type Compounding = (typeof COMPOUNDING_OPTIONS)[number]["value"];

export const SAVINGS_KINDS = [
  { value: "deposit", label: "Вклад в банке" },
  { value: "savings", label: "Накопительный счёт" },
  { value: "certificate", label: "Сертификат / облигация" },
  { value: "other", label: "Другое" },
] as const;

export type SavingsKind = (typeof SAVINGS_KINDS)[number]["value"];

export function compoundingPerYear(compounding: Compounding): number {
  switch (compounding) {
    case "monthly":
      return 12;
    case "quarterly":
      return 4;
    case "yearly":
      return 1;
    case "none":
      return 0;
  }
}

export function compoundingLabel(compounding: Compounding): string {
  return COMPOUNDING_OPTIONS.find((o) => o.value === compounding)?.label ?? compounding;
}

export function savingsKindLabel(kind: SavingsKind): string {
  return SAVINGS_KINDS.find((o) => o.value === kind)?.label ?? kind;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function safe(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export type SavingsInput = {
  principal: number;
  annualRate: number;
  months: number;
  compounding: Compounding;
  /**
   * Ежемесячное пополнение вклада. Добавляется в конце каждого месяца, поэтому
   * в первый месяц процентов на него ещё нет, а к последнему месяцу сумма уже
   * полная. Ноль означает старый расчёт без пополнений.
   */
  monthlyContribution?: number;
};

/** Срок в целых месяцах: отрицательные и дробные значения приводятся к 0. */
export function normalizeMonths(months: number): number {
  const m = Math.round(safe(months));
  return m > 0 ? m : 0;
}

/** Ежемесячное пополнение: нечисло и отрицательное значение — ноль. */
export function normalizeContribution(value: number | undefined): number {
  const v = Math.round(safe(value ?? 0) * 100) / 100;
  return v > 0 ? v : 0;
}

/**
 * Размер вклада к концу срока по формуле сложного процента.
 * Без капитализации считаются простые проценты.
 */
export function futureValue(
  principal: number,
  annualRate: number,
  months: number,
  compounding: Compounding,
): number {
  return round2(project({ principal, annualRate, months, compounding }).finalAmount);
}

/**
 * Тот же расчёт, но накоплением по периодам: r / m начисляется m * t раз.
 * Нужен как независимая проверка закрытой формулы и для графика по периодам.
 */
export function steppedFutureValue(input: SavingsInput): number {
  const principal = safe(input.principal);
  const months = normalizeMonths(input.months);
  if (principal <= 0 || months === 0) return round2(principal);
  return round2(monthlyAccumulation(input).balance);
}

/**
 * Помесячный набор: одна схема для обоих режимов капитализации.
 *
 * Каждый месяц сначала начисляются проценты на то, что уже лежит, и только
 * потом в конец месяца добавляется пополнение. Поэтому на пополнение первого
 * месяца процентов ещё не было, а на последнее — уже целый год.
 *
 * Сложный процент (perYear > 0): за месяц начисляется perYear / 12 периодах,
 * ставка периода r / perYear. Без капитализации (perYear = 0) — простые
 * проценты r / 12 от всего, что на счёте.
 */
type MonthlyAccumulation = { balance: number; rows: Omit<ScheduleRow, "date">[] };

function monthlyAccumulation(input: SavingsInput): MonthlyAccumulation {
  const principal = safe(input.principal);
  const months = normalizeMonths(input.months);
  const r = safe(input.annualRate) / 100;
  const perYear = compoundingPerYear(input.compounding);
  const contribution = normalizeContribution(input.monthlyContribution);

  const rows: Omit<ScheduleRow, "date">[] = [];
  let balance = principal;

  for (let m = 1; m <= months; m += 1) {
    let interest: number;
    if (perYear === 0) {
      interest = (balance * r) / 12;
    } else {
      const ratePerPeriod = r / perYear;
      const periodsThisMonth = perYear / 12;
      interest = balance * (Math.pow(1 + ratePerPeriod, periodsThisMonth) - 1);
    }
    balance = balance + interest;
    rows.push({ month: m, interest: round2(interest), balance: round2(balance) });
    // Пополнение приходит в конце месяца: на него проценты начисляются
    // только со следующего месяца, но в записи графика он уже виден.
    if (contribution > 0) {
      balance = balance + contribution;
      rows[rows.length - 1].balance = round2(balance);
    }
  }
  return { balance, rows };
}

export type Projection = {
  principal: number;
  finalAmount: number;
  profit: number;
  /** Доходность за весь срок, % */
  periodPercent: number;
  /** Доходность в год (приведённая), % */
  annualPercent: number;
  months: number;
  years: number;
  /** Сколько всего вложено: стартовая сумма плюс все пополнения */
  invested: number;
  /** Ежемесячное пополнение, ноль если его нет */
  monthlyContribution: number;
};

/** Полный расчёт по вкладу: сумма к концу срока, прирост и доходность. */
export function project(input: SavingsInput): Projection {
  const principal = safe(input.principal);
  const months = normalizeMonths(input.months);
  const years = months / 12;
  const contribution = normalizeContribution(input.monthlyContribution);
  // Сумма, реально внесённая за срок: стартовая плюс все пополнения. Это и есть
  // база для доходности — иначе пополнения выглядели бы как чистый процент.
  const invested = round2(principal + contribution * months);

  let raw: number;
  if (principal <= 0 || months === 0) {
    raw = principal;
  } else if (contribution > 0) {
    raw = monthlyAccumulation(input).balance;
  } else {
    const r = safe(input.annualRate) / 100;
    const perYear = compoundingPerYear(input.compounding);
    raw = perYear === 0 ? principal * (1 + r * years) : principal * Math.pow(1 + r / perYear, perYear * years);
  }

  const finalAmount = round2(raw);
  const profit = round2(finalAmount - invested);
  const periodPercent = invested > 0 ? round2((profit / invested) * 100) : 0;
  const annualPercent =
    invested > 0 && months > 0
      ? round2((Math.pow(finalAmount / invested, 12 / months) - 1) * 100)
      : 0;

  return {
    principal: round2(principal),
    finalAmount,
    profit,
    periodPercent,
    annualPercent,
    months,
    years,
    invested,
    monthlyContribution: contribution,
  };
}

export type ScheduleRow = {
  /** Номер месяца, 1 — первый месяц после открытия */
  month: number;
  /** Дата конца месяца, YYYY-MM-DD */
  date: string;
  /** Начисленные за месяц проценты */
  interest: number;
  /** Сумма на счёте на конец месяца */
  balance: number;
};

/**
 * Помесячный график: сколько начислено и сколько на счёте после каждого месяца.
 * dateStart — дата открытия вклада, YYYY-MM-DD.
 */
export function monthlySchedule(input: SavingsInput, dateStart: string): ScheduleRow[] {
  const principal = safe(input.principal);
  const months = normalizeMonths(input.months);
  if (principal <= 0 || months === 0) return [];

  const { rows } = monthlyAccumulation(input);
  return rows.map((row) => ({ ...row, date: addMonths(dateStart, row.month) }));
}

/** Реальная сумма после инфляции: сколько покупает накопленное в рублях сегодня. */
export function realValue(projection: Projection, inflationPercent: number): {
  realAmount: number;
  realProfit: number;
  realPercent: number;
} {
  const inflation = safe(inflationPercent) / 100;
  const factor = Math.pow(1 + inflation, projection.years);
  const realAmount = round2(projection.finalAmount / factor);
  const realProfit = round2(realAmount - projection.principal);
  const realPercent =
    projection.principal > 0 ? round2((realProfit / projection.principal) * 100) : 0;
  return { realAmount, realProfit, realPercent };
}

/** Во сколько раз доходность выше инфляции. */
export function timesInflation(projection: Projection, inflationPercent: number): number | null {
  const inflation = safe(inflationPercent);
  if (inflation <= 0 || projection.annualPercent <= 0) return null;
  return round2(projection.annualPercent / inflation);
}

export type SavingsTotals = {
  principal: number;
  /** Сколько всего вложено: стартовые суммы плюс все пополнения */
  invested: number;
  finalAmount: number;
  profit: number;
};

export type SavingsTotalsByCurrency = {
  total: SavingsTotals;
  byCurrency: Record<string, SavingsTotals>;
};

/** Суммарно по нескольким вкладам. Валюты не смешиваются: итог по каждой отдельно. */
export function summarize(
  items: (SavingsInput & { currency: string })[],
): SavingsTotalsByCurrency {
  const total: SavingsTotals = { principal: 0, invested: 0, finalAmount: 0, profit: 0 };
  const byCurrency: Record<string, SavingsTotals> = {};

  for (const item of items) {
    const p = project(item);
    const cur = item.currency || "RUB";
    const bucket = (byCurrency[cur] ??= { principal: 0, invested: 0, finalAmount: 0, profit: 0 });
    bucket.principal = round2(bucket.principal + p.principal);
    bucket.invested = round2(bucket.invested + p.invested);
    bucket.finalAmount = round2(bucket.finalAmount + p.finalAmount);
    bucket.profit = round2(bucket.profit + p.profit);
    total.principal = round2(total.principal + p.principal);
    total.invested = round2(total.invested + p.invested);
    total.finalAmount = round2(total.finalAmount + p.finalAmount);
    total.profit = round2(total.profit + p.profit);
  }
  return { total, byCurrency };
}

/** Дата конца срока: старт плюс срок в месяцах, YYYY-MM-DD. */
export function addMonths(dateIso: string, months: number): string {
  const base = /^\d{4}-\d{2}-\d{2}/.test(dateIso)
    ? new Date(`${dateIso.slice(0, 10)}T00:00:00Z`)
    : new Date();
  if (Number.isNaN(base.getTime())) return dateIso;
  const d = new Date(base.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + Math.round(safe(months)));
  // 31 января + 3 месяца = 30 апреля, а не 1 мая: дата не перескакивает в следующий месяц
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/** Осталось месяцев до конца срока начиная с todayIso (YYYY-MM-DD). */
export function monthsLeft(endDate: string, todayIso: string): number {
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  const now = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || Number.isNaN(now.getTime())) return 0;
  if (end <= now) return 0;
  let months =
    (end.getUTCFullYear() - now.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - now.getUTCMonth());
  if (end.getUTCDate() < now.getUTCDate()) months -= 1;
  return months > 0 ? months : 0;
}