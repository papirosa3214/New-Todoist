import { NextResponse } from "next/server";
import { db } from "@/db";
import { marketQuotes } from "@/db/schema";
import { collectQuotes } from "@/lib/market";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/market — обновляет котировки из открытых источников.
 *
 * Ответы источников сохраняются в market_quotes вместе с датой. Если источник
 * сейчас не ответил, отдаём ранее сохранённое значение и помечаем его stale,
 * чтобы в интерфейсе было видно, какого числа данные.
 */
export async function GET() {
  const me = await currentUser();
  if (!me) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Войдите" } },
      { status: 401 },
    );
  }

  try {
    const { quotes, errors } = await collectQuotes();

    for (const q of quotes.filter((item) => item.value !== null)) {
      await db
        .insert(marketQuotes)
        .values({
          symbol: q.symbol,
          kind: q.kind,
          label: q.label,
          value: q.value,
          unit: q.unit,
          source: q.source,
          sourceUrl: q.sourceUrl,
          fetchedAt: q.fetchedAt,
          ok: true,
          note: null,
        })
        .onConflictDoUpdate({
          target: marketQuotes.symbol,
          set: {
            kind: q.kind,
            label: q.label,
            value: q.value,
            unit: q.unit,
            source: q.source,
            sourceUrl: q.sourceUrl,
            fetchedAt: q.fetchedAt,
            ok: true,
            note: null,
          },
        });
    }

    // Источник, который не ответил, не исчезает из списка: показываем его последнее
    // сохранённое значение с той датой, на которую оно было получено.
    const cached = new Map((await db.select().from(marketQuotes)).map((c) => [c.symbol, c]));
    const merged = quotes.map((q) => {
      if (q.value !== null) return q;
      const c = cached.get(q.symbol);
      if (!c || c.value === null) return q;
      return {
        ...q,
        value: c.value,
        unit: c.unit,
        source: c.source,
        fetchedAt: c.fetchedAt,
        ok: false,
        note: "Источник не ответил, показана последняя сохранённая загрузка",
      };
    });

    const stale = merged.every((q) => q.value === null);
    return NextResponse.json({ quotes: merged, stale, errors });
  } catch (err) {
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "Не удалось обновить данные" } },
      { status: 500 },
    );
  }
}