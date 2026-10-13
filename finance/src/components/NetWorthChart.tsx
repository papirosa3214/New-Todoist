"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
} from "recharts";

export type NetWorthPoint = { month: string; amount: number };

export function NetWorthChart({ data }: { data: NetWorthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip
          formatter={(v: number) =>
            new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v)
          }
        />
        <Line type="monotone" dataKey="amount" stroke="#0d9488" strokeWidth={2} dot />
      </LineChart>
    </ResponsiveContainer>
  );
}