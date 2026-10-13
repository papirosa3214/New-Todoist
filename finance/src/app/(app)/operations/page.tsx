import { db } from "@/db";
import { accounts, categories, operations } from "@/db/schema";
import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import Link from "next/link";

import { OperationsFilters } from "@/components/OperationsFilters";
import { OperationsList } from "@/components/OperationsList";
import { PageHeader } from "@/components/PageHeader";
import { MoneyValue } from "@/components/MoneyValue";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { amountsByCurrency } from "@/lib/series";

const LIMIT = 50;

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    category?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp?.page ?? "1") || 1);
  const offset = (page - 1) * LIMIT;

  const filters = {
    account: sp?.account ?? "",
    category: sp?.category ?? "",
    from: sp?.from ?? "",
    to: sp?.to ?? "",
    q: sp?.q ?? "",
  };
  const hasFilters = Object.values(filters).some(Boolean);

  const [allAccs, allCats] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.archived, false)).orderBy(accounts.name),
    db.select().from(categories).where(eq(categories.archived, false)).orderBy(categories.name),
  ]);

  const conditions = [];
  if (filters.account) conditions.push(eq(operations.accountId, filters.account));
  if (filters.category) conditions.push(eq(operations.categoryId, filters.category));
  if (filters.from) conditions.push(gte(operations.date, filters.from));
  if (filters.to) conditions.push(lte(operations.date, filters.to));
  if (filters.q) conditions.push(like(operations.description, `%${filters.q}%`));
  const whereExpr = conditions.length === 0 ? undefined : and(...conditions);

  const rows = await db
    .select({
      id: operations.id,
      date: operations.date,
      amount: operations.amount,
      currency: operations.currency,
      description: operations.description,
      merchant: operations.merchant,
      source: operations.source,
      accountName: accounts.name,
      categoryName: categories.name,
      categoryIcon: categories.icon,
    })
    .from(operations)
    .leftJoin(accounts, eq(accounts.id, operations.accountId))
    .leftJoin(categories, eq(categories.id, operations.categoryId))
    .where(whereExpr)
    .orderBy(desc(operations.date), desc(operations.id))
    .limit(LIMIT)
    .offset(offset);

  // Итоги по валютам: суммы разных валют не складываются (раздел 5.6).
  const summary = await db
    .select({
      currency: operations.currency,
      total: sql<number>`COUNT(*)`.as("total"),
      amount: sql<number>`COALESCE(SUM(${operations.amount}), 0)`.as("amount"),
    })
    .from(operations)
    .where(whereExpr)
    .groupBy(operations.currency);

  const selectionTotals = summary
    .map((s) => ({ currency: s.currency, amount: Number(s.amount) || 0 }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  const pageTotals = amountsByCurrency(
    rows.map((r) => ({ currency: r.currency, value: r.amount })),
  ).map((r) => ({ currency: r.currency, amount: r.value }));
  const total = summary.reduce((acc, s) => acc + Number(s.total || 0), 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <PageHeader
        title="Операции"
        actions={
          <Button asChild>
            <Link href="/operations/new">＋ Новая операция</Link>
          </Button>
        }
      >
        <OperationsFilters
          accounts={allAccs.map((a) => ({ id: a.id, name: a.name }))}
          categories={allCats.map((c) => ({ id: c.id, name: c.name, icon: c.icon }))}
          value={filters}
          page={page}
        />
      </PageHeader>

      <OperationsList rows={rows} filtered={hasFilters} />

      {rows.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2 text-sm text-ink-600">
            <TotalsLine label="Итого по выборке" rows={selectionTotals} />
            <TotalsLine label="Итого на странице" rows={pageTotals} />
            <p className="text-xs text-ink-500">
              {total} {plural(total, ["запись", "записи", "записей"])} · страница {page} из{" "}
              {Math.max(1, Math.ceil(total / LIMIT))}
            </p>
          </div>
          <Pagination page={page} total={total} filters={filters} />
        </div>
      ) : null}
    </div>
  );
}

/** Раздел 5, правило 5: две подписи итогов, каждая — по строке на валюту. */
function TotalsLine({
  label,
  rows,
}: {
  label: string;
  rows: Array<{ currency: string; amount: number }>;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="shrink-0">{label}:</span>
      {rows.length === 0 ? (
        <MoneyValue amount={0} currency="RUB" size="sm" signed className="font-medium text-ink-900" />
      ) : (
        rows.map((r) => (
          <MoneyValue
            key={r.currency}
            amount={r.amount}
            currency={r.currency}
            size="sm"
            signed
            className="font-medium text-ink-900"
          />
        ))
      )}
    </div>
  );
}

function Pagination({
  page,
  total,
  filters,
}: {
  page: number;
  total: number;
  filters: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  if (pages <= 1) return null;

  const href = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    params.set("page", String(p));
    return `/operations?${params.toString()}`;
  };

  return (
    <div className="flex items-center gap-1">
      <Button asChild variant="outline" size="sm" className="md:hidden" aria-label="Назад">
        <Link href={href(Math.max(1, page - 1))}>←</Link>
      </Button>
      {Array.from({ length: pages }, (_, i) => i + 1)
        .filter((p) => Math.abs(p - page) <= 1 || p === 1 || p === pages)
        .map((p, idx, arr) => {
          const prev = arr[idx - 1];
          const gap = prev && p - prev > 1 ? (
            <span key={`gap-${p}`} className="px-2 text-ink-400">
              …
            </span>
          ) : null;
          return (
            <span key={p} className="flex">
              {gap}
              <Link
                href={href(p)}
                aria-current={p === page ? "page" : undefined}
                className={`hidden min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm md:inline-flex ${
                  p === page
                    ? "bg-accent-600 font-medium text-white"
                    : "border border-ink-200 bg-white text-ink-700 hover:bg-ink-100"
                }`}
              >
                {p}
              </Link>
            </span>
          );
        })}
      <span className="px-2 text-sm text-ink-600 md:hidden">
        Страница {page} из {pages}
      </span>
      <Button asChild variant="outline" size="sm" className="md:hidden" aria-label="Вперёд">
        <Link href={href(Math.min(pages, page + 1))}>→</Link>
      </Button>
    </div>
  );
}