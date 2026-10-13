"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

import { formatMoneyCompact, formatPercent } from "@/lib/format";

/** Раздел 2.4 — палитра диаграмм, порядок фиксирован, серый = «Без категории». */
export const CHART_COLORS = [
  "#0f766e",
  "#0e7490",
  "#7c3aed",
  "#d97706",
  "#db2777",
  "#4f46e5",
  "#65a30d",
  "#94a3b8",
];

const UNCATEGORIZED = "Без категории";

export type CategoryItem = {
  categoryId: string | null;
  categoryName: string;
  icon: string | null;
  amount: number;
};

/**
 * Раздел 7.2 — круговая диаграмма с легендой-списком справа.
 * Сектор подписан компактной суммой без точки; легенда показывает долю.
 */
export function CategoryChart({ items, currency = "RUB" }: { items: CategoryItem[]; currency?: string }) {
  const total = items.reduce((acc, it) => acc + it.amount, 0);
  const ordered = [...items].sort((a, b) => {
    const aEmpty = a.categoryName === UNCATEGORIZED;
    const bEmpty = b.categoryName === UNCATEGORIZED;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    return b.amount - a.amount;
  });
  const data = ordered.map((it) => ({
    name: it.categoryName,
    value: it.amount,
    color: it.categoryName === UNCATEGORIZED ? CHART_COLORS[7] : undefined,
  }));

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
      <div className="lg:w-1/2">
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={80} label={false}>
              {data.map((entry, i) => (
                <Cell
                  key={entry.name}
                  fill={entry.color ?? CHART_COLORS[i % CHART_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, name: string) => [
                formatMoneyCompact(value, currency),
                name,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <p className="sr-only">
          Расходы по категориям:{" "}
          {ordered
            .map((it) => `${it.categoryName} — ${formatMoneyCompact(it.amount, currency)}`)
            .join(", ")}
        </p>
      </div>
      <ul className="space-y-2 lg:w-1/2">
        {ordered.map((it) => {
          const share = total > 0 ? (it.amount / total) * 100 : 0;
          const index = ordered.indexOf(it);
          const color =
            it.categoryName === UNCATEGORIZED
              ? CHART_COLORS[7]
              : CHART_COLORS[index % CHART_COLORS.length];
          return (
            <li key={it.categoryName} className="flex items-center gap-2 text-sm">
              <span
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-ink-700">
                {it.icon ? `${it.icon} ` : ""}
                {it.categoryName}
              </span>
              <span className="num shrink-0 text-ink-900">
                {formatMoneyCompact(it.amount, currency)}
              </span>
              <span className="num w-12 shrink-0 text-right text-ink-500">
                {formatPercent(share)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}