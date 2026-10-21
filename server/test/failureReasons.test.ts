// Классификатор причин сбоя (MAK-96): текст ошибки → код из закрытого
// словаря. Тексты — не выдуманные, а те, что реально приходят от провайдеров
// и из наших же мест (перечислены в критериях приёмки карточки).
import { describe, expect, it } from "vitest";
import {
  FAILURE_REASON_CODES,
  classifyFailure,
  classifyFailureReason,
  failureReasonLabel,
  isFailureReasonCode,
} from "../src/runtime/failureReasons.js";

describe("классификатор причин сбоя", () => {
  it("весь закрытый словарь распознаётся как код", () => {
    for (const code of FAILURE_REASON_CODES) {
      expect(isFailureReasonCode(code)).toBe(true);
      expect(failureReasonLabel(code)).toBeTruthy();
    }
  });

  it("429 с телом — лимит частоты, а не общая ошибка", () => {
    expect(
      classifyFailureReason(
        '429 {"error":{"message":"Rate limit reached for gpt-4o","type":"requests","code":"rate_limit_exceeded"}}',
      ),
    ).toBe("provider_rate_limit");
    expect(classifyFailureReason("provider returned 429 Too Many Requests")).toBe("provider_rate_limit");
  });

  it("429 c insufficient_quota — исчерпанная квота, не частота", () => {
    expect(
      classifyFailureReason(
        '429 {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
      ),
    ).toBe("provider_quota_limit");
  });

  it("402 payment required — квота/биллинг", () => {
    expect(classifyFailureReason("402 Payment Required: credit balance too low")).toBe("provider_quota_limit");
  });

  it("401/403 — доступ/права провайдера", () => {
    expect(classifyFailureReason("401 Unauthorized: invalid api key")).toBe("provider_auth_or_access");
    expect(classifyFailureReason("403 Forbidden: permission denied for this model")).toBe("provider_auth_or_access");
  });

  it("«TaskContext превысила 15 секунд» — таймаут моста, а не контекст модели", () => {
    expect(classifyFailureReason("сборка TaskContext v1 превысила 15 секунд")).toBe("taskcontext_timeout");
    expect(classifyFailureReason("TaskContext >15 с")).toBe("taskcontext_timeout");
  });

  it("«fallbacks.builder должен быть списком строк» — сломанный конфиг", () => {
    expect(classifyFailureReason("fallbacks.builder должен быть списком строк")).toBe("missing_config");
    expect(classifyFailureReason("ошибка role-routing.yaml: неизвестная роль")).toBe("missing_config");
  });

  it("переполнение контекста модели", () => {
    expect(
      classifyFailureReason("This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens."),
    ).toBe("context_overflow");
    expect(classifyFailureReason("переполнение контекста: prompt is too long")).toBe("context_overflow");
    // Открытый код провайдеров OpenAI/Anthropic (доработка 1 по ревью).
    expect(classifyFailureReason("context_length_exceeded")).toBe("context_overflow");
  });

  it("недоступная модель и ошибка провайдера", () => {
    expect(classifyFailureReason("модель «opencode-go/qwen» недоступна")).toBe("model_unavailable");
    expect(classifyFailureReason("model_not_available: openai/gpt-5")).toBe("model_unavailable");
    expect(classifyFailureReason("502 Bad Gateway from upstream")).toBe("provider_server_error");
    // Идентификатор модели провайдера перед «недоступна» (доработка 1).
    expect(classifyFailureReason("модель openai/gpt-5 недоступна")).toBe("model_unavailable");
    expect(classifyFailureReason("openai/gpt-5 недоступна")).toBe("model_unavailable");
  });

  it("застой шага, отмена и смерть рантайма", () => {
    expect(classifyFailureReason("ход закончился без сдачи шага")).toBe("step_stalled");
    expect(classifyFailureReason("запуск cancellation requested")).toBe("cancelled");
    expect(classifyFailureReason("ход оборвался перезапуском сервера")).toBe("runtime_died");
    expect(classifyFailureReason("socket hang up ECONNRESET")).toBe("runtime_died");
    // «сервер перезапустился» — без слова «перезапуск» рядом (доработка 1).
    expect(classifyFailureReason("сервер перезапустился")).toBe("runtime_died");
  });

  it("пустой ответ модели — свой код, а не застой и не смерть рантайма", () => {
    expect(classifyFailureReason("модель вернула пустой ответ: ни текста, ни вызова инструмента")).toBe("empty_answer");
    expect(classifyFailureReason("модель завершила ход без текста ответа")).toBe("empty_answer");
    expect(classifyFailureReason("empty answer from provider")).toBe("empty_answer");
  });

  it("непонятный текст — unknown, пустой — тоже", () => {
    expect(classifyFailureReason("что-то пошло не так")).toBe("unknown");
    expect(classifyFailureReason("")).toBe("unknown");
    expect(classifyFailureReason(null)).toBe("unknown");
  });

  it("классификатор принимает Error и голую строку", () => {
    expect(classifyFailure(new Error("429 rate limit"))).toBe("provider_rate_limit");
    expect(classifyFailure("403 forbidden")).toBe("provider_auth_or_access");
  });
});
