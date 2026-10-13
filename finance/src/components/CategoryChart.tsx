"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

import { formatMoney, formatMoneyCompact, formatPercent } from "@/lib/format";

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

/** Хвост категорий — светло-серый, чтобы не путался с «Без категории». */
const TAIL_COLOR = "#cbd5e1";

const UNCATEGORIZED = "Без категории";
const TOP_LIMIT = 8;

export type CategoryItem = {
  categoryId: string | null;
  categoryName: string;
  icon: string | null;
  amount: number;
};

/**
 * Раздел 7.2 — круговая диаграмма с легендой-списком справа.
 * Сектор подписан компактной суммой без точки; легенда показывает долю.
 * Названия не обрезаются: строка переносится целиком (критерий приёмки №4).
 */
export function CategoryChart({ items, currency = "RUB" }: { items: CategoryItem[]; currency?: string }) {
  const total = items.reduce((acc, it) => acc + it.amount, 0);

  const named = items
    .filter((it) => it.categoryName !== UNCATEGORIZED)
    .sort((a, b) => b.amount - a.amount);
  const head = named.slice(0, TOP_LIMIT);
  const tail = named.slice(TOP_LIMIT);
  const uncategorized = items.filter((it) => it.categoryName === UNCATEGORIZED);

  const tailTotal = tail.reduce((acc, it) => acc + it.amount, 0);
  const tailLabel =
    tail.length > 0
      ? `и ещё ${tail.length} ${tail.length === 1 ? "категория" : tail.length < 5 ? "категории" : "категорий"}`
      : null;

  const slices: Array<{ name: string; value: number; color: string }> = [
    ...head.map((it, i) => ({ name: it.categoryName, value: it.amount, color: CHART_COLORS[i] })),
    ...(tailTotal > 0
      ? [{ name: tailLabel!, value: tailTotal, color: TAIL_COLOR }]
      : []),
    ...uncategorized.map((it) => ({ name: UNCATEGORIZED, value: it.amount, color: CHART_COLORS[7] })),
  ];

  const legend: Array<{ name: string; amount: number; color: string }> = [
    ...head.map((it, i) => ({ name: it.categoryName, amount: it.amount, color: CHART_COLORS[i] })),
    ...(tailTotal > 0
      ? [{ name: tailLabel!, amount: tailTotal, color: TAIL_COLOR }]
      : []),
    ...uncategorized.map((it) => ({ name: UNCATEGORIZED, amount: it.amount, color: CHART_COLORS[7] })),
  ];

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="lg:w-1/2">
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" outerRadius={80} label={false}>
              {slices.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
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
          {items
            .map((it) => `${it.categoryName} — ${formatMoney(it.amount, currency)}`)
            .join(", ")}
        </p>
      </div>
      <ul className="space-y-2 lg:w-1/2">
        {legend.map((it) => {
          const share = total > 0 ? (it.amount / total) * 100 : 0;
          return (
            <li key={it.name} className="flex items-start gap-2 text-sm">
              <span
                className="mt-1 h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: it.color }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 break-words leading-5 text-ink-700">
                {it.name}
              </span>
              <span className="num shrink-0 whitespace-nowrap text-ink-900">
                {formatMoneyCompact(it.amount, currency)}
              </span>
              <span className="num w-12 shrink-0 text-right leading-5 text-ink-500">
                {formatPercent(share)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}