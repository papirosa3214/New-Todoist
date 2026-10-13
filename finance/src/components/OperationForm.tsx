"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { todayIso } from "@/lib/format";

export type AccountOption = { id: string; name: string; currency: string };
export type CategoryOption = { id: string; name: string; icon: string | null };

export function OperationForm({
  accounts,
  categories,
  initial,
}: {
  accounts: AccountOption[];
  categories: CategoryOption[];
  initial?: {
    id?: string;
    date?: string;
    amount?: string;
    currency?: string;
    description?: string;
    accountId?: string;
    categoryId?: string;
  };
}) {
  const router = useRouter();
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [accountId, setAccountId] = useState(
    initial?.accountId ?? accounts[0]?.id ?? "",
  );
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "");
  const [direction, setDirection] = useState<"expense" | "income">(
    Number(initial?.amount ?? 0) >= 0 ? "expense" : "income",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(initial?.id);
  const selectedCurrency =
    accounts.find((a) => a.id === accountId)?.currency ?? "RUB";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const numeric = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(numeric) || numeric === 0) {
      setError("Введите сумму, отличную от нуля");
      return;
    }
    const signed = direction === "expense" ? -Math.abs(numeric) : Math.abs(numeric);
    setPending(true);
    try {
      const url = isEdit ? `/api/operations/${initial!.id}` : "/api/operations";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          amount: signed,
          description: description.trim(),
          accountId,
          categoryId: categoryId || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "Не удалось сохранить");
        setPending(false);
        return;
      }
      router.push("/operations");
      router.refresh();
    } catch {
      setError("Сетевая ошибка");
      setPending(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 text-sm">
        Сначала{" "}
        <a className="text-accent-600 underline" href="/accounts">
          создайте счёт
        </a>
        .
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white border border-ink-200 rounded-xl p-4 space-y-4"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-ink-700">Дата</span>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm text-ink-700">Тип</span>
          <div className="mt-1 inline-flex rounded-md border border-ink-300 overflow-hidden text-sm w-full">
            <button
              type="button"
              onClick={() => setDirection("expense")}
              className={`flex-1 py-2 ${
                direction === "expense" ? "bg-danger-500 text-white" : "bg-white text-ink-700"
              }`}
            >
              Расход
            </button>
            <button
              type="button"
              onClick={() => setDirection("income")}
              className={`flex-1 py-2 ${
                direction === "income" ? "bg-accent-600 text-white" : "bg-white text-ink-700"
              }`}
            >
              Доход
            </button>
          </div>
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm text-ink-700">Сумма ({selectedCurrency})</span>
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="например, 1234.56"
            className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm text-ink-700">Счёт</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-sm text-ink-700">Описание</span>
        <input
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="на что, у кого"
          className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-sm text-ink-700">Категория</span>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="mt-1 w-full border border-ink-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">Без категории</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon ?? ""} {c.name}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="text-sm text-danger-500">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="bg-accent-600 text-white text-sm rounded-md px-4 py-2 hover:bg-accent-700 disabled:opacity-60"
        >
          {pending ? "Сохраняем…" : isEdit ? "Сохранить" : "Создать"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/operations")}
          className="bg-ink-100 text-ink-700 text-sm rounded-md px-4 py-2 hover:bg-ink-200"
        >
          Отмена
        </button>
      </div>
    </form>
  );
}