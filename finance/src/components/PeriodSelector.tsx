"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

const periods: Array<{ id: string; label: string }> = [
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Год" },
];

export function PeriodSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = params.get("period") ?? "month";

  function set(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("period", id);
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
    });
  }

  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-sm bg-white">
      {periods.map((p) => (
        <button
          key={p.id}
          onClick={() => set(p.id)}
          className={`px-3 py-1.5 ${
            current === p.id ? "bg-accent-500 text-white" : "text-ink-700 hover:bg-ink-100"
          }`}
          disabled={pending}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}