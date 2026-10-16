"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";
import {
  COMPOUNDING_OPTIONS,
  SAVINGS_KINDS,
  addMonths,
  compoundingLabel,
  project,
  savingsKindLabel,
  summarize,
  type Compounding,
  type SavingsKind,
} from "@/lib/savings";

export type SavingsItem = {
  id: string;
  name: string;
  kind: string;
  currency: string;
  principal: number;
  annualRate: number;
  compounding: string;
  startDate: string;
  months: number;
  monthlyContribution: number;
  note: string | null;
};

const inputClass =
  "border border-ink-300 rounded-md px-3 py-2 text-sm w-full";
const labelClass = "text-xs text-ink-500 block mb-1";

export function SavingsManager({ items }: { items: SavingsItem[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SavingsKind>("deposit");
  const [currency, setCurrency] = useState("RUB");
  const [principal, setPrincipal] = useState("100000");
  const [annualRate, setAnnualRate] = useState("12");
  const [compounding, setCompounding] = useState<Compounding>("monthly");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [months, setMonths] = useState("12");
  const [monthlyContribution, setMonthlyContribution] = useState("0");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      items.map((item) => {
        const projection = project({
          principal: item.principal,
          annualRate: item.annualRate,
          months: item.months,
          compounding: item.compounding as Compounding,
          monthlyContribution: item.monthlyContribution,
        });
        return { ...item, projection, endDate: addMonths(item.startDate, item.months) };
      }),
    [items],
  );

  const totals = useMemo(
    () =>
      summarize(
        items.map((item) => ({
          principal: item.principal,
          annualRate: item.annualRate,
          months: item.months,
          compounding: item.compounding as Compounding,
          monthlyContribution: item.monthlyContribution,
          currency: item.currency,
        })),
      ),
    [items],
  );

  function resetForm() {
    setEditingId(null);
    setName("");
    setKind("deposit");
    setCurrency("RUB");
    setPrincipal("100000");
    setAnnualRate("12");
    setCompounding("monthly");
    setMonths("12");
    setMonthlyContribution("0");
    setError(null);
  }

  function startEdit(item: SavingsItem) {
    setEditingId(item.id);
    setName(item.name);
    setKind(item.kind as SavingsKind);
    setCurrency(item.currency);
    setPrincipal(String(item.principal));
    setAnnualRate(String(item.annualRate));
    setCompounding(item.compounding as Compounding);
    setStartDate(item.startDate);
    setMonths(String(item.months));
    setMonthlyContribution(String(item.monthlyContribution ?? 0));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const payload = {
      name: name.trim(),
      kind,
      currency,
      principal: Number(principal) || 0,
      annualRate: Number(annualRate) || 0,
      compounding,
      startDate,
      months: Math.max(1, Number(months) || 1),
      monthlyContribution: Math.max(0, Number(monthlyContribution) || 0),
      note: null,
    };
    try {
      const res = await fetch(
        editingId ? `/api/savings/${editingId}` : "/api/savings",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось сохранить");
        return;
      }
      resetForm();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function remove(item: SavingsItem) {
    if (!window.confirm(`Удалить «${item.name}»?`)) return;
    const res = await fetch(`/api/savings/${item.id}`, { method: "DELETE" });
    if (res.ok) {
      if (editingId === item.id) resetForm();
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={submit}
        className="bg-white border border-ink-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3"
      >
        <div className="md:col-span-2">
          <label className={labelClass}>Название</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, вклад в Тинькофф"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Тип</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SavingsKind)}
            className={inputClass}
          >
            {SAVINGS_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Валюта</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={inputClass}
          >
            <option value="RUB">RUB — ₽</option>
            <option value="USD">USD — $</option>
            <option value="EUR">EUR — €</option>
            <option value="CNY">CNY — ¥</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Сумма сейчас</label>
          <input
            required
            type="number"
            step="0.01"
            min="0"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
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
          <label className={labelClass}>Ставка, % годовых</label>
          <input
            required
            type="number"
            step="0.01"
            value={annualRate}
            onChange={(e) => setAnnualRate(e.target.value)}
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
          <label className={labelClass}>Срок, месяцев</label>
          <input
            required
            type="number"
            min="1"
            max="600"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Дата открытия</label>
          <input
            required
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex items-end gap-2 md:col-span-4">
          <button
            type="submit"
            disabled={pending}
            className="bg-accent-600 text-white text-sm rounded-md px-4 py-2 hover:bg-accent-700 disabled:opacity-60"
          >
            {pending ? "Сохраняем…" : editingId ? "Сохранить изменения" : "+ Добавить накопление"}
          </button>
          {editingId ? (
            <button
              type="button"
              onClick={resetForm}
              className="text-sm text-ink-600 hover:text-ink-900 border border-ink-300 rounded-md px-4 py-2"
            >
              Отмена
            </button>
          ) : null}
          <span className="text-xs text-ink-500 self-center">
            Итог к {addMonths(startDate, Number(months) || 0)} считается по формуле сложного процента
          </span>
        </div>
        {error ? <p className="text-sm text-danger-500 md:col-span-4">{error}</p> : null}
      </form>

      {rows.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(totals.byCurrency).map(([cur, t]) => (
            <div key={cur} className="bg-white rounded-xl border border-ink-200 p-4">
              <div className="text-sm text-ink-500">Суммарно по всем вкладам · {cur}</div>
              <div className="text-2xl font-semibold mt-1">{formatMoney(t.finalAmount, cur)}</div>
              <div className="text-xs text-ink-500 mt-1">
                Сейчас {formatMoney(t.principal, cur)} · вложено {formatMoney(t.invested, cur)} · прирост{" "}
                <span className="text-accent-600">+{formatMoney(t.profit, cur)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="bg-white border border-ink-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-100 text-ink-700">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Вклад</th>
              <th className="text-right px-3 py-2 font-medium">Сумма</th>
              <th className="text-left px-3 py-2 font-medium">Ставка и срок</th>
              <th className="text-right px-3 py-2 font-medium">Будет к концу срока</th>
              <th className="text-right px-3 py-2 font-medium">Доходность</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-ink-500">
                  Накоплений пока нет. Добавьте первый вклад — и увидите, сколько наберётся к концу срока.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className={editingId === row.id ? "bg-accent-500/5" : ""}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-ink-500">
                      {savingsKindLabel(row.kind as SavingsKind)} · {row.startDate} — {row.endDate}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(row.principal, row.currency)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="tabular-nums">{row.annualRate}% · {row.months} мес.</div>
                    <div className="text-xs text-ink-500">
                      {compoundingLabel(row.compounding as Compounding)}
                      {row.monthlyContribution > 0
                        ? ` · +${formatMoney(row.monthlyContribution, row.currency)}/мес`
                        : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div className="font-medium">{formatMoney(row.projection.finalAmount, row.currency)}</div>
                    <div className="text-xs text-accent-600">
                      +{formatMoney(row.projection.profit, row.currency)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div>{row.projection.periodPercent}% за срок</div>
                    <div className="text-xs text-ink-500">{row.projection.annualPercent}% в год</div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      onClick={() => startEdit(row)}
                      className="text-ink-600 hover:text-ink-900 text-xs mr-3"
                    >
                      Изменить
                    </button>
                    <button
                      onClick={() => remove(row)}
                      className="text-danger-500 hover:text-danger-500 text-xs"
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}