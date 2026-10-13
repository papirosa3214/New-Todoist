/**
 * Актуальные данные из открытых источников для справочника.
 *
 * Источники без ключей и регистрации: ЦБ РФ (курсы валют), Московская биржа
 * (индекс и облигации), Yahoo Finance (золото), CoinGecko (криптовалюта).
 *
 * Разбор ответов вынесен в чистые функции — они покрыты тестами с фикстурами
 * (tests/market.test.ts). Сеть используется только на сервере.
 */

import type { InstrumentKind } from "./instruments";

export type QuoteKind = InstrumentKind | "fx" | "ofz";

export type Quote = {
  symbol: string;
  kind: QuoteKind;
  label: string;
  /** Числовое значение: 83,91; 0,42; 143076 — либо null, если источник не ответил */
  value: number | null;
  /** Единица измерения: "₽ за 1 USD", "₽ за 1 г", "пункты индекса", "% годовых" */
  unit: string;
  source: string;
  sourceUrl: string;
  /** Дата и время получения данных */
  fetchedAt: string;
  ok: boolean;
  note?: string;
};

export const SOURCE_URLS = {
  cbr: "https://www.cbr.ru/scripts/XML_daily.asp",
  cbrPage: "https://www.cbr.ru/currency_base/daily/",
  moexIndex:
    "https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json?iss.meta=off",
  moexBonds: "https://iss.moex.com/iss/engines/stock/markets/bonds/boards/governmentbonds/securities.json?iss.meta=off",
  yahooGold:
    "https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d",
  yahooGoldPage: "https://finance.yahoo.com/quote/GC=F",
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=rub,usd",
  coingeckoPage: "https://www.coingecko.com/ru",
} as const;

const OZ_IN_GRAM = 31.1034768;

/**
 * Какие котировки показывает справочник, даже если данные ещё не загружались:
 * список символов с подписями и источниками. Панель рисует все строки этого
 * списка, чтобы было видно и «нет данных», а не пустоту.
 */
export const QUOTE_CATALOG: Omit<Quote, "value" | "fetchedAt" | "ok" | "note">[] = [
  {
    symbol: "USD",
    kind: "fx",
    label: "Доллар США",
    unit: "₽ за 1 единицу",
    source: "ЦБ РФ",
    sourceUrl: SOURCE_URLS.cbrPage,
  },
  {
    symbol: "EUR",
    kind: "fx",
    label: "Евро",
    unit: "₽ за 1 единицу",
    source: "ЦБ РФ",
    sourceUrl: SOURCE_URLS.cbrPage,
  },
  {
    symbol: "CNY",
    kind: "fx",
    label: "Китайский юань",
    unit: "₽ за 1 единицу",
    source: "ЦБ РФ",
    sourceUrl: SOURCE_URLS.cbrPage,
  },
  {
    symbol: "IMOEX",
    kind: "stocks",
    label: "Индекс Московской биржи",
    unit: "пункты индекса",
    source: "Московская биржа",
    sourceUrl: SOURCE_URLS.moexIndex,
  },
  {
    symbol: "OFZ",
    kind: "ofz",
    label: "Доходность облигаций (ОФЗ)",
    unit: "% годовых, среднее по рынку",
    source: "Московская биржа",
    sourceUrl: SOURCE_URLS.moexBonds,
  },
  {
    symbol: "GOLD",
    kind: "gold",
    label: "Золото",
    unit: "₽ за 1 г",
    source: "Yahoo Finance (COMEX) × курс ЦБ РФ",
    sourceUrl: SOURCE_URLS.yahooGoldPage,
  },
  {
    symbol: "BTC",
    kind: "crypto",
    label: "Биткоин",
    unit: "₽ за 1 штуку",
    source: "CoinGecko",
    sourceUrl: SOURCE_URLS.coingeckoPage,
  },
  {
    symbol: "ETH",
    kind: "crypto",
    label: "Эфириум",
    unit: "₽ за 1 штуку",
    source: "CoinGecko",
    sourceUrl: SOURCE_URLS.coingeckoPage,
  },
];

function num(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* Разбор ответов источников (чистые функции)                          */
/* ------------------------------------------------------------------ */

export type CbrDaily = { date: string; rates: Record<string, number> };

/** XML ЦБ в windows-1251: вытаскиваем дату и курсы по кодам валют. */
export function parseCbrDailyXml(xml: string): CbrDaily {
  const dateMatch = xml.match(/Date="(\d{2}\.\d{2}\.\d{4})"/);
  const date = dateMatch ? dateMatch[1].split(".").reverse().join("-") : "";
  const rates: Record<string, number> = {};
  const blockRe = /<Valute\b[\s\S]*?<\/Valute>/g;
  for (const block of xml.match(blockRe) ?? []) {
    const code = block.match(/<CharCode>([A-Z]{3})<\/CharCode>/)?.[1];
    const nominal = Number(block.match(/<Nominal>([\d.]+)<\/Nominal>/)?.[1] ?? "1");
    const value = block.match(/<Value>([\d,]+(?:[.,]\d+)?)<\/Value>/)?.[1];
    if (!code || !value) continue;
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed) || !Number.isFinite(nominal) || nominal === 0) continue;
    rates[code] = num(parsed / nominal);
  }
  return { date, rates };
}

/** Московская биржа: последнее значение индекса и дата торгов. */
export function parseMoexIndexJson(text: string): { value: number | null; date: string } {
  try {
    const json = JSON.parse(text);
    const block = json?.marketdata;
    if (!block?.columns || !Array.isArray(block.data) || block.data.length === 0) {
      return { value: null, date: "" };
    }
    const idx = (name: string) => block.columns.indexOf(name);
    // LASTVALUE — последнее значение, CURRENTVALUE — текущее с торгов; если биржа
    // не отдала ни одного, берём открытие сессии, чтобы число не молча пропало
    const iLast = ["LASTVALUE", "CURRENTVALUE", "LAST", "OPENVALUE"]
      .map(idx)
      .find((i) => i >= 0);
    const iDate = idx("TRADEDATE");
    const row = block.data[0];
    const value = iLast !== undefined ? Number(row[iLast]) : Number.NaN;
    return {
      value: Number.isFinite(value) && value !== 0 ? num(value) : null,
      date: iDate >= 0 ? String(row[iDate] ?? "") : "",
    };
  } catch {
    return { value: null, date: "" };
  }
}

/** Облигации: диапазон доходностей по государственным бумагам на последней торговой сессии. */
export function parseMoexBondsJson(text: string): {
  minYield: number | null;
  maxYield: number | null;
  count: number;
  date: string;
} {
  try {
    const json = JSON.parse(text);
    const block = json?.securities;
    if (!block?.columns || !Array.isArray(block.data)) {
      return { minYield: null, maxYield: null, count: 0, date: "" };
    }
    const iYield = block.columns.indexOf("YIELDATPREVWAPRICE");
    const iDate = block.columns.indexOf("PREVDATE");
    const yields: number[] = [];
    let date = "";
    for (const row of block.data) {
      const y = iYield >= 0 ? Number(row[iYield]) : Number.NaN;
      if (Number.isFinite(y) && y > 0 && y < 100) yields.push(y);
      if (!date && iDate >= 0) date = String(row[iDate] ?? "");
    }
    if (yields.length === 0) return { minYield: null, maxYield: null, count: 0, date };
    yields.sort((a, b) => a - b);
    return {
      minYield: num(yields[0]),
      maxYield: num(yields[yields.length - 1]),
      count: yields.length,
      date,
    };
  } catch {
    return { minYield: null, maxYield: null, count: 0, date: "" };
  }
}

/** Yahoo Finance: последняя цена инструмента. */
export function parseYahooChartJson(text: string): {
  price: number | null;
  currency: string;
  symbol: string;
} {
  try {
    const json = JSON.parse(text);
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return { price: null, currency: "", symbol: "" };
    const price = Number(meta.regularMarketPrice);
    return {
      price: Number.isFinite(price) ? num(price) : null,
      currency: String(meta.currency ?? ""),
      symbol: String(meta.symbol ?? ""),
    };
  } catch {
    return { price: null, currency: "", symbol: "" };
  }
}

/** CoinGecko: цены в рублях и долларах по идентификаторам монет. */
export function parseCoingeckoJson(text: string): Record<string, { rub: number | null; usd: number | null }> {
  const out: Record<string, { rub: number | null; usd: number | null }> = {};
  try {
    const json = JSON.parse(text);
    for (const [id, prices] of Object.entries(json ?? {})) {
      const p = prices as Record<string, unknown>;
      const rub = Number(p.rub);
      const usd = Number(p.usd);
      out[id] = {
        rub: Number.isFinite(rub) ? num(rub) : null,
        usd: Number.isFinite(usd) ? num(usd) : null,
      };
    }
  } catch {
    /* пустой ответ */
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Загрузка данных                                                    */
/* ------------------------------------------------------------------ */

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; finance-app/1.0)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function quote(partial: Omit<Quote, "fetchedAt" | "ok"> & { ok?: boolean; fetchedAt?: string }): Quote {
  return { fetchedAt: new Date().toISOString(), ok: true, ...partial };
}

/**
 * Собирает котировки из всех источников. Источник, который не ответил, даёт
 * котировку со значением null — приложение покажет, что данные не обновились.
 */
export async function collectQuotes(): Promise<{ quotes: Quote[]; errors: string[] }> {
  const errors: string[] = [];

  const [cbr, index, bonds, gold, crypto] = await Promise.allSettled([
    fetchText(SOURCE_URLS.cbr).then(parseCbrDailyXml),
    fetchText(SOURCE_URLS.moexIndex).then(parseMoexIndexJson),
    fetchText(SOURCE_URLS.moexBonds).then(parseMoexBondsJson),
    fetchText(SOURCE_URLS.yahooGold).then(parseYahooChartJson),
    fetchText(SOURCE_URLS.coingecko).then(parseCoingeckoJson),
  ]);

  const cbrData = cbr.status === "fulfilled" ? cbr.value : null;
  if (cbr.status === "rejected") errors.push(`Курсы валют ЦБ: ${String(cbr.reason)}`);

  const quotes: Quote[] = [];

  for (const [symbol, label] of [
    ["USD", "Доллар США"],
    ["EUR", "Евро"],
    ["CNY", "Китайский юань"],
  ] as const) {
    const rate = cbrData?.rates?.[symbol];
    quotes.push(
      quote({
        symbol,
        kind: "fx",
        label,
        value: typeof rate === "number" ? rate : null,
        unit: "₽ за 1 единицу",
        source: `ЦБ РФ, курс на ${cbrData?.date || "сегодня"}`,
        sourceUrl: SOURCE_URLS.cbrPage,
        ok: typeof rate === "number",
        note: typeof rate === "number" ? undefined : "Источник не ответил, показана последняя загрузка",
      }),
    );
  }

  const indexData = index.status === "fulfilled" ? index.value : null;
  if (index.status === "rejected") errors.push(`Индекс Мосбиржи: ${String(index.reason)}`);
  quotes.push(
    quote({
      symbol: "IMOEX",
      kind: "stocks",
      label: "Индекс Московской биржи",
      value: indexData?.value ?? null,
      unit: "пункты индекса",
      source: `Московская биржа${indexData?.date ? `, торги ${indexData.date}` : ""}`,
      sourceUrl: SOURCE_URLS.moexIndex,
      ok: typeof indexData?.value === "number",
      note: typeof indexData?.value === "number" ? undefined : "Источник не ответил, показана последняя загрузка",
    }),
  );

  const bondsData = bonds.status === "fulfilled" ? bonds.value : null;
  if (bonds.status === "rejected") errors.push(`Облигации: ${String(bonds.reason)}`);
  const bondYield =
    typeof bondsData?.minYield === "number" && typeof bondsData?.maxYield === "number"
      ? num((bondsData.minYield + bondsData.maxYield) / 2)
      : null;
  const bondsOk = bondYield !== null && bondsData !== null;
  quotes.push(
    quote({
      symbol: "OFZ",
      kind: "ofz",
      label: "Доходность облигаций (ОФЗ)",
      value: bondYield,
      unit: "% годовых, среднее по рынку",
      source: bondsOk
        ? `Московская биржа, ${bondsData.count} бумаг${bondsData.date ? `, ${bondsData.date}` : ""}, среднее от ${bondsData.minYield} до ${bondsData.maxYield}`
        : "Московская биржа",
      sourceUrl: SOURCE_URLS.moexBonds,
      ok: bondsOk,
      note: bondsOk ? undefined : "Источник не ответил, показана последняя загрузка",
    }),
  );

  const goldData = gold.status === "fulfilled" ? gold.value : null;
  if (gold.status === "rejected") errors.push(`Золото: ${String(gold.reason)}`);
  const usdRate = cbrData?.rates?.USD;
  const goldUsdPerGram =
    typeof goldData?.price === "number" ? num(goldData.price / OZ_IN_GRAM) : null;
  const goldRubPerGram =
    typeof goldUsdPerGram === "number" && typeof usdRate === "number"
      ? num(goldUsdPerGram * usdRate)
      : null;
  quotes.push(
    quote({
      symbol: "GOLD",
      kind: "gold",
      label: "Золото",
      value: goldRubPerGram ?? goldUsdPerGram,
      unit: typeof goldRubPerGram === "number" ? "₽ за 1 г (пересчёт из долларов)" : "$ за 1 г",
      source:
        typeof goldRubPerGram === "number"
          ? "Yahoo Finance (COMEX, доллары за унцию) × курс ЦБ РФ, 1 унция = 31,1035 г"
          : "Yahoo Finance, COMEX",
      sourceUrl: SOURCE_URLS.yahooGoldPage,
      ok: goldRubPerGram !== null || goldUsdPerGram !== null,
      note:
        goldRubPerGram !== null || goldUsdPerGram !== null
          ? undefined
          : "Источник не ответил, показана последняя загрузка",
    }),
  );

  const cryptoData = crypto.status === "fulfilled" ? crypto.value : null;
  if (crypto.status === "rejected") errors.push(`Криптовалюта: ${String(crypto.reason)}`);
  for (const [symbol, id, label] of [
    ["BTC", "bitcoin", "Биткоин"],
    ["ETH", "ethereum", "Эфириум"],
  ] as const) {
    const rub = cryptoData?.[id]?.rub ?? null;
    quotes.push(
      quote({
        symbol,
        kind: "crypto",
        label,
        value: rub,
        unit: "₽ за 1 штуку",
        source: "CoinGecko",
        sourceUrl: SOURCE_URLS.coingeckoPage,
        ok: rub !== null,
        note: rub !== null ? undefined : "Источник не ответил, показана последняя загрузка",
      }),
    );
  }

  return { quotes, errors };
}