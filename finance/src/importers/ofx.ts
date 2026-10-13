/**
 * Мини-парсер OFX/QFX v1 (SGML-вариант, как отдают большинство банков).
 *
 * Достаёт из <STMTRS><BANKTRANLIST>...</BANKTRANLIST></STMTRS>:
 *   - FITID       → externalId
 *   - DTPOSTED    → дата (YYYYMMDD)
 *   - TRNTYPE     → тип
 *   - NAME        → контрагент
 *   - MEMO        → описание
 *   - TRNAMT      → сумма
 *
 * Для новых банков этого достаточно; XML-вариант OFX v2 не покрываем.
 */
import type { BankProvider, ParsedFile, RawOperation } from "@/lib/bank-provider";

function parseOfxDate(value: string): string {
  // YYYYMMDDHHMMSS или YYYYMMDD
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!m) return value;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function readTag(block: string, tag: string): string | null {
  // Тег может принимать форму <TAG>value</TAG> либо <TAG>value (SGML).
  const closed = new RegExp(`<${tag}>([^<\\r\\n]+)<\\/${tag}>`, "i").exec(block);
  if (closed) return closed[1].trim();
  const open = new RegExp(`<${tag}>([^<\\r\\n]+)(?=<|$)`, "i").exec(block);
  return open ? open[1].trim() : null;
}

function splitTransactions(ofx: string): string[] {
  // <STMTTRN>...</STMTTRN> повторяется.
  const out: string[] = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ofx)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export const ofxProvider: BankProvider = {
  id: "ofx",
  displayName: "OFX/QFX",
  capabilities: ["operations:read"],
  async parse(content): Promise<ParsedFile> {
    const text = typeof content === "string" ? content : content.toString("utf8");
    if (!/OFXHEADER|<OFX>/i.test(text)) {
      return {
        operations: [],
        summary: { imported: 0, duplicates: 0, failed: 0, errors: [] },
        warnings: ["файл не похож на OFX"],
      };
    }
    const blocks = splitTransactions(text);
    const operations: RawOperation[] = [];
    const errors: Array<{ line: number; reason: string }> = [];

    blocks.forEach((tr, idx) => {
      const date = readTag(tr, "DTPOSTED") ?? "";
      const amountStr = readTag(tr, "TRNAMT") ?? "";
      const fitid = readTag(tr, "FITID") ?? null;
      const name = readTag(tr, "NAME") ?? "";
      const memo = readTag(tr, "MEMO") ?? "";
      const trntype = readTag(tr, "TRNTYPE") ?? "";
      const amount = Number(amountStr.replace(",", "."));
      if (!Number.isFinite(amount)) {
        errors.push({ line: idx + 1, reason: `сумма не распознана: ${amountStr}` });
        return;
      }
      if (!date) {
        errors.push({ line: idx + 1, reason: "нет даты" });
        return;
      }
      const description = [name, memo, trntype].filter(Boolean).join(" • ").trim() || "OFX";
      operations.push({
        date: parseOfxDate(date),
        amount,
        currency: "RUB",
        description: description.slice(0, 500),
        merchant: name || null,
        externalId: fitid,
      });
    });

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
  },
};