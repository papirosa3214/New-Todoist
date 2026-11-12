import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetThinkingTranslationCache,
  shouldTranslate,
  splitForTranslation,
  translateThinkingRu,
} from "../src/lib/thinkingTranslation.js";

/**
 * Размышления роли по-русски (владелец 08.11.2026). Переводчик — локальная
 * модель: в тестах её подменяет `deps.model`, сети нет.
 */
const ENGLISH =
  "Let me check the table component again. The widths are measured on every frame, that is why scrolling stutters.";

describe("thinking translation", () => {
  beforeEach(() => _resetThinkingTranslationCache());

  it("короткое и уже русское не переводим", () => {
    expect(shouldTranslate("ok")).toBe(false);
    expect(shouldTranslate("Смотрю таблицу в чате, ширина колонок считается на каждом кадре — вот и лаги.")).toBe(false);
    expect(shouldTranslate(ENGLISH)).toBe(true);
  });

  it("код не переводим, текст вокруг переводим", () => {
    const pieces = splitForTranslation("First line.\n\n```swift\nlet a = 1\n```\n\nSecond line here.");
    expect(pieces.some((piece) => piece.code)).toBe(true);
    expect(pieces.filter((piece) => !piece.code).map((piece) => piece.text.trim()).join(" ")).toContain("First line.");
  });

  it("перевод возвращается и кэшируется", async () => {
    let calls = 0;
    const model = async (chunk: string) => {
      calls += 1;
      return "Перевод: " + chunk;
    };
    const first = await translateThinkingRu(ENGLISH, { model });
    expect(first).toContain("Перевод:");
    await translateThinkingRu(ENGLISH, { model });
    expect(calls).toBe(1);
  });

  it("сбой модели оставляет оригинал", async () => {
    const result = await translateThinkingRu(ENGLISH, {
      model: async () => {
        throw new Error("модель недоступна");
      },
    });
    expect(result).toBeNull();
  });

  it("обрезанный ответ не выдаём за перевод", async () => {
    const long = ENGLISH.repeat(8);
    const result = await translateThinkingRu(long, { model: async () => "ок" });
    expect(result).toBeNull();
  });
});
