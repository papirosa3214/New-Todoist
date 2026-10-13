import { formatMoney, formatSignedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export type MoneySize = "sm" | "md" | "lg" | "hero";
export type MoneyTone = "auto" | "neutral" | "in" | "out" | "muted";

const SIZES: Record<MoneySize, string> = {
  sm: "text-sm font-medium",
  md: "text-lg font-semibold leading-7",
  lg: "text-2xl font-semibold leading-8",
  hero: "text-3xl font-semibold leading-10",
};

const TONES: Record<"in" | "out" | "neutral" | "muted", string> = {
  in: "text-accent-700",
  out: "text-danger-500",
  neutral: "text-ink-900",
  muted: "text-ink-500",
};

/**
 * Раздел 4.3 — единственная точка отображения денег.
 * Цвет не единственный носитель смысла: у суммы есть знак и валюта.
 */
export function MoneyValue({
  amount,
  currency = "RUB",
  size = "md",
  tone = "auto",
  signed,
  className,
}: {
  amount: number;
  currency?: string;
  size?: MoneySize;
  tone?: MoneyTone;
  /** Принудительный знак; по умолчанию знак есть у md/lg/hero. */
  signed?: boolean;
  className?: string;
}) {
  const resolved: "in" | "out" | "neutral" | "muted" =
    tone === "auto" ? (amount < 0 ? "out" : "in") : tone;
  const withSign = signed ?? (size !== "sm" && (resolved === "in" || resolved === "out"));
  const text = withSign
    ? formatSignedMoney(amount, currency)
    : formatMoney(amount, currency);

  return (
    <span className={cn("num", SIZES[size], TONES[resolved], className)}>{text}</span>
  );
}