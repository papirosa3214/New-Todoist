"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { OperationCard, OperationRowDesktop, type OperationRow } from "@/components/OperationCard";

/**
 * Раздел 4.7 — адаптивная обёртка списка операций:
 * ≥768 px таблица, <768 px карточки. Горизонтальной прокрутки нет.
 */
export function OperationsList({
  rows,
  filtered,
}: {
  rows: OperationRow[];
  /** Есть ли применённые фильтры — от этого зависит текст пустого состояния. */
  filtered: boolean;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onDelete(id: string) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/operations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("bad status");
      router.refresh();
    } catch {
      setError("Не удалось удалить операцию. Проверьте связь и повторите.");
    } finally {
      setPending(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-ink-200 bg-white">
        {filtered ? (
          <EmptyState
            icon={SearchX}
            title="Ничего не найдено"
            description="Под выбранные условия не подошла ни одна операция"
            action={
              <Button asChild variant="secondary">
                <a href="/operations">Сбросить фильтры</a>
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={SearchX}
            title="Операций пока нет"
            description="Добавьте первую — это занимает меньше минуты"
            action={
              <Button asChild>
                <a href="/operations/new">＋ Новая операция</a>
              </Button>
            }
          />
        )}
        {error ? <p className="px-4 pb-4 text-sm text-danger-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white">
      <div className="hidden md:block">
        {/* Раздел 6: таблица не прокручивается горизонтально. Колонка «Источник»
            появляется с 1024 px, на 768 px остальные ужимаются и обрезают текст
            штатно, а не уезжают за край. */}
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-24" />
            <col className="w-28" />
            <col className="w-32" />
            <col />
            <col className="w-36" />
            <col className="hidden w-28 lg:table-column" />
            <col className="w-24" />
          </colgroup>
          <thead className="bg-ink-100 text-ink-700">
            <tr>
              <th className="truncate px-2 py-2 text-left text-sm font-medium xl:px-3">Дата</th>
              <th className="truncate px-2 py-2 text-left text-sm font-medium xl:px-3">Счёт</th>
              <th className="truncate px-2 py-2 text-left text-sm font-medium xl:px-3">Категория</th>
              <th className="px-2 py-2 text-left text-sm font-medium xl:px-3">Описание</th>
              <th className="whitespace-nowrap px-2 py-2 text-right text-sm font-medium xl:px-3">
                Сумма
              </th>
              <th className="hidden truncate px-2 py-2 text-left text-sm font-medium lg:table-cell xl:px-3">
                Источник
              </th>
              <th className="px-2 py-2 xl:px-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <OperationRowDesktop key={r.id} row={r} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-ink-100 md:hidden">
        {rows.map((r) => (
          <OperationCard key={r.id} row={r} onDelete={onDelete} />
        ))}
      </div>
      {error || pending ? (
        <p className="px-4 py-3 text-sm text-danger-600">{error ?? "Удаляем…"}</p>
      ) : null}
    </div>
  );
}