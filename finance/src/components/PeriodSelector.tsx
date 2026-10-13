"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/utils";

const periods: Array<{ id: string; label: string }> = [
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Год" },
];

/** Раздел 7.2 — выбор периода сегментами; подпись периода ставит страница. */
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
    <div
      role="radiogroup"
      aria-label="Период"
      className="flex w-full overflow-hidden rounded-lg border border-ink-200 bg-white sm:w-auto"
    >
      {periods.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={current === p.id}
          disabled={pending}
          onClick={() => set(p.id)}
          className={cn(
            "min-h-11 flex-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:flex-none",
            current === p.id
              ? "border-accent-600 bg-accent-50 text-accent-700"
              : "border-ink-200 bg-white text-ink-700 hover:bg-ink-100",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}