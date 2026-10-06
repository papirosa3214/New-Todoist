import { describe, expect, it } from "vitest";
import { isSilenceOnly } from "../src/runtime/silenceToken.js";

describe("токен молчания (MAK-99)", () => {
  it("пустые подтверждения — молчание", () => {
    for (const text of [
      "принял",
      "Принято.",
      "понял",
      "ок",
      "ок, принял",
      "принял, отвечу позже",
      "@builder принял",
      "[slot: executor] принял",
      "[SILENT]",
      "[NO_REPLY]",
      "   ",
    ]) {
      expect(isSilenceOnly(text), text).toBe(true);
    }
  });

  it("вопрос, факт и результат остаются сообщением", () => {
    for (const text of [
      "проверил: падает на 42 строке",
      "вопрос: какой формат вывода?",
      "принял, но есть вопрос по критериям",
      "готово, коммит abc123",
      "нашёл дефект в chats.ts",
      "https://example.com/отчёт",
      "ответ длиной в абзац, где перечислены конкретные шаги и решения",
    ]) {
      expect(isSilenceOnly(text), text).toBe(false);
    }
  });
});
