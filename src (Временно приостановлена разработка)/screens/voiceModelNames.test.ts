// В интерфейсе не должно оставаться технических имён моделей.
//
// Владелец 26.08.2026, увидев «large-v3-v20240930» подписью под «Точная»:
// «я ж тебе сказал, по-человечески чтобы было написано». Тест держит это
// правило: любое имя из репозитория WhisperKit обязано превращаться в
// человеческое, а не просачиваться на экран как есть.
import { describe, it, expect } from "vitest";
import { humanName } from "./voiceModelNames";

describe("человеческие названия голосовых моделей", () => {
  it("узнаёт две главные роли", () => {
    expect(humanName("openai_whisper-large-v3-v20240930_626MB")).toBe("Точная");
    expect(humanName("openai_whisper-distil-large-v3_594MB")).toBe("Быстрая");
  });

  it("называет остальные семейства по величине", () => {
    expect(humanName("openai_whisper-large-v2")).toBe("Большая");
    expect(humanName("openai_whisper-medium")).toBe("Средняя");
    expect(humanName("openai_whisper-small")).toBe("Небольшая");
    expect(humanName("openai_whisper-base")).toBe("Лёгкая");
    expect(humanName("openai_whisper-tiny")).toBe("Самая лёгкая");
  });

  it("ни в одном названии нет версий, чисел и мегабайт", () => {
    const all = [
      "openai_whisper-large-v3-v20240930_626MB",
      "openai_whisper-distil-large-v3_594MB",
      "openai_whisper-large-v2",
      "openai_whisper-medium_769MB",
      "openai_whisper-small",
      "openai_whisper-base",
      "openai_whisper-tiny",
    ];
    for (const model of all) {
      const name = humanName(model);
      expect(name).not.toMatch(/\d/);
      expect(name).not.toMatch(/whisper|distil|large|medium|small|base|tiny|MB/i);
    }
  });
});
