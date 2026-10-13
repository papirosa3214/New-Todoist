"use client";

import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/format";

/**
 * Раздел 4.4 — поле суммы: главный элемент формы, вдвое крупнее остальных.
 * Под полем — живой предпросмотр результата со знаком: пользователь видит,
 * что получится, до сохранения.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  preview,
  describedBy,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  currency: string;
  /** Подпись «Будет: …» под полем; если пусто — подписи нет. */
  preview?: string;
  describedBy?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative">
        <input
          id={id}
          name="amount"
          required
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0,00"
          aria-describedby={describedBy}
          className={cn(
            "num h-14 w-full rounded-md border border-ink-300 bg-white px-3 pr-20 text-right text-2xl font-semibold text-ink-900",
            "placeholder:font-normal placeholder:text-ink-400",
            "focus-visible:outline-none focus-visible:border-accent-600 focus-visible:ring-2 focus-visible:ring-accent-600/20",
            "aria-invalid:border-danger-500",
          )}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-500">
          {currency}
        </span>
      </div>
      {preview ? (
        <p id={describedBy} className="num mt-1.5 text-xs text-ink-500">
          {preview}
        </p>
      ) : null}
    </div>
  );
}

export function moneyPreview(
  raw: string,
  currency: string,
  direction: "expense" | "income",
): string {
  const numeric = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const value = direction === "expense" ? -Math.abs(numeric) : Math.abs(numeric);
  const label = direction === "expense" ? "Расход" : "Доход";
  return `Будет: ${formatMoney(value, currency)} · ${label}`;
}