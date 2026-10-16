"use client";

import { useMemo, useState } from "react";
import { formatMoney } from "@/lib/format";
import {
  COMPOUNDING_OPTIONS,
  addMonths,
  compoundingLabel,
  monthlySchedule,
  project,
  realValue,
  timesInflation,
  type Compounding,
} from "@/lib/savings";

const inputClass = "border border-ink-300 rounded-md px-3 py-2 text-sm w-full";
const labelClass = "text-xs text-ink-500 block mb-1";

/**
 * Сценарий «а если положу»: сумма, ставка и срок меняются — результат
 * пересчитывается сразу, без кнопок. Та же формула, что и у сохранённых вкладов.
 */
export function SavingsCalculator() {
  const [principal, setPrincipal] = useState("100000");
  const [annualRate, setAnnualRate] = useState("12");
  const [months, setMonths] = useState("36");
  const [monthlyContribution, setMonthlyContribution] = useState("0");
  const [compounding, setCompounding] = useState<Compounding>("monthly");
  const [inflation, setInflation] = useState("8");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));

  const view = useMemo(() => {
    const p = Number(principal) || 0;
    const r = Number(annualRate) || 0;
    const m = Math.max(0, Math.round(Number(months) || 0));
    const inf = Number(inflation) || 0;
    const add = Math.max(0, Number(monthlyContribution) || 0);
    const input = { principal: p, annualRate: r, months: m, compounding, monthlyContribution: add };
    const projection = project(input);
    const real = realValue(projection, inf);
    const ratio = timesInflation(projection, inf);
    const schedule = monthlySchedule(input, startDate);
    return {
      projection,
      real,
      ratio,
      first: schedule[0] ?? null,
      last: schedule[schedule.length - 1] ?? null,
      endDate: addMonths(startDate, m),
    };
  }, [principal, annualRate, months, compounding, inflation, startDate, monthlyContribution]);

  return (
    <div className="bg-white border border-ink-200 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">А если положу…</h2>
        <span className="text-xs text-ink-500">пересчёт сразу при изменении полей</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <div>
          <label className={labelClass}>Сумма</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Ставка, % годовых</label>
          <input
            type="number"
            step="0.01"
            value={annualRate}
            onChange={(e) => setAnnualRate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Срок, месяцев</label>
          <input
            type="number"
            min="0"
            max="600"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Докладывать в месяц</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={monthlyContribution}
            onChange={(e) => setMonthlyContribution(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Капитализация</label>
          <select
            value={compounding}
            onChange={(e) => setCompounding(e.target.value as Compounding)}
            className={inputClass}
          >
            {COMPOUNDING_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Инфляция, % в год (для сравнения)</label>
          <input
            type="number"
            step="0.1"
            value={inflation}
            onChange={(e) => setInflation(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Дата начала</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-lg bg-ink-50 p-3">
          <div className="text-xs text-ink-500">Будет к {view.endDate}</div>
          <div className="text-xl font-semibold tabular-nums mt-1">
            {formatMoney(view.projection.finalAmount)}
          </div>
          <div className="text-xs text-accent-600 mt-1">
            прирост +{formatMoney(view.projection.profit)}
          </div>
          {view.projection.monthlyContribution > 0 ? (
            <div className="text-xs text-ink-500 mt-1">
              вложено {formatMoney(view.projection.invested)} · по{" "}
              {formatMoney(view.projection.monthlyContribution)} в месяц
            </div>
          ) : null}
        </div>
        <div className="rounded-lg bg-ink-50 p-3">
          <div className="text-xs text-ink-500">Доходность</div>
          <div className="text-xl font-semibold tabular-nums mt-1">
            {view.projection.periodPercent}%
          </div>
          <div className="text-xs text-ink-500 mt-1">
            за срок · {view.projection.annualPercent}% в год
          </div>
        </div>
        <div className="rounded-lg bg-ink-50 p-3">
          <div className="text-xs text-ink-500">Покупательная способность</div>
          <div className="text-xl font-semibold tabular-nums mt-1">
            {formatMoney(view.real.realAmount)}
          </div>
          <div className="text-xs text-ink-500 mt-1">
            в ценах сегодняшнего дня · {view.real.realPercent}%
          </div>
        </div>
        <div className="rounded-lg bg-ink-50 p-3">
          <div className="text-xs text-ink-500">К инфляции</div>
          <div className="text-xl font-semibold tabular-nums mt-1">
            {view.ratio === null ? "—" : `× ${view.ratio}`}
          </div>
          <div className="text-xs text-ink-500 mt-1">
            доходность в год против {inflation}% инфляции
          </div>
        </div>
      </div>

      <div className="mt-3 text-xs text-ink-500 space-y-1">
        <div>
          {compoundingLabel(compounding)}
          {view.first && view.last
            ? ` · проценты за первый месяц ≈ ${formatMoney(view.first.interest)}, за последний ≈ ${formatMoney(view.last.interest)}`
            : ""}
        </div>
        {view.ratio !== null && view.ratio < 1 ? (
          <div className="text-ink-700">
            При такой ставке деньги растут медленнее, чем общий уровень цен.
          </div>
        ) : null}
      </div>
    </div>
  );
}