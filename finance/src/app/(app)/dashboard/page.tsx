import Link from "next/link";
import { PieChart, BarChart3, TrendingUp, Wallet } from "lucide-react";

import {
  loadBalances,
  loadCategoryFlow,
  loadCashflow,
  loadNetWorth,
  loadPeriodTotals,
  periodRange,
} from "@/lib/analytics";
import { formatMoney, periodLabel, plural } from "@/lib/format";
import { accountTypeLabel } from "@/lib/dictionaries";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { MoneyValue } from "@/components/MoneyValue";
import { EmptyState } from "@/components/EmptyState";
import { Alert } from "@/components/ui/alert";
import { CategoryChart } from "@/components/CategoryChart";
import { CashflowChart } from "@/components/CashflowChart";
import { NetWorthChart } from "@/components/NetWorthChart";
import { PeriodSelector } from "@/components/PeriodSelector";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const sp = await searchParams;
  const period = sp?.period ?? "month";
  const range = periodRange(period);

  const [balances, expenses, cashflow, networth, totals] = await Promise.all([
    loadBalances(),
    loadCategoryFlow({ from: range.from, to: range.to, sign: "negative" }),
    loadCashflow(range),
    loadNetWorth(range),
    loadPeriodTotals(range),
  ]);

  // Разные валюты не складываются: показываем список строк, а не одну сумму.
  const byCurrency = new Map<string, number>();
  for (const b of balances) {
    byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0) + b.current);
  }
  const moneyNow = [...byCurrency.entries()].map(([currency, value]) => ({ currency, value }));
  const mixed = totals.length > 1;
  const mainCurrency = totals[0]?.currency ?? moneyNow[0]?.currency ?? "RUB";
  const label = periodLabel(period, range);

  const card = (children: React.ReactNode) => (
    <section className="rounded-xl border border-ink-200 bg-white p-4 md:p-5">{children}</section>
  );
  const h2 = (text: string) => <h2 className="mb-3 text-lg font-semibold leading-7 text-ink-900">{text}</h2>;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <PageHeader title="Дашборд" actions={<PeriodSelector />}>
        <p className="text-xs text-ink-500">{label}</p>
      </PageHeader>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Денег сейчас"
          amounts={moneyNow}
          tone="neutral"
          footnote={`${balances.length} ${plural(balances.length, ["счёт", "счёта", "счетов"])}`}
        />
        <MetricCard
          label="Потрачено за период"
          amounts={totals.map((t) => ({ currency: t.currency, value: -t.expense }))}
          footnote={label}
        />
        <MetricCard
          label="Заработано за период"
          amounts={totals.map((t) => ({ currency: t.currency, value: t.income }))}
          footnote={
            mixed || totals.length === 0 ? (
              <span>{label}</span>
            ) : (
              <span className="num">
                Чистыми: {formatMoney(totals[0].income - totals[0].expense, totals[0].currency)}
              </span>
            )
          }
        />
      </div>

      {mixed ? (
        <Alert variant="warning" className="mb-6">
          За период операции в нескольких валютах. Приложение не переводит валюты, поэтому
          разбор по категориям и графики скрыты — итог по ним был бы неверным.
        </Alert>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {card(
          <>
            {h2("Куда уходят деньги")}
            {mixed ? (
              <EmptyState
                icon={PieChart}
                title="Разбор по категориям недоступен"
                description="Операции за период в нескольких валютах — суммы не складываются в один итог"
              />
            ) : expenses.length === 0 ? (
              <EmptyState
                icon={PieChart}
                title="Расходов за период нет"
                description="Здесь появится разбор, куда уходят деньги"
              />
            ) : (
              <CategoryChart items={expenses} currency={mainCurrency} />
            )}
          </>,
        )}

        {card(
          <>
            {h2("Движение денег")}
            {mixed ? (
              <EmptyState
                icon={BarChart3}
                title="График недоступен"
                description="Операции за период в нескольких валютах"
              />
            ) : cashflow.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="Операций за период нет"
                description="Добавьте операции, чтобы увидеть динамику"
                action={
                  <Button asChild>
                    <Link href="/operations/new">＋ Новая операция</Link>
                  </Button>
                }
              />
            ) : (
              <CashflowChart data={cashflow} currency={mainCurrency} />
            )}
          </>,
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {card(
          <>
            {h2("Накопления на конец периода")}
            {mixed ? (
              <EmptyState
                icon={TrendingUp}
                title="График недоступен"
                description="Операции за период в нескольких валютах"
              />
            ) : networth.length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title="Пока недостаточно данных"
                description="Откройте счёт с начальным балансом или добавьте операции"
                action={
                  <Button asChild variant="secondary">
                    <Link href="/accounts">Открыть счёт</Link>
                  </Button>
                }
              />
            ) : (
              <NetWorthChart data={networth} currency={mainCurrency} />
            )}
          </>,
        )}

        {card(
          <>
            {h2("Счета")}
            {balances.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title="Счетов пока нет"
                description="Счёт — это карта, вклад или наличные"
                action={
                  <Button asChild>
                    <Link href="/accounts">＋ Новый счёт</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {balances.map((b) => (
                  <li key={b.accountId} className="flex items-center gap-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-ink-900">{b.accountName}</span>
                      <span className="block text-xs text-ink-500">
                        {accountTypeLabel(b.accountType)} · {b.currency}
                      </span>
                    </span>
                    <MoneyValue amount={b.current} currency={b.currency} size="md" />
                  </li>
                ))}
              </ul>
            )}
          </>,
        )}
      </div>
    </div>
  );
}