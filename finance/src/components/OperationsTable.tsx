"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney, formatDate } from "@/lib/format";

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

export function OperationsTable({ rows }: { rows: OperationRow[] }) {
  const router = useRouter();
  if (rows.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-ink-500">
        Операций не найдено.
      </div>
    );
  }

  async function onDelete(id: string) {
    if (!confirm("Удалить операцию?")) return;
    await fetch(`/api/operations/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <table className="w-full text-sm">
      <thead className="bg-ink-100 text-ink-700">
        <tr>
          <th className="text-left px-3 py-2 font-medium">Дата</th>
          <th className="text-left px-3 py-2 font-medium">Счёт</th>
          <th className="text-left px-3 py-2 font-medium">Категория</th>
          <th className="text-left px-3 py-2 font-medium">Описание</th>
          <th className="text-right px-3 py-2 font-medium">Сумма</th>
          <th className="text-left px-3 py-2 font-medium">Источник</th>
          <th className="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-200">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-ink-50">
            <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.date)}</td>
            <td className="px-3 py-2 whitespace-nowrap">{r.accountName ?? "—"}</td>
            <td className="px-3 py-2 whitespace-nowrap">
              {r.categoryIcon ?? ""} {r.categoryName ?? "—"}
            </td>
            <td className="px-3 py-2 truncate max-w-xs">{r.description}</td>
            <td
              className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${
                r.amount < 0 ? "text-danger-500" : "text-accent-700"
              }`}
            >
              {formatMoney(r.amount, r.currency)}
            </td>
            <td className="px-3 py-2 text-ink-500 text-xs">{r.source}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              <Link
                href={`/operations/${r.id}/edit`}
                className="text-accent-600 hover:underline mr-3"
              >
                Изм.
              </Link>
              <button
                onClick={() => onDelete(r.id)}
                className="text-danger-500 hover:underline"
              >
                Удал.
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}