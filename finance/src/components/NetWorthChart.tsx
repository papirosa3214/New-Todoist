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

import { formatMoneyCompact } from "@/lib/format";

export type NetWorthPoint = { month: string; amount: number };

/** Раздел 2.4: линия #0f766e, сетка #e2e8f0. */
export function NetWorthChart({
  data,
  currency = "RUB",
}: {
  data: NetWorthPoint[];
  currency?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={180} className="md:h-[220px]">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
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
          formatter={(v: number) => formatMoneyCompact(v, currency)}
          labelFormatter={(l: string) => l}
        />
        <Line type="monotone" dataKey="amount" stroke="#0f766e" strokeWidth={2} dot />
      </LineChart>
    </ResponsiveContainer>
  );
}