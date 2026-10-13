"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Plus } from "lucide-react";

import { cn } from "@/lib/utils";
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
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBanner } from "@/components/ErrorBanner";
import { MoneyValue } from "@/components/MoneyValue";
import { useSuccessToast } from "@/components/SuccessToast";
import { formatDate, todayIso } from "@/lib/format";
import { accountTypeLabel } from "@/lib/dictionaries";

export type AccountItem = {
  id: string;
  name: string;
  type: string;
  currency: string;
  openingBalance: number;
  openingDate: string;
  archived: boolean;
};

const TYPES = [
  { value: "card", label: "Карта" },
  { value: "cash", label: "Наличные" },
  { value: "deposit", label: "Вклад" },
  { value: "investment", label: "Инвестиции" },
  { value: "other", label: "Прочее" },
];

const CURRENCIES = ["RUB", "USD", "EUR", "KZT"];

/** Раздел 7.5 — форма сверху, список таблицей; архивирование через подтверждение. */
export function AccountsManager({ items }: { items: AccountItem[] }) {
  const router = useRouter();
  const notify = useSuccessToast();
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState("card");
  const [currency, setCurrency] = React.useState("RUB");
  const [openingBalance, setOpeningBalance] = React.useState("0");
  const [openingDate, setOpeningDate] = React.useState(todayIso());
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = React.useState<AccountItem | null>(null);

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
        setError(body?.error?.message ?? "Не удалось создать счёт");
        return;
      }
      setName("");
      setOpeningBalance("0");
      router.refresh();
      notify("Счёт создан");
    } catch {
      setError("Нет связи с сервером. Проверьте подключение и повторите.");
    } finally {
      setPending(false);
    }
  }

  async function toggleArchive(item: AccountItem) {
    setArchiveTarget(null);
    try {
      const res = await fetch(`/api/accounts/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !item.archived }),
      });
      if (!res.ok) throw new Error("bad status");
      router.refresh();
      notify(item.archived ? "Счёт восстановлен" : "Счёт в архиве");
    } catch {
      setError("Не удалось изменить счёт. Проверьте связь и повторите.");
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={create}
        className="grid grid-cols-1 gap-3 rounded-xl border border-ink-200 bg-white p-4 md:grid-cols-3 md:p-5"
      >
        <div className="space-y-1">
          <Label htmlFor="acc-name">Название</Label>
          <Input
            id="acc-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Зарплатная карта"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-type">Тип</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="acc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-currency">Валюта</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="acc-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-balance">Начальный баланс</Label>
          <Input
            id="acc-balance"
            inputMode="decimal"
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="acc-date">Дата открытия</Label>
          <Input
            id="acc-date"
            type="date"
            value={openingDate}
            onChange={(e) => setOpeningDate(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={pending} className="w-full md:w-auto">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {pending ? "Создаём…" : "Счёт"}
          </Button>
        </div>

        {currency !== "RUB" ? (
          <Alert variant="warning" className="md:col-span-3">
            Приложение не переводит валюты. Суммы по разным валютам не складываются в один итог.
          </Alert>
        ) : null}
        {error ? <ErrorBanner message={error} className="md:col-span-3" /> : null}
      </form>

      {items.length === 0 ? (
        <div className="rounded-xl border border-ink-200 bg-white">
          <EmptyState
            title="Счетов пока нет"
            description="Счёт — это карта, вклад или наличные"
            action={
              <Button asChild>
                <a href="#acc-name">＋ Новый счёт</a>
              </Button>
            }
          />
        </div>
      ) : (
        <div className="rounded-xl border border-ink-200 bg-white">
          <div className="hidden md:block">
            <table className="w-full">
              <thead className="bg-ink-100 text-ink-700">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-medium">Название</th>
                  <th className="px-3 py-2 text-left text-sm font-medium">Тип</th>
                  <th className="px-3 py-2 text-left text-sm font-medium">Валюта</th>
                  <th className="px-3 py-2 text-right text-sm font-medium">Начальный баланс</th>
                  <th className="px-3 py-2 text-left text-sm font-medium">Открыт</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className={cn("border-b border-ink-100", a.archived && "opacity-50")}>
                    <td className="px-3 py-2 text-sm text-ink-900">
                      {a.name}
                      {a.archived ? <span className="ml-2 text-xs text-ink-500">В архиве</span> : null}
                    </td>
                    <td className="px-3 py-2 text-sm text-ink-700">{accountTypeLabel(a.type)}</td>
                    <td className="px-3 py-2 text-sm text-ink-700">{a.currency}</td>
                    <td className="px-3 py-2 text-right text-sm">
                      <MoneyValue amount={a.openingBalance} currency={a.currency} size="sm" signed={false} />
                    </td>
                    <td className="num px-3 py-2 text-sm text-ink-700">{formatDate(a.openingDate)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setArchiveTarget(a)}
                        aria-label={a.archived ? "Восстановить счёт" : "Архивировать счёт"}
                      >
                        {a.archived ? (
                          <>
                            <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                            Восстановить
                          </>
                        ) : (
                          <>
                            <Archive className="h-4 w-4" aria-hidden="true" />
                            Архив
                          </>
                        )}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="divide-y divide-ink-100 md:hidden">
            {items.map((a) => (
              <li key={a.id} className={cn("px-4 py-3", a.archived && "opacity-50")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-base text-ink-900">{a.name}</div>
                    <div className="text-xs text-ink-500">
                      {accountTypeLabel(a.type)} · {a.currency} · с {formatDate(a.openingDate)}
                    </div>
                  </div>
                  <MoneyValue amount={a.openingBalance} currency={a.currency} size="sm" signed={false} />
                </div>
                <Button variant="ghost" size="sm" className="mt-2 -ml-3" onClick={() => setArchiveTarget(a)}>
                  {a.archived ? (
                    <>
                      <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                      Восстановить
                    </>
                  ) : (
                    <>
                      <Archive className="h-4 w-4" aria-hidden="true" />
                      Архив
                    </>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title={archiveTarget?.archived ? "Вернуть счёт из архива?" : "Архивировать счёт?"}
        description={
          archiveTarget?.archived
            ? "Счёт снова будет доступен для операций."
            : "Счёт уйдёт из списков выбора, но его операции останутся."
        }
        confirmLabel={archiveTarget?.archived ? "Восстановить" : "Архивировать"}
        onConfirm={() => archiveTarget && toggleArchive(archiveTarget)}
      />
    </div>
  );
}