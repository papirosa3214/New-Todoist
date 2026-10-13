/**
 * Контракт BankProvider — единая абстракция для любого источника операций.
 *
 * Реализации:
 *  - ManualProvider        — ручной ввод (не импортирует, но участвует в UI)
 *  - CsvProvider           — CSV 1СClientBankExchange / Сбербанк / generic
 *  - OfxProvider           — OFX/QFX
 *  - будущие: SaltEdge, Enable Banking, Plaid
 *
 * Дедупликация — на стороне ядра по (account_id, source, external_id).
 */

export type RawOperation = {
  date: string;
  amount: number;
  currency: string;
  description: string;
  merchant?: string | null;
  externalId: string | null;
};

export type ProviderCapability = "accounts:read" | "operations:read" | "sync";

export type ImportSummary = {
  imported: number;
  duplicates: number;
  failed: number;
  errors: Array<{ line: number; reason: string }>;
};

export type ParsedFile = {
  operations: RawOperation[];
  summary: ImportSummary;
  warnings: string[];
};

export interface BankProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapability[];
  /** Разбирает содержимое файла в операции. */
  parse(content: string | Buffer, options?: Record<string, unknown>): Promise<ParsedFile>;
}

export const PROVIDERS: Record<string, BankProvider> = {};