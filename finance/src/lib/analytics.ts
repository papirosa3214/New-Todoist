/**
 * Запросы аналитики: текущий баланс по счетам, расходы/доходы по категориям,
 * кэш-флоу помесячно, накопления помесячно.
 *
 * Считаются на лету — для одного владельца это ок. Если объём вырастет —
 * переводим в материализованные витрины (balance_snapshots).
 *
 * Правило раздела 5 дизайн-системы: валюты не складываются. Остаток счёта и
 * аналитика берут операции той же валюты, что и счёт (FIN-03), а не любые.
 */
import { db } from "@/db";
import { accounts, operations, categories } from "@/db/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  buildNetWorthSeries,
  monthKey,
  netWorthWindow,
  round2,
} from "@/lib/series";

export type BalanceByAccount = {
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  openingBalance: number;
  net: number;
  current: number;
  /** Операции счёта в чужой валюте: в остаток не вошли, но они не исчезли. */
  foreign: number;
};

export async function loadBalances(): Promise<BalanceByAccount[]> {
  const allAccounts = await db.select().from(accounts).where(eq(accounts.archived, false));
  const rows = await db
    .select({
      accountId: operations.accountId,
      currency: operations.currency,
      net: sql<number>`COALESCE(SUM(${operations.amount}), 0)`.as("net"),
      count: sql<number>`COUNT(*)`.as("cnt"),
    })
    .from(operations)
    .groupBy(operations.accountId, operations.currency);

  const netByAccount = new Map<string, number>();
  const foreignByAccount = new Map<string, number>();
  for (const r of rows) {
    const account = allAccounts.find((a) => a.id === r.accountId);
    if (!account) continue;
    if (r.currency === account.currency) {
      netByAccount.set(r.accountId, (netByAccount.get(r.accountId) ?? 0) + Number(r.net));
    } else {
      // Чужая валюта не переводится и не подменяется: считаем и показываем отдельно.
      foreignByAccount.set(r.accountId, (foreignByAccount.get(r.accountId) ?? 0) + Number(r.count));
    }
  }

  return allAccounts.map((a) => {
    const net = netByAccount.get(a.id) ?? 0;
    return {
      accountId: a.id,
      accountName: a.name,
      accountType: a.type,
      currency: a.currency,
      openingBalance: a.openingBalance,
      net,
      current: round2(a.openingBalance + net),
      foreign: foreignByAccount.get(a.id) ?? 0,
    };
  });
}

export type CategoryFlow = {
  categoryId: string | null;
  categoryName: string;
  icon: string | null;
  amount: number;
};

export async function loadCategoryFlow(args: {
  from: string;
  to: string;
  sign: "negative" | "positive";
  currency: string;
}): Promise<CategoryFlow[]> {
  const cond =
    args.sign === "negative"
      ? sql<number>`${operations.amount} < 0`
      : sql<number>`${operations.amount} > 0`;
  const rows = await db
    .select({
      categoryId: operations.categoryId,
      categoryName: sql<string>`COALESCE(${categories.name}, 'Без категории')`.as(
        "category_name",
      ),
      icon: categories.icon,
      amount: sql<number>`SUM(ABS(${operations.amount}))`.as("amount"),
    })
    .from(operations)
    .leftJoin(categories, eq(categories.id, operations.categoryId))
    .where(
      and(
        gte(operations.date, args.from),
        lte(operations.date, args.to),
        cond,
        eq(operations.currency, args.currency),
      ),
    )
    .groupBy(operations.categoryId, categories.name, categories.icon)
    .orderBy(sql`amount DESC`);

  return rows.map((r) => ({
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? "Без категории",
    icon: r.icon ?? null,
    amount: Number(r.amount) || 0,
  }));
}

export type MonthlyFlow = { month: string; income: number; expense: number; net: number };

export async function loadCashflow(args: {
  from: string;
  to: string;
  currency: string;
}): Promise<MonthlyFlow[]> {
  const rows = await db
    .select({
      month: sql<string>`substr(${operations.date}, 1, 7)`.as("month"),
      income: sql<number>`COALESCE(SUM(CASE WHEN ${operations.amount} > 0 THEN ${operations.amount} ELSE 0 END), 0)`.as(
        "income",
      ),
      expense: sql<number>`COALESCE(SUM(CASE WHEN ${operations.amount} < 0 THEN -${operations.amount} ELSE 0 END), 0)`.as(
        "expense",
      ),
    })
    .from(operations)
    .where(
      and(
        gte(operations.date, args.from),
        lte(operations.date, args.to),
        eq(operations.currency, args.currency),
      ),
    )
    .groupBy(sql`substr(${operations.date}, 1, 7)`)
    .orderBy(sql`substr(${operations.date}, 1, 7)`);

  return rows.map((r) => {
    const income = Number(r.income) || 0;
    const expense = Number(r.expense) || 0;
    return { month: r.month, income, expense, net: round2(income - expense) };
  });
}

/**
 * Накопления на конец месяца — в одной валюте.
 *
 * Копится вся история до `to`, а не только операции внутри периода: иначе одно
 * и то же число прыгает при переключении периода (FIN-05). Период задаёт окно
 * показа, последняя точка обрезана на `to`, поэтому «−12 тыс» в конце месяца —
 * сумма на сегодня, а не прогноз до конца месяца.
 */
export async function loadNetWorth(args: {
  from: string;
  to: string;
  currency: string;
}): Promise<Array<{ month: string; amount: number }>> {
  const allAccounts = await db.select().from(accounts).where(eq(accounts.currency, args.currency));

  const openingByMonth = allAccounts
    .filter((a) => a.openingDate <= args.to)
    .map((a) => ({ month: monthKey(a.openingDate), value: a.openingBalance }));

  const rows = await db
    .select({
      month: sql<string>`substr(${operations.date}, 1, 7)`.as("month"),
      net: sql<number>`COALESCE(SUM(${operations.amount}), 0)`.as("net"),
    })
    .from(operations)
    .where(and(lte(operations.date, args.to), eq(operations.currency, args.currency)))
    .groupBy(sql`substr(${operations.date}, 1, 7)`)
    .orderBy(sql`substr(${operations.date}, 1, 7)`);

  const monthlyNet = rows.map((r) => ({ month: r.month, value: Number(r.net) || 0 }));
  const { windowFrom, windowTo } = netWorthWindow({ from: args.from, to: args.to });
  return buildNetWorthSeries({ monthlyNet, openingByMonth, windowFrom, windowTo });
}

/**
 * Итоги за период по валютам: суммы разных валют не складываются
 * (раздел 5.6 и 4.8 дизайн-системы).
 */
export async function loadPeriodTotals(args: {
  from: string;
  to: string;
}): Promise<Array<{ currency: string; income: number; expense: number }>> {
  const rows = await db
    .select({
      currency: operations.currency,
      income: sql<number>`COALESCE(SUM(CASE WHEN ${operations.amount} > 0 THEN ${operations.amount} ELSE 0 END), 0)`.as(
        "income",
      ),
      expense: sql<number>`COALESCE(SUM(CASE WHEN ${operations.amount} < 0 THEN -${operations.amount} ELSE 0 END), 0)`.as(
        "expense",
      ),
    })
    .from(operations)
    .where(and(gte(operations.date, args.from), lte(operations.date, args.to)))
    .groupBy(operations.currency);

  return rows.map((r) => ({
    currency: r.currency,
    income: Number(r.income) || 0,
    expense: Number(r.expense) || 0,
  }));
}