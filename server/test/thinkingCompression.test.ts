// Сжатие рассуждений в запросе к модели (владелец 02.11.2026): «сжимать эти
// рассуждения нужно, когда они пачкой идут в контекст на следующий запрос —
// чтобы уже не полный текст рассуждений шёл, а два-три предложения».
import { describe, expect, it } from "vitest";
import {
  compressContextThoughts,
  compressThinking,
  splitSentences,
  THINKING_SENTENCES,
} from "../src/runtime/thinkingCompression.js";

const LONG = [
  "Let me read the task and the plan first.",
  "The plan says three stages: read the diff, run the checks, write the summary.",
  "The diff looks correct but I want to see the schema.",
  "There is no read access to the live database, so I will use the snapshot.",
  "Now I run the live check through the proxy.",
  "Decision: the catalog contains the tool, so the criterion is met.",
].join(" ");

describe("сжатие рассуждений", () => {
  it("длинное рассуждение сжимается до трёх предложений", () => {
    const compressed = compressThinking(LONG);
    expect(compressed.length).toBeLessThan(LONG.length);
    expect(splitSentences(compressed).length).toBeLessThanOrEqual(THINKING_SENTENCES);
    // Хвост сохранён: вывод и решение на месте.
    expect(compressed).toContain("Decision:");
  });

  it("короткое рассуждение не трогаем", () => {
    const short = "Решение: править здесь.";
    expect(compressThinking(short)).toBe(short);
  });

  it("в запрос уходит сжатая версия, а в сессии остаётся полная", () => {
    const context = {
      messages: [
        { role: "user", content: "сделай" },
        { role: "assistant", content: [{ type: "thinking", thinking: LONG }] },
      ],
    };
    const compressed = compressContextThoughts(context);
    const sent = (compressed.messages[1].content[0] as { thinking: string }).thinking;
    expect(sent.length).toBeLessThan(LONG.length);
    // Оригинал не тронут: полный текст остаётся в сессии и в живом ходе.
    expect((context.messages[1].content[0] as { thinking: string }).thinking).toBe(LONG);
  });

  it("сообщения без рассуждений не меняются", () => {
    const context = { messages: [{ role: "user", content: "привет" }] };
    expect(compressContextThoughts(context)).toBe(context);
  });
});
