"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

const COLORS = [
  "#0d9488",
  "#0891b2",
  "#7c3aed",
  "#db2777",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#6366f1",
];

export type CategoryItem = {
  categoryId: string | null;
  categoryName: string;
  icon: string | null;
  amount: number;
};

export function CategoryChart({ items }: { items: CategoryItem[] }) {
  const data = items.map((it) => ({
    name: `${it.icon ?? ""} ${it.categoryName}`.trim(),
    value: it.amount,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" outerRadius={80} label>
          {data.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(value: number) => new Intl.NumberFormat("ru-RU").format(value)} />
      </PieChart>
    </ResponsiveContainer>
  );
}