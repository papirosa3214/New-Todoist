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

import { formatMoneyCompact } from "@/lib/format";

export type CashflowPoint = { month: string; income: number; expense: number; net: number };

/** Раздел 2.4: Доход #0f766e, Расход #dc2626, сетка #e2e8f0. Легенда сверху. */
export function CashflowChart({
  data,
  currency = "RUB",
}: {
  data: CashflowPoint[];
  currency?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180} className="md:h-[220px]">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={(v: number) => formatMoneyCompact(v, currency)}
        />
        <Tooltip
          formatter={(v: number, name: string) => [
            formatMoneyCompact(v, currency),
            name,
          ]}
          cursor={{ fill: "#f1f5f9" }}
        />
        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="square" />
        <Bar dataKey="income" name="Доход" fill="#0f766e" radius={[4, 4, 0, 0]} />
        <Bar dataKey="expense" name="Расход" fill="#dc2626" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}