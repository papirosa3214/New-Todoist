// Обрыв сети — не провал роли (владелец 02.11.2026): «сетевые обрывы,
// именно связанные с сетью, да, не засчитывать, пусть долбится».
import { describe, expect, it } from "vitest";
import { classifyFailureReason } from "../src/runtime/failureReasons.js";
import {
  decideFailureAction,
  failurePolicy,
  isNetworkFailure,
  isRetryable,
} from "../src/runtime/failurePolicy.js";

describe("обрыв сети в словаре причин", () => {
  it.each([
    "Request timed out.",
    "fetch failed",
    "ConnectTimeoutError: Connect Timeout Error (attempted addresses: 2.21.173.160:443, timeout: 10000)",
    "socket hang up",
    "ECONNRESET",
    "getaddrinfo ENOTFOUND api.minimax.io",
    "read ECONNRESET",
  ])("опознаётся как сеть: %s", text => {
    expect(classifyFailureReason(text)).toBe("provider_network");
  });

  it("лимит провайдера остаётся лимитом, а не сетью", () => {
    expect(classifyFailureReason("429 Too Many Requests")).toBe("provider_rate_limit");
    expect(classifyFailureReason("insufficient_quota")).toBe("provider_quota_limit");
  });

  it("пустой ответ остаётся пустым ответом", () => {
    expect(classifyFailureReason("модель вернула пустой ответ: ни текста, ни вызова инструмента")).toBe(
      "empty_answer",
    );
  });
});

describe("политика по обрыву сети", () => {
  it("сеть — повтор, а не блок", () => {
    const policy = failurePolicy("provider_network");
    expect(policy.kind).toBe("network_retry");
    expect(policy.maxRetries).toBeGreaterThan(2);
    expect(isNetworkFailure("provider_network")).toBe(true);
    expect(isRetryable("provider_network")).toBe(true);
  });

  it("решение — повтор, пока не кончится потолок", () => {
    expect(decideFailureAction("provider_network", 0)).toBe("network_retry");
    expect(decideFailureAction("provider_network", 5)).toBe("network_retry");
  });

  it("сеть не блокируется: блок только у настоящих сбоев", () => {
    expect(decideFailureAction("empty_answer", 0)).toBe("block");
    expect(decideFailureAction("provider_auth_or_access", 0)).toBe("block");
    expect(isNetworkFailure("unknown")).toBe(false);
  });
});
