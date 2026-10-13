import Link from "next/link";
import { PieChart, BarChart3, TrendingUp, Wallet, TriangleAlert } from "lucide-react";

import {
  loadBalances,
  loadCategoryFlow,
  loadCashflow,
  loadNetWorth,
  loadPeriodTotals,
} from "@/lib/analytics";
import { amountsByCurrency, isZeroAmount, sortCurrencies } from "@/lib/series";
import { formatMoney, periodLabel, periodRange, plural } from "@/lib/format";
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
import { CurrencySelector } from "@/components/CurrencySelector";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; currency?: string }>;
}) {
  const sp = await searchParams;
  const period = sp?.period ?? "month";
  const range = periodRange(period);

  const [balances, totals] = await Promise.all([loadBalances(), loadPeriodTotals(range)]);

  // Аналитика всегда в одной валюте: валюты не складываются (раздел 5.6).
  // Список — из счетов и операций периода, чтобы переключатель не прятал данные.
  const currencies = sortCurrencies([
    ...balances.map((b) => b.currency),
    ...totals.map((t) => t.currency),
  ]);
  const requested = sp?.currency ?? "";
  const currency = currencies.includes(requested)
    ? requested
    : (currencies[0] ?? "RUB");
  const mixed = currencies.length > 1;

  const [expenses, cashflow, networth] = await Promise.all([
    loadCategoryFlow({ from: range.from, to: range.to, sign: "negative", currency }),
    loadCashflow({ from: range.from, to: range.to, currency }),
    loadNetWorth({ from: range.from, to: range.to, currency }),
  ]);

  const moneyNow = amountsByCurrency(
    balances.map((b) => ({ currency: b.currency, value: b.current })),
  );
  const selectedTotal = totals.find((t) => t.currency === currency);
  const spent = selectedTotal && !isZeroAmount(selectedTotal.expense) ? selectedTotal.expense : 0;
  const earned = selectedTotal ? selectedTotal.income : 0;
  const label = periodLabel(period, range);
  const foreignTotal = balances.reduce((acc, b) => acc + b.foreign, 0);

  const card = (children: React.ReactNode) => (
    <section className="rounded-xl border border-ink-200 bg-white p-4 md:p-5">{children}</section>
  );
  const h2 = (text: string) => <h2 className="mb-3 text-lg font-semibold leading-7 text-ink-900">{text}</h2>;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <PageHeader
        title="Дашборд"
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {mixed ? <CurrencySelector currencies={currencies} value={currency} /> : null}
            <PeriodSelector />
          </div>
        }
      >
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
          amount={-spent}
          currency={currency}
          footnote={label}
        />
        <MetricCard
          label="Заработано за период"
          amount={earned}
          currency={currency}
          footnote={
            <span className="num">
              Чистыми: {formatMoney(earned - spent, currency)}
            </span>
          }
        />
      </div>

      {mixed ? (
        <Alert variant="warning" className="mb-6">
          Приложение не переводит валюты, поэтому разбор, графики и накопления показаны в
          одной валюте — сейчас в {currency}. Полный остаток по всем счетам — в блоке «Денег
          сейчас» и «Счета». Выбрать другую валюту — в переключателе рядом с периодом.
        </Alert>
      ) : null}

      {foreignTotal > 0 ? (
        <Alert variant="warning" className="mb-6">
          <span className="inline-flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {foreignTotal} {plural(foreignTotal, ["операция", "операции", "операций"])} на
              счетах записана в валюте, отличной от валюты счёта, и не вошла в остаток.
              Откройте операцию и сохраните заново — валюта подставится от счёта.
            </span>
          </span>
        </Alert>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {card(
          <>
            {h2("Куда уходят деньги")}
            {expenses.length === 0 ? (
              <EmptyState
                icon={PieChart}
                title="Расходов за период нет"
                description="Здесь появится разбор, куда уходят деньги"
              />
            ) : (
              <CategoryChart items={expenses} currency={currency} />
            )}
          </>,
        )}

        {card(
          <>
            {h2("Движение денег")}
            {cashflow.length === 0 ? (
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
              <CashflowChart data={cashflow} currency={currency} />
            )}
          </>,
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {card(
          <>
            {h2("Накопления на конец периода")}
            {networth.length === 0 ? (
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
              <NetWorthChart data={networth} currency={currency} />
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
                        {b.foreign > 0 ? ` · ${b.foreign} ${plural(b.foreign, ["операция в чужой валюте", "операции в чужой валюте", "операций в чужой валюте"])} не учтено` : ""}
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