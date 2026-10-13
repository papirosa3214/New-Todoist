import { describe, it, expect } from "vitest";
import { DISCLAIMER, INSTRUMENTS, instrumentQuoteSymbols } from "../src/lib/instruments";

/**
 * Справочник объясняет, как устроен инструмент и где риски. Проверяем, что
 * формат соблюдён и в текстах не появилось советов «покупай» или обещаний
 * гарантированного дохода — это прямое требование карточки.
 */
const FORBIDDEN = [
  "покупай",
  "продавай",
  "рекомендуем",
  "стоит вложить",
  "следует купить",
  "гарантированно",
  "гарантируем",
  "прогноз цены",
];

describe("справочник по инструментам", () => {
  it("охватывает пять групп инструментов из карточки", () => {
    expect(INSTRUMENTS.map((i) => i.kind).sort()).toEqual([
      "bonds",
      "crypto",
      "currency",
      "gold",
      "stocks",
    ]);
  });

  it("у каждого инструмента есть суть, устройство, риски, кому подходит и на что смотреть", () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.tagline.length, instrument.id).toBeGreaterThan(20);
      expect(instrument.howItWorks.length, instrument.id).toBeGreaterThan(0);
      expect(instrument.risks.length, instrument.id).toBeGreaterThan(0);
      expect(instrument.fitFor.length, instrument.id).toBeGreaterThan(0);
      expect(instrument.watch.length, instrument.id).toBeGreaterThan(0);
      expect(instrument.quoteSymbols.length, instrument.id).toBeGreaterThan(0);
    }
  });

  it("в текстах нет советов купить и обещаний дохода", () => {
    for (const instrument of INSTRUMENTS) {
      const text = [
        instrument.tagline,
        ...instrument.howItWorks,
        ...instrument.risks,
        ...instrument.fitFor,
        ...instrument.watch,
      ]
        .join(" ")
        .toLowerCase();
      for (const phrase of FORBIDDEN) {
        expect(text.includes(phrase), `${instrument.id}: «${phrase}»`).toBe(false);
      }
    }
  });

  it("оговорка о справочном характере есть и не пустая", () => {
    expect(DISCLAIMER).toContain("не инвестиционная рекомендация");
  });

  it("котировки инструментов не повторяются в справочнике дважды", () => {
    const symbols = instrumentQuoteSymbols();
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});