/**
 * Детерминированный external_id для импорта файлов, не выдающих уникальных ID.
 *
 * Хеш считается от нормализованных полей (source, account_id, date, amount,
 * description). Один и тот же файл, импортированный повторно, даст те же
 * external_id — это основа идемпотентности импорта.
 */
import { createHash } from "node:crypto";

export function deterministicExternalId(input: {
  source: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
}): string {
  const normalized = [
    input.source,
    input.accountId,
    input.date,
    input.amount.toFixed(2),
    input.description.trim().toLowerCase(),
  ].join("|");
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `h:${hash.slice(0, 24)}`;
}