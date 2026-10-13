/**
 * CSV-импровизатор. Поддерживает три формата:
 *  1. 1СClientBankExchange (UTF-8 с разделителем ';')
 *  2. Сбербанк (UTF-8 с разделителем ';' и характерной шапкой)
 *  3. Generic CSV с заголовком и известными колонками: date,amount,description[,merchant]
 *
 * Детект формата — по первым непустым строкам файла.
 */
import Papa from "papaparse";
import type { BankProvider, ParsedFile, RawOperation, ProviderCapability } from "@/lib/bank-provider";

function detectDelimiter(text: string): string {
  // Смотрим первые 20 непустых строк, чтобы не споткнуться о шапки типа
  // "СекцияДокумент=...", где разделителя нет.
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 20);
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  for (const line of lines) {
    counts[";"] += (line.match(/;/g) ?? []).length;
    counts[","] += (line.match(/,/g) ?? []).length;
    counts["\t"] += (line.match(/\t/g) ?? []).length;
  }
  let best = 0;
  let delim = ",";
  for (const [d, c] of Object.entries(counts)) {
    if (c > best) {
      best = c;
      delim = d;
    }
  }
  return delim;
}

function isOneCClientBankExchange(rows: string[][]): boolean {
  // 1С выгрузка начинается с секции "СекцияДокумент=...", "КонецФайла",
  // "1CClientBankExchange" в первой строке или сразу идут строки вида
  // dd.mm.yyyy;dd.mm.yyyy;<amount>;<payer>;<description>.
  if (rows.length === 0) return false;
  const first = rows[0]?.join("").toLowerCase() ?? "";
  if (first.includes("1cclientbankexchange")) return true;
  if (first.includes("клиент банка")) return true;
  if (first.includes("секция")) return true;
  if (first.includes("конецфайла")) return true;
  // иначе — ищем шаблон dd.mm.yyyy;...;число;...;назначение в любой строке
  for (const row of rows) {
    if (row.length < 4) continue;
    if (/^\d{2}\.\d{2}\.\d{4}/.test(row[0] ?? "")) {
      const amt = row[2] ?? row[3] ?? "";
      if (/^-?\d/.test(amt.trim())) return true;
    }
  }
  return false;
}

function isSberbank(rows: string[][]): boolean {
  // Сбербанк выгрузка содержит заголовок вида "Дата операции;Дата обработки;..."
  if (rows.length === 0) return false;
  const first = rows[0]?.join(";").toLowerCase() ?? "";
  return first.includes("дата операции") && first.includes("сумма");
}

function parseRubAmount(iso: string): number {
  // "1 234,56" или "-1234.56" → число
  const cleaned = iso.replace(/\s+/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function parseDateLoose(iso: string): string {
  // Приводим разные форматы к YYYY-MM-DD.
  const trimmed = iso.trim();
  // dd.mm.yyyy
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // yyyy-mm-dd
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // dd/mm/yyyy
  const dmySlash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (dmySlash) return `${dmySlash[3]}-${dmySlash[2]}-${dmySlash[1]}`;
  // fallback: пусть Date попробует
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return trimmed;
}

function parseOneC(rows: string[][]): ParsedFile {
  const operations: RawOperation[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  let lineNo = 0;

  for (const row of rows) {
    lineNo++;
    const joined = row.join(";").trim();
    if (!joined) continue;
    if (joined.startsWith("Секция")) continue;
    if (joined.startsWith("КонецДокумента")) continue;
    if (joined.startsWith("КонецФайла")) continue;

    // Ожидаем поля: ДатаОперации; ДатаОбработки; Сумма; ...; НазначениеПлатежа
    if (row.length < 4) {
      errors.push({ line: lineNo, reason: "мало полей" });
      continue;
    }
    const date = parseDateLoose(row[0] ?? "");
    const amountStr = row[2] ?? row[3] ?? "";
    const amount = parseRubAmount(amountStr);
    if (!Number.isFinite(amount)) {
      errors.push({ line: lineNo, reason: `не удалось разобрать сумму: ${amountStr}` });
      continue;
    }
    const description =
      row.slice(4).join(";").trim() || row[3]?.trim() || "Без описания";
    operations.push({
      date,
      amount,
      currency: "RUB",
      description: description.slice(0, 500),
      merchant: null,
      externalId: null, // для 1С генерируется по dedupe
    });
  }

  return {
    operations,
    summary: {
      imported: operations.length,
      duplicates: 0,
      failed: errors.length,
      errors,
    },
    warnings: [],
  };
}

function parseSberbank(rows: string[][]): ParsedFile {
  // Сбер: Дата операции;Дата обработки;Описание операции;Сумма в валюте операции;...
  const operations: RawOperation[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  let lineNo = 0;
  for (const row of rows) {
    lineNo++;
    if (lineNo === 1) continue; // заголовок
    const joined = row.join(";").trim();
    if (!joined) continue;
    const date = parseDateLoose(row[0] ?? "");
    const amount = parseRubAmount(row[3] ?? row[2] ?? "");
    if (!Number.isFinite(amount)) {
      errors.push({ line: lineNo, reason: `сумма не распознана` });
      continue;
    }
    const description = (row[2] ?? "").trim() || "Без описания";
    operations.push({
      date,
      amount,
      currency: "RUB",
      description: description.slice(0, 500),
      merchant: null,
      externalId: null,
    });
  }
  return {
    operations,
    summary: { imported: operations.length, duplicates: 0, failed: errors.length, errors },
    warnings: [],
  };
}

function parseGeneric(rows: string[][]): ParsedFile {
  // Ожидаем заголовок: date,amount,description[,merchant,currency]
  const operations: RawOperation[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  if (rows.length < 2) {
    return {
      operations,
      summary: { imported: 0, duplicates: 0, failed: 0, errors },
      warnings: ["пустой файл"],
    };
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.findIndex((h) => ["date", "дата"].includes(h)),
    amount: header.findIndex((h) => ["amount", "сумма"].includes(h)),
    description: header.findIndex((h) => ["description", "описание", "назначение"].includes(h)),
    merchant: header.findIndex((h) => ["merchant", "контрагент"].includes(h)),
    currency: header.findIndex((h) => ["currency", "валюта"].includes(h)),
  };
  if (idx.date === -1 || idx.amount === -1 || idx.description === -1) {
    return {
      operations,
      summary: { imported: 0, duplicates: 0, failed: 0, errors },
      warnings: [
        "не удалось распознать заголовки (ожидаются date, amount, description)",
      ],
    };
  };

  let lineNo = 0;
  for (const row of rows.slice(1)) {
    lineNo++;
    if (row.every((c) => !c.trim())) continue;
    const date = parseDateLoose(row[idx.date] ?? "");
    const amount = parseRubAmount(row[idx.amount] ?? "");
    if (!Number.isFinite(amount)) {
      errors.push({ line: lineNo + 1, reason: "сумма не распознана" });
      continue;
    }
    const description = (row[idx.description] ?? "").trim() || "Без описания";
    const merchant =
      idx.merchant >= 0 ? (row[idx.merchant] ?? "").trim() || null : null;
    const currency =
      idx.currency >= 0 ? (row[idx.currency] ?? "").trim() || "RUB" : "RUB";
    operations.push({
      date,
      amount,
      currency,
      description: description.slice(0, 500),
      merchant,
      externalId: null,
    });
  }

  return {
    operations,
    summary: { imported: operations.length, duplicates: 0, failed: errors.length, errors },
    warnings: [],
  };
}

export const csvProvider: BankProvider = {
  id: "csv",
  displayName: "CSV",
  capabilities: ["operations:read"],
  async parse(content) {
    const text =
      typeof content === "string"
        ? content
        : content.toString("utf8");
    const delimiter = detectDelimiter(text);
    const parsed = Papa.parse<string[]>(text, {
      delimiter,
      skipEmptyLines: "greedy",
    });
    const rows = parsed.data.filter((r) => r.length > 0);
    if (rows.length === 0) {
      return {
        operations: [],
        summary: { imported: 0, duplicates: 0, failed: 0, errors: [] },
        warnings: ["пустой файл"],
      };
    }
    if (isSberbank(rows)) return parseSberbank(rows);
    if (isOneCClientBankExchange(rows)) return parseOneC(rows);
    return parseGeneric(rows);
  },
};