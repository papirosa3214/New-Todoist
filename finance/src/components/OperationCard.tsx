"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MoneyValue } from "@/components/MoneyValue";
import { useSuccessToast } from "@/components/SuccessToast";
import { formatDate } from "@/lib/format";
import { sourceLabel } from "@/lib/dictionaries";

export type OperationRow = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  merchant: string | null;
  source: string;
  accountName: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
};

/** Раздел 4.6 — мобильная замена строки таблицы: видны описание и сумма. */
export function OperationCard({
  row,
  onDelete,
}: {
  row: OperationRow;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const notify = useSuccessToast();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-ink-100"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-100 text-base">
          {row.categoryIcon ?? (row.categoryName?.[0] ?? "—")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base text-ink-900">{row.description}</span>
          <span className="block truncate text-xs text-ink-500">
            {row.categoryName ?? "Без категории"}
            {row.accountName ? ` · ${row.accountName}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <MoneyValue amount={row.amount} currency={row.currency} size="md" />
          <span className="num text-xs text-ink-500">{formatDate(row.date)}</span>
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle>{row.description}</SheetTitle>
          </SheetHeader>
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-500">Сумма</dt>
              <dd>
                <MoneyValue amount={row.amount} currency={row.currency} size="lg" />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500">Дата</dt>
              <dd className="num text-ink-900">{formatDate(row.date)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500">Счёт</dt>
              <dd className="text-ink-900">{row.accountName ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500">Категория</dt>
              <dd className="text-ink-900">{row.categoryName ?? "Без категории"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-500">Источник</dt>
              <dd className="text-ink-900">{sourceLabel(row.source)}</dd>
            </div>
            {row.merchant ? (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-500">Контрагент</dt>
                <dd className="text-ink-900">{row.merchant}</dd>
              </div>
            ) : null}
          </dl>
          <Separator className="my-4" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)}>
              <Link href={`/operations/${row.id}/edit`}>
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Изменить
              </Link>
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Удалить
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Удалить операцию?"
        description="Действие нельзя отменить."
        confirmLabel="Удалить"
        destructive
        onConfirm={() => {
          onDelete(row.id);
          setConfirming(false);
          notify("Операция удалена");
        }}
      />
    </>
  );
}

/** Таблица на десктопе — те же данные, но строками. */
export function OperationRowDesktop({
  row,
  onDelete,
}: {
  row: OperationRow;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const notify = useSuccessToast();

  return (
    <>
      <tr className="border-b border-ink-100 hover:bg-ink-50">
        <td className="num whitespace-nowrap px-2 py-2 text-sm text-ink-900 xl:px-3">
          {formatDate(row.date)}
        </td>
        <td className="truncate px-2 py-2 text-sm text-ink-700 xl:px-3">{row.accountName ?? "—"}</td>
        <td className="truncate px-2 py-2 text-sm text-ink-700 xl:px-3">
          {row.categoryIcon ? `${row.categoryIcon} ` : ""}
          {row.categoryName ?? "Без категории"}
        </td>
        <td className="truncate px-2 py-2 text-sm text-ink-900 xl:px-3">{row.description}</td>
        <td className="whitespace-nowrap px-2 py-2 text-right text-sm xl:px-3">
          <MoneyValue amount={row.amount} currency={row.currency} size="sm" signed />
        </td>
        <td className="hidden truncate whitespace-nowrap px-2 py-2 text-sm text-ink-500 lg:table-cell xl:px-3">
          {sourceLabel(row.source)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-right xl:px-3">
          <Button variant="ghost" size="icon" asChild aria-label="Изменить операцию">
            <Link href={`/operations/${row.id}/edit`}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Удалить операцию"
            className="text-danger-500 hover:bg-danger-50"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </td>
      </tr>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Удалить операцию?"
        description="Действие нельзя отменить."
        confirmLabel="Удалить"
        destructive
        onConfirm={() => {
          onDelete(row.id);
          setConfirming(false);
          notify("Операция удалена");
        }}
      />
    </>
  );
}

