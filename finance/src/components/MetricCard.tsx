import { cn } from "@/lib/utils";
import { MoneyValue } from "@/components/MoneyValue";

/**
 * Раздел 4.8 — карточка показателя на дашборде.
 * Валюты не складываются: если их несколько, карточка показывает список строк.
 */
export function MetricCard({
  label,
  amount,
  amounts,
  currency,
  footnote,
  tone = "auto",
  className,
}: {
  label: string;
  /** Одна сумма — amounts не нужен, передайте amount. */
  amount?: number;
  amounts?: Array<{ currency: string; value: number }>;
  currency?: string;
  footnote?: React.ReactNode;
  tone?: "auto" | "neutral";
  className?: string;
}) {
  const rows = amounts ?? [{ currency: currency ?? "RUB", value: amount ?? 0 }];
  return (
    <div className={cn("rounded-xl border border-ink-200 bg-white p-4 md:p-5", className)}>
      <div className="text-sm font-medium text-ink-500">{label}</div>
      <div className="mt-1 flex flex-col gap-0.5">
        {rows.map((r) => (
          <MoneyValue
            key={r.currency}
            amount={r.value}
            currency={r.currency}
            size="lg"
            tone={tone}
            signed={false}
          />
        ))}
      </div>
      {footnote ? (
        <div className="mt-1 text-xs leading-[18px] text-ink-500">{footnote}</div>
      ) : null}
    </div>
  );
}