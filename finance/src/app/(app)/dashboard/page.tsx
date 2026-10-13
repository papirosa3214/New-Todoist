import {
  loadBalances,
  loadCategoryFlow,
  loadCashflow,
  loadNetWorth,
  periodRange,
} from "@/lib/analytics";
import { formatMoney, formatMonth } from "@/lib/format";
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

  const [balances, expenses, cashflow, networth] = await Promise.all([
    loadBalances(),
    loadCategoryFlow({ from: range.from, to: range.to, sign: "negative" }),
    loadCashflow(range),
    loadNetWorth(range),
  ]);

  const totalCurrent = balances.reduce((acc, b) => acc + b.current, 0);
  const periodExpense = expenses.reduce((acc, e) => acc + e.amount, 0);
  const periodIncome = cashflow.reduce((acc, c) => acc + c.income, 0);

  return (
    <div className="px-6 py-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Дашборд</h1>
        <PeriodSelector />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <div className="text-sm text-ink-500">Текущий баланс</div>
          <div className="text-2xl font-semibold mt-1">
            {formatMoney(totalCurrent)}
          </div>
          <div className="text-xs text-ink-500 mt-1">{balances.length} счет(ов)</div>
        </div>
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <div className="text-sm text-ink-500">Расходы за период</div>
          <div className="text-2xl font-semibold mt-1 text-danger-500">
            {formatMoney(periodExpense)}
          </div>
          <div className="text-xs text-ink-500 mt-1">
            {formatMonth(range.from)} — {formatMonth(range.to)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <div className="text-sm text-ink-500">Доходы за период</div>
          <div className="text-2xl font-semibold mt-1 text-accent-600">
            {formatMoney(periodIncome)}
          </div>
          <div className="text-xs text-ink-500 mt-1">
            Чистый кэш-флоу: {formatMoney(periodIncome - periodExpense)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <h2 className="text-sm font-semibold mb-3">Расходы по категориям</h2>
          {expenses.length === 0 ? (
            <p className="text-sm text-ink-500">Нет расходов за период.</p>
          ) : (
            <CategoryChart items={expenses.slice(0, 8)} />
          )}
        </div>
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <h2 className="text-sm font-semibold mb-3">Кэш-флоу помесячно</h2>
          {cashflow.length === 0 ? (
            <p className="text-sm text-ink-500">Нет операций за период.</p>
          ) : (
            <CashflowChart data={cashflow} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <h2 className="text-sm font-semibold mb-3">Net worth (накопления)</h2>
          {networth.length === 0 ? (
            <p className="text-sm text-ink-500">
              Пока недостаточно данных. Добавьте операции или откройте счёт с
              начальным балансом.
            </p>
          ) : (
            <NetWorthChart data={networth} />
          )}
        </div>
        <div className="bg-white rounded-xl border border-ink-200 p-4">
          <h2 className="text-sm font-semibold mb-3">Счета</h2>
          {balances.length === 0 ? (
            <p className="text-sm text-ink-500">
              Счетов нет.{" "}
              <a className="text-accent-600 underline" href="/accounts">
                Создать
              </a>
              .
            </p>
          ) : (
            <ul className="divide-y divide-ink-200">
              {balances.map((b) => (
                <li key={b.accountId} className="py-2 flex justify-between text-sm">
                  <span className="text-ink-700">{b.accountName}</span>
                  <span className="font-medium">{formatMoney(b.current, b.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}