import { db } from "@/db";
import { accounts, categories, operations } from "@/db/schema";
import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import { OperationsTable } from "@/components/OperationsTable";
import { OperationForm } from "@/components/OperationForm";
import { formatMoney, formatDate } from "@/lib/format";
import Link from "next/link";

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
  const limit = 50;
  const offset = (page - 1) * limit;

  const allAccs = await db
    .select()
    .from(accounts)
    .where(eq(accounts.archived, false))
    .orderBy(accounts.name);
  const allCats = await db
    .select()
    .from(categories)
    .where(eq(categories.archived, false))
    .orderBy(categories.name);

  const filters = [] as Array<ReturnType<typeof eq>>;
  if (sp?.account) filters.push(eq(operations.accountId, sp.account));
  if (sp?.category) filters.push(eq(operations.categoryId, sp.category));
  if (sp?.from) filters.push(gte(operations.date, sp.from));
  if (sp?.to) filters.push(lte(operations.date, sp.to));
  if (sp?.q) filters.push(like(operations.description, `%${sp.q}%`));

  const whereExpr = filters.length === 0 ? undefined : and(...filters);

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
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)`.as("c") })
    .from(operations)
    .where(whereExpr);
  const total = Number(totalRow[0]?.c ?? 0);

  const totalAmount = rows.reduce((acc, r) => acc + r.amount, 0);

  return (
    <div className="px-6 py-6 max-w-6xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Операции</h1>
        <Link
          href="/operations/new"
          className="bg-accent-600 text-white text-sm rounded-md px-3 py-1.5 hover:bg-accent-700"
        >
          + Новая операция
        </Link>
      </div>

      <form className="bg-white border border-ink-200 rounded-xl p-3 mb-4 grid grid-cols-2 md:grid-cols-6 gap-2">
        <select
          name="account"
          defaultValue={sp?.account ?? ""}
          className="border border-ink-300 rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">Все счета</option>
          {allAccs.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          name="category"
          defaultValue={sp?.category ?? ""}
          className="border border-ink-300 rounded-md px-2 py-1.5 text-sm"
        >
          <option value="">Все категории</option>
          {allCats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ?? ""} {c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          name="from"
          defaultValue={sp?.from ?? ""}
          className="border border-ink-300 rounded-md px-2 py-1.5 text-sm"
        />
        <input
          type="date"
          name="to"
          defaultValue={sp?.to ?? ""}
          className="border border-ink-300 rounded-md px-2 py-1.5 text-sm"
        />
        <input
          type="search"
          name="q"
          defaultValue={sp?.q ?? ""}
          placeholder="Поиск по описанию"
          className="border border-ink-300 rounded-md px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="bg-ink-800 text-white text-sm rounded-md px-3 py-1.5 hover:bg-ink-900"
        >
          Применить
        </button>
      </form>

      <div className="bg-white border border-ink-200 rounded-xl overflow-hidden">
        <OperationsTable rows={rows} />
      </div>

      <div className="flex items-center justify-between mt-3 text-sm text-ink-600">
        <div>
          Всего записей: {total}, показано {rows.length} (страница {page}) —{" "}
          {formatMoney(totalAmount)}
        </div>
        <Pagination page={page} total={total} limit={limit} />
      </div>
    </div>
  );
}

function Pagination({
  page,
  total,
  limit,
}: {
  page: number;
  total: number;
  limit: number;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex gap-1">
      {Array.from({ length: pages }, (_, i) => i + 1)
        .filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === pages)
        .map((p, idx, arr) => {
          const prev = arr[idx - 1];
          const gap = prev && p - prev > 1 ? (
            <span key={`gap-${p}`} className="px-2 text-ink-400">…</span>
          ) : null;
          return (
            <span key={p} className="flex">
              {gap}
              <Link
                href={`?page=${p}`}
                className={`px-2 py-1 rounded ${
                  p === page
                    ? "bg-accent-600 text-white"
                    : "border border-ink-300 text-ink-700 hover:bg-ink-100"
                }`}
              >
                {p}
              </Link>
            </span>
          );
        })}
    </div>
  );
}