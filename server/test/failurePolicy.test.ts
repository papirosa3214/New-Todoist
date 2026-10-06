// Политика повтора по коду причины (MAK-97, пункт 3): что сервер делает с
// каждым кодом закрытого словаря — повтор, смена модели, сжатие или блок.
// Таблица чистая, поэтому проверяем её напрямую, без базы и модели.
import { describe, expect, it } from "vitest";
import { FAILURE_REASON_CODES, type FailureReasonCode } from "../src/runtime/failureReasons.js";
import {
  FAILURE_POLICIES,
  decideFailureAction,
  failurePolicy,
  isImmediateBlock,
  isModelSwitch,
  isRetryable,
} from "../src/runtime/failurePolicy.js";

describe("политика повтора по коду причины", () => {
  it("таблица покрывает каждый код закрытого словаря", () => {
    for (const code of FAILURE_REASON_CODES) {
      expect(FAILURE_POLICIES[code], `нет политики для ${code}`).toBeDefined();
      expect(failurePolicy(code).label.length).toBeGreaterThan(0);
    }
  });

  it("временные сбои повторяются в той же сессии", () => {
    for (const code of ["provider_rate_limit", "provider_server_error", "taskcontext_timeout", "runtime_died"] as FailureReasonCode[]) {
      expect(isRetryable(code), code).toBe(true);
      expect(decideFailureAction(code, 0)).toBe("retry");
      expect(failurePolicy(code).maxRetries).toBeGreaterThanOrEqual(1);
    }
  });

  it("число повторов ограничено: за потолком временный сбой даёт блок", () => {
    expect(decideFailureAction("provider_server_error", 0)).toBe("retry");
    expect(decideFailureAction("provider_server_error", 1)).toBe("retry");
    expect(decideFailureAction("provider_server_error", 2)).toBe("block");
    expect(decideFailureAction("taskcontext_timeout", 1)).toBe("block");
  });

  it("лимит частоты: сначала повтор, за потолком — запасная модель", () => {
    expect(decideFailureAction("provider_rate_limit", 0)).toBe("retry");
    expect(decideFailureAction("provider_rate_limit", 1)).toBe("retry");
    expect(decideFailureAction("provider_rate_limit", 2)).toBe("switch_model");
    expect(isModelSwitch("provider_rate_limit")).toBe(true);
  });

  it("квота — сразу запасная модель, без повторов", () => {
    expect(failurePolicy("provider_quota_limit").maxRetries).toBe(0);
    expect(decideFailureAction("provider_quota_limit", 0)).toBe("switch_model");
  });

  it("переполнение контекста сжимается и продолжается", () => {
    expect(decideFailureAction("context_overflow", 0)).toBe("compress_continue");
    expect(decideFailureAction("context_overflow", 5)).toBe("compress_continue");
  });

  it("доступ, конфиг и отсутствие модели не повторяются и модель не меняют: сразу блок", () => {
    for (const code of ["provider_auth_or_access", "missing_config", "model_unavailable"] as FailureReasonCode[]) {
      expect(isImmediateBlock(code), code).toBe(true);
      expect(isRetryable(code), code).toBe(false);
      expect(isModelSwitch(code), code).toBe(false);
      // Сколько бы повторов ни было — решение всегда «блок».
      expect(decideFailureAction(code, 0)).toBe("block");
      expect(decideFailureAction(code, 10)).toBe("block");
    }
  });

  it("отмена, застой и нераспознанная причина тоже блокируют", () => {
    for (const code of ["cancelled", "step_stalled", "unknown"] as FailureReasonCode[]) {
      expect(decideFailureAction(code, 0)).toBe("block");
    }
  });
});
