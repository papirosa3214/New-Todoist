/**
 * Запросы аналитики: текущий баланс по счетам, расходы/доходы по категориям,
 * кэш-флоу помесячно, net worth помесячно.
 *
 * Считаются на лету — для одного владельца это ок. Если объём вырастет —
 * переводим в материализованные витрины (balance_snapshots).
 */
import { db } from "@/db";
import { accounts, operations, categories } from "@/db/schema";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export type BalanceByAccount = {
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  openingBalance: number;
  net: number;
  current: number;
};

export async function loadBalances(): Promise<BalanceByAccount[]> {
  const allAccounts = await db.select().from(accounts).where(eq(accounts.archived, false));
  const rows = await db
    .select({
      accountId: operations.accountId,
      net: sql<number>`COALESCE(SUM(${operations.amount}), 0)`.as("net"),
    })
    .from(operations)
    .groupBy(operations.accountId);
  const netByAccount = new Map<string, number>();
  for (const r of rows) netByAccount.set(r.accountId, Number(r.net) || 0);

  return allAccounts.map((a) => {
    const net = netByAccount.get(a.id) ?? 0;
    return {
      accountId: a.id,
      accountName: a.name,
      accountType: a.type,
      currency: a.currency,
      openingBalance: a.openingBalance,
      net,
      current: a.openingBalance + net,
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

export async function loadCashflow(args: { from: string; to: string }): Promise<MonthlyFlow[]> {
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
    .where(and(gte(operations.date, args.from), lte(operations.date, args.to)))
    .groupBy(sql`substr(${operations.date}, 1, 7)`)
    .orderBy(sql`substr(${operations.date}, 1, 7)`);

  return rows.map((r) => {
    const income = Number(r.income) || 0;
    const expense = Number(r.expense) || 0;
    return { month: r.month, income, expense, net: income - expense };
  });
}

export async function loadNetWorth(args: { from: string; to: string }): Promise<
  Array<{ month: string; amount: number }>
> {
  // Net worth на конец каждого месяца = сумма opening_balance + кумулятивная сумма операций до конца месяца.
  const allAccounts = await db.select().from(accounts);
  const openingTotal = allAccounts.reduce(
    (acc, a) =>
      new Date(a.openingDate) <= new Date(args.to)
        ? acc + a.openingBalance
        : acc,
    0,
  );

  const rows = await db
    .select({
      month: sql<string>`substr(${operations.date}, 1, 7)`.as("month"),
      net: sql<number>`COALESCE(SUM(${operations.amount}), 0)`.as("net"),
    })
    .from(operations)
    .where(and(gte(operations.date, args.from), lte(operations.date, args.to)))
    .groupBy(sql`substr(${operations.date}, 1, 7)`)
    .orderBy(sql`substr(${operations.date}, 1, 7)`);

  let cum = 0;
  const out: Array<{ month: string; amount: number }> = [];
  for (const r of rows) {
    cum += Number(r.net) || 0;
    out.push({ month: r.month, amount: openingTotal + cum });
  }
  return out;
}

export function periodRange(period: "week" | "month" | "quarter" | "year" | string): {
  from: string;
  to: string;
} {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today);
  switch (period) {
    case "week":
      from.setDate(today.getDate() - 7);
      break;
    case "month":
      from.setMonth(today.getMonth() - 1);
      break;
    case "quarter":
      from.setMonth(today.getMonth() - 3);
      break;
    case "year":
      from.setFullYear(today.getFullYear() - 1);
      break;
    default:
      // произвольный диапазон: period = "YYYY-MM-DD_YYYY-MM-DD"
      const parts = period.split("_");
      if (parts.length === 2) return { from: parts[0], to: parts[1] };
      from.setMonth(today.getMonth() - 1);
  }
  return { from: from.toISOString().slice(0, 10), to };
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
