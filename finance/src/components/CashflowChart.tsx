"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

export type CashflowPoint = { month: string; income: number; expense: number; net: number };

export function CashflowChart({ data }: { data: CashflowPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip
          formatter={(v: number) =>
            new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v)
          }
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="income" name="Доход" fill="#10b981" />
        <Bar dataKey="expense" name="Расход" fill="#ef4444" />
      </BarChart>
    </ResponsiveContainer>
  );
}