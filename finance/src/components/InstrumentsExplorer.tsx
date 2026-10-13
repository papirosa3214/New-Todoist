"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DISCLAIMER, type Instrument } from "@/lib/instruments";
import type { Quote } from "@/lib/market";

function formatQuote(q: Quote): string {
  if (q.value === null) return "нет данных";
  const digits = q.value >= 1000 ? 0 : q.value >= 1 ? 2 : 4;
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(q.value);
}

function QuoteRow({ quote }: { quote: Quote }) {
  const when = quote.fetchedAt ? new Date(quote.fetchedAt) : null;
  const time =
    when && !Number.isNaN(when.getTime())
      ? new Intl.DateTimeFormat("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(when)
      : null;
  return (
    <div className="border border-ink-200 rounded-lg p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">{quote.label}</span>
        <span className="font-semibold tabular-nums">{formatQuote(quote)}</span>
      </div>
      <div className="text-xs text-ink-500 mt-1">{quote.unit}</div>
      <div className="text-xs text-ink-400 mt-1">
        {quote.source}
        {time ? ` · обновлено ${time}` : ""}
      </div>
      {quote.note ? <div className="text-xs text-ink-400 mt-1">{quote.note}</div> : null}
      <a
        href={quote.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="text-xs text-accent-600 hover:underline"
      >
        Открыть источник
      </a>
    </div>
  );
}

export function InstrumentsExplorer({
  guides,
  quotes,
}: {
  guides: Instrument[];
  quotes: Quote[];
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState(guides[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const active = guides.find((g) => g.id === activeId) ?? guides[0];

  async function refresh() {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/market");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(body?.error?.message ?? "Не удалось обновить данные");
        return;
      }
      const fresh = (body.quotes ?? []).filter((q: Quote) => q.ok).length;
      const failed = (body.errors ?? []).length;
      const missing = (body.quotes ?? []).filter((q: Quote) => !q.ok && q.value !== null).length;
      setMessage(
        body.stale
          ? "Источники сейчас не отвечают — показана последняя сохранённая загрузка."
          : `Обновлено котировок: ${fresh}${missing ? `, без ответа: ${missing}` : ""}${
              failed ? `, источников не ответили: ${failed}` : ""
            }.`,
      );
      router.refresh();
    } catch {
      setMessage("Сеть недоступна — показана последняя сохранённая загрузка.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-ink-200 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h2 className="text-sm font-semibold">Данные на сегодня</h2>
          <button
            onClick={refresh}
            disabled={pending}
            className="bg-accent-600 text-white text-sm rounded-md px-3 py-1.5 hover:bg-accent-700 disabled:opacity-60"
          >
            {pending ? "Обновляем…" : "Обновить данные"}
          </button>
        </div>
        <p className="text-xs text-ink-500 mb-3">{DISCLAIMER}</p>
        {message ? <p className="text-xs text-ink-600 mb-3">{message}</p> : null}
        {quotes.length === 0 ? (
          <p className="text-sm text-ink-500">
            Данных пока нет. Нажмите «Обновить данные» — приложение заберёт свежие значения из открытых
            источников и запомнит их вместе с датой.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {quotes.map((q) => (
              <QuoteRow key={q.symbol} quote={q} />
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-ink-200 rounded-xl p-2 h-fit">
          {guides.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveId(g.id)}
              className={`block w-full text-left px-3 py-2 rounded-md text-sm ${
                g.id === active?.id
                  ? "bg-accent-500/10 text-accent-700 font-medium"
                  : "text-ink-700 hover:bg-ink-100"
              }`}
            >
              {g.title}
            </button>
          ))}
        </div>

        {active ? (
          <div className="lg:col-span-3 bg-white border border-ink-200 rounded-xl p-4 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">{active.title}</h2>
              <p className="text-sm text-ink-700 mt-1">{active.tagline}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="Как это работает" items={active.howItWorks} />
              <Section title="Риски" items={active.risks} tone="danger" />
              <Section title="Кому обычно подходит" items={active.fitFor} />
              <Section title="На что смотреть" items={active.watch} />
            </div>

            {active.quoteSymbols.length > 0 ? (
              <p className="text-xs text-ink-400">
                Свежие данные по инструменту — в блоке «Данные на сегодня» выше:{" "}
                {active.quoteSymbols.join(", ")}.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  tone = "default",
}: {
  title: string;
  items: string[];
  tone?: "default" | "danger";
}) {
  return (
    <div>
      <h3 className={`text-sm font-semibold mb-2 ${tone === "danger" ? "text-danger-500" : ""}`}>
        {title}
      </h3>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-ink-700 flex gap-2">
            <span className="text-ink-400">—</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}