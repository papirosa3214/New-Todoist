"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { MoneyInput, moneyPreview } from "@/components/MoneyInput";
import { TypeToggle, type Direction } from "@/components/TypeToggle";
import { todayIso } from "@/lib/format";

export type AccountOption = { id: string; name: string; currency: string };
export type CategoryOption = { id: string; name: string; icon: string | null };

/**
 * Раздел 7.4 — ввод операции целиком на одном экране, без переходов.
 * Порядок полей — по важности, а не по порядку в базе.
 */
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
    /** Тип приходит из сохранённой операции, а не выводится из знака суммы. */
    direction?: Direction;
    description?: string;
    accountId?: string;
    categoryId?: string;
  };
}) {
  const router = useRouter();
  const [date, setDate] = React.useState(initial?.date ?? todayIso());
  const [amount, setAmount] = React.useState(initial?.amount ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [accountId, setAccountId] = React.useState(initial?.accountId ?? accounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = React.useState(initial?.categoryId ?? "");
  const [direction, setDirection] = React.useState<Direction>(initial?.direction ?? "expense");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isEdit = Boolean(initial?.id);
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? "RUB";
  const preview = moneyPreview(amount, currency, direction);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const numeric = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(numeric) || numeric === 0) {
      setError("Введите сумму, отличную от нуля");
      return;
    }
    if (!accountId) {
      setError("Выберите счёт");
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
        return;
      }
      router.push("/operations");
      router.refresh();
    } catch {
      setError("Нет связи с сервером. Проверьте подключение и повторите.");
    } finally {
      setPending(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-ink-200 bg-white">
        <EmptyState
          icon={Wallet}
          title="Сначала откройте счёт"
          description="Операции привязаны к счёту — без него некуда записать расход или доход."
          action={
            <Button asChild>
              <a href="/accounts">Открыть счёт</a>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-ink-200 bg-white p-4 md:p-5"
    >
      <div className="space-y-1">
        <Label htmlFor="amount">Сумма</Label>
        <MoneyInput
          id="amount"
          value={amount}
          onChange={setAmount}
          currency={currency}
          preview={preview}
          describedBy="amount-preview"
        />
      </div>

      <div className="space-y-1">
        <span className="text-sm font-medium leading-5 text-ink-700">Тип операции</span>
        <TypeToggle value={direction} onChange={setDirection} />
      </div>

      <div className="space-y-1">
        <Label htmlFor="description">Описание</Label>
        <Input
          id="description"
          name="description"
          required
          autoFocus={!isEdit}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="на что, у кого"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="account">Счёт</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger id="account" name="account">
              <SelectValue placeholder="Выберите счёт" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="category">Категория</Label>
          <Select value={categoryId || "none"} onValueChange={(v) => setCategoryId(v === "none" ? "" : v)}>
            <SelectTrigger id="category" name="category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Без категории</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.icon ? `${c.icon} ${c.name}` : c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1 md:max-w-xs">
        <Label htmlFor="date">Дата</Label>
        <Input
          id="date"
          name="date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex flex-col gap-2 pt-2 sm:flex-row">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? "Сохраняем…" : isEdit ? "Сохранить" : "Создать"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push("/operations")}
          className="w-full sm:w-auto"
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}