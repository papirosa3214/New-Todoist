"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";

export type AccountItem = {
  id: string;
  name: string;
  type: string;
  currency: string;
  openingBalance: number;
  openingDate: string;
  archived: boolean;
};

export function AccountsManager({ items }: { items: AccountItem[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState("card");
  const [currency, setCurrency] = useState("RUB");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [openingDate, setOpeningDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type,
          currency,
          openingBalance: Number(openingBalance) || 0,
          openingDate,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось создать");
        setPending(false);
        return;
      }
      setName("");
      setOpeningBalance("0");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function archive(id: string, archived: boolean) {
    await fetch(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !archived }),
    });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={create}
        className="bg-white border border-ink-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-3"
      >
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название"
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="cash">Наличные</option>
          <option value="card">Карта</option>
          <option value="deposit">Вклад</option>
          <option value="investment">Инвестиции</option>
          <option value="other">Прочее</option>
        </select>
        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="RUB">RUB</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
          <option value="KZT">KZT</option>
        </select>
        <input
          type="number"
          step="0.01"
          value={openingBalance}
          onChange={(e) => setOpeningBalance(e.target.value)}
          placeholder="Начальный баланс"
          className="border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-accent-600 text-white text-sm rounded-md px-3 py-2 hover:bg-accent-700 disabled:opacity-60"
        >
          {pending ? "Создаём…" : "+ Счёт"}
        </button>
        <input
          type="date"
          value={openingDate}
          onChange={(e) => setOpeningDate(e.target.value)}
          className="border border-ink-300 rounded-md px-3 py-2 text-sm md:col-span-5"
        />
        {error ? <p className="text-sm text-danger-500 md:col-span-5">{error}</p> : null}
      </form>

      <div className="bg-white border border-ink-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-100 text-ink-700">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Название</th>
              <th className="text-left px-3 py-2 font-medium">Тип</th>
              <th className="text-right px-3 py-2 font-medium">Начальный</th>
              <th className="text-left px-3 py-2 font-medium">Валюта</th>
              <th className="text-left px-3 py-2 font-medium">Открыт</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-200">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-ink-500">
                  Счетов пока нет
                </td>
              </tr>
            ) : (
              items.map((a) => (
                <tr key={a.id} className={a.archived ? "opacity-50" : ""}>
                  <td className="px-3 py-2">{a.name}</td>
                  <td className="px-3 py-2">{a.type}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(a.openingBalance, a.currency)}
                  </td>
                  <td className="px-3 py-2">{a.currency}</td>
                  <td className="px-3 py-2">{a.openingDate}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => archive(a.id, a.archived)}
                      className="text-ink-600 hover:text-ink-900 text-xs"
                    >
                      {a.archived ? "Восстановить" : "Архив"}
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