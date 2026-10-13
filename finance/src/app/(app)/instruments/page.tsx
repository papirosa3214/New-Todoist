import { db } from "@/db";
import { marketQuotes } from "@/db/schema";
import { InstrumentsExplorer } from "@/components/InstrumentsExplorer";
import { INSTRUMENTS, DISCLAIMER, type Instrument } from "@/lib/instruments";
import { QUOTE_CATALOG, type Quote } from "@/lib/market";

export const dynamic = "force-dynamic";

export default async function InstrumentsPage() {
  const rows = await db.select().from(marketQuotes);
  const saved = new Map(rows.map((q) => [q.symbol, q]));

  // Показываем все строки справочника: без данных — с пометкой, что их надо обновить.
  const quotes: Quote[] = QUOTE_CATALOG.map((catalog) => {
    const row = saved.get(catalog.symbol);
    if (!row || row.value === null) {
      return {
        ...catalog,
        value: null,
        fetchedAt: "",
        ok: false,
        note: "Пока нет данных — нажмите «Обновить данные»",
      };
    }
    return {
      symbol: row.symbol,
      kind: row.kind as Quote["kind"],
      label: row.label,
      value: row.value,
      unit: row.unit,
      source: row.source,
      sourceUrl: row.sourceUrl,
      fetchedAt: row.fetchedAt,
      ok: true,
    };
  });

  return (
    <div className="px-6 py-6 max-w-6xl">
      <h1 className="text-2xl font-semibold mb-1">Справочник инструментов</h1>
      <p className="text-sm text-ink-500 mb-4">{DISCLAIMER}</p>
      <InstrumentsExplorer guides={INSTRUMENTS as Instrument[]} quotes={quotes} />
    </div>
  );
}