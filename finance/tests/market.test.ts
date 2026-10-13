import { describe, it, expect } from "vitest";
import {
  parseCbrDailyXml,
  parseCoingeckoJson,
  parseMoexBondsJson,
  parseMoexIndexJson,
  parseYahooChartJson,
} from "../src/lib/market";

/**
 * Разбор ответов источников проверяется на коротких фикстурах: сеть в тестах не
 * используется, поэтому тесты не зависят от того, отвечает ли биржа сегодня.
 */

const CBR_XML = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="13.10.2026" name="Foreign Currency Market">
  <Valute ID="R01010"><NumCode>036</NumCode><CharCode>AUD</CharCode><Nominal>1</Nominal><Value>58,5645</Value></Valute>
  <Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Value>83,9153</Value></Valute>
  <Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>116,7022</Value></Valute>
</ValCurs>`;

describe("курсы валют ЦБ", () => {
  const parsed = parseCbrDailyXml(CBR_XML);

  it("берёт дату из атрибута и переводит её в ISO", () => {
    expect(parsed.date).toBe("2026-10-13");
  });

  it("читает курс и учитывает номинал", () => {
    expect(parsed.rates.USD).toBe(83.9153);
    expect(parsed.rates.CNY).toBeCloseTo(11.6702, 4);
  });

  it("пустой или битый ответ не роняет разбор", () => {
    expect(parseCbrDailyXml("").rates).toEqual({});
    expect(parseCbrDailyXml("<ValCurs Date=\"01.01.2026\"></ValCurs>").date).toBe("2026-01-01");
  });
});

describe("индекс Московской биржи", () => {
  it("берёт последнее значение и дату торгов", () => {
    const json = JSON.stringify({
      marketdata: {
        columns: ["TRADEDATE", "LOW", "HIGH"],
        data: [["2026-10-13", 2375.11, 2422.72]],
      },
    });
    expect(parseMoexIndexJson(json)).toEqual({ value: null, date: "2026-10-13" });
  });

  it("читает значение, когда биржа отдаёт LASTVALUE", () => {
    const json = JSON.stringify({
      marketdata: {
        columns: ["SECID", "LASTVALUE", "CURRENTVALUE", "TRADEDATE"],
        data: [["IMOEX", 2393.83, 2416.56, "2026-10-13"]],
      },
    });
    const parsed = parseMoexIndexJson(json);
    expect(parsed.value).toBe(2393.83);
    expect(parsed.date).toBe("2026-10-13");
  });

  it("пустой ответ даёт null, а не NaN", () => {
    expect(parseMoexIndexJson(JSON.stringify({ marketdata: { columns: [], data: [] } }))).toEqual({
      value: null,
      date: "",
    });
    expect(parseMoexIndexJson("не json").value).toBeNull();
  });
});

describe("облигации", () => {
  it("считает диапазон доходностей по бумагам", () => {
    const json = JSON.stringify({
      securities: {
        columns: ["SECID", "YIELDATPREVWAPRICE", "PREVDATE"],
        data: [
          ["SU26238", 14.1, "2026-10-12"],
          ["SU26240", 15.3, "2026-10-12"],
          ["пусто", null, null],
        ],
      },
    });
    const parsed = parseMoexBondsJson(json);
    expect(parsed).toEqual({ minYield: 14.1, maxYield: 15.3, count: 2, date: "2026-10-12" });
  });

  it("пустая выдача не считается данными", () => {
    const parsed = parseMoexBondsJson(JSON.stringify({ securities: { columns: [], data: [] } }));
    expect(parsed.minYield).toBeNull();
    expect(parsed.count).toBe(0);
  });
});

describe("золото Yahoo Finance", () => {
  it("читает цену и валюту", () => {
    const json = JSON.stringify({
      chart: {
        result: [{ meta: { symbol: "GC=F", currency: "USD", regularMarketPrice: 4208.4 } }],
      },
    });
    expect(parseYahooChartJson(json)).toEqual({ price: 4208.4, currency: "USD", symbol: "GC=F" });
  });

  it("ответ без данных не превращается в ноль", () => {
    expect(parseYahooChartJson(JSON.stringify({ chart: { result: [] } })).price).toBeNull();
  });
});

describe("криптовалюта CoinGecko", () => {
  it("читает цены в рублях и долларах", () => {
    const json = JSON.stringify({ bitcoin: { rub: 6982258, usd: 83000 }, ethereum: { rub: 209486 } });
    const parsed = parseCoingeckoJson(json);
    expect(parsed.bitcoin.rub).toBe(6982258);
    expect(parsed.ethereum.rub).toBe(209486);
    expect(parsed.ethereum.usd).toBeNull();
  });

  it("битый ответ даёт пустой объект", () => {
    expect(parseCoingeckoJson("ошибка")).toEqual({});
  });
});