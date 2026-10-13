"use client";

import { cn } from "@/lib/utils";

export type Direction = "expense" | "income";

/**
 * Раздел 4.5 — переключатель «Расход / Доход».
 * Тип приходит явным `direction` от родителя и никогда не выводится из знака
 * переданного числа: именно из-за этого при правке дохода он превращался в расход.
 */
export function TypeToggle({
  value,
  onChange,
  className,
}: {
  value: Direction;
  onChange: (value: Direction) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Тип операции"
      className={cn("flex h-11 w-full overflow-hidden rounded-lg border border-ink-200 bg-white", className)}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === "expense"}
        onClick={() => onChange("expense")}
        className={cn(
          "flex-1 border-b-2 text-sm font-medium transition-colors",
          value === "expense"
            ? "border-danger-500 bg-danger-500 text-white"
            : "border-ink-200 bg-white text-ink-700",
        )}
      >
        Расход
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "income"}
        onClick={() => onChange("income")}
        className={cn(
          "flex-1 border-b-2 text-sm font-medium transition-colors",
          value === "income"
            ? "border-accent-600 bg-accent-600 text-white"
            : "border-ink-200 bg-white text-ink-700",
        )}
      >
        Доход
      </button>
    </div>
  );
}