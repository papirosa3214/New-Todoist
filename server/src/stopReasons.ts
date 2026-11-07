/**
 * Структурированные причины остановки контура исполнения.
 *
 * Свободный комментарий остаётся объяснением для человека, но не является
 * сигналом для автоматики. Закрытый список здесь — единственная точка, где
 * код причины сопоставляется с действием восстановления.
 */
export const STOP_REASON_CODES = [
  "insufficient_capability",
  "different_competence",
  "result_feedback",
  "technical_failure",
  "provider_limit",
  "permission_or_owner",
  "lease_expired",
  "budget_exhausted",
] as const;

export type StopReasonCode = (typeof STOP_REASON_CODES)[number];

export type StopAction =
  | "escalate_capability"
  | "reroute_competence"
  | "return_for_rework"
  | "retry_technical"
  | "wait_provider"
  | "wait_owner"
  | "close_attempt"
  | "stop_budget";

export type StopReasonPolicy = {
  code: StopReasonCode;
  label: string;
  action: StopAction;
  /** Technical retries are deliberately not substantive attempts. */
  automaticRetry: boolean;
  maxAutomaticRetries: number;
  delaySeconds: number | null;
};

export const STOP_REASON_POLICIES: Record<
  StopReasonCode,
  StopReasonPolicy
> = {
  insufficient_capability: {
    code: "insufficient_capability",
    label: "недостаточная способность",
    action: "escalate_capability",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  different_competence: {
    code: "different_competence",
    label: "нужна другая компетенция",
    action: "reroute_competence",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  result_feedback: {
    code: "result_feedback",
    label: "замечания к результату",
    action: "return_for_rework",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  technical_failure: {
    code: "technical_failure",
    label: "технический сбой",
    action: "retry_technical",
    automaticRetry: true,
    maxAutomaticRetries: 3,
    delaySeconds: 60,
  },
  provider_limit: {
    code: "provider_limit",
    label: "лимит провайдера",
    action: "wait_provider",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  permission_or_owner: {
    code: "permission_or_owner",
    label: "нет прав или нужно решение владельца",
    action: "wait_owner",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  lease_expired: {
    code: "lease_expired",
    label: "истёкшая аренда",
    action: "close_attempt",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
  budget_exhausted: {
    code: "budget_exhausted",
    label: "исчерпанный бюджет",
    action: "stop_budget",
    automaticRetry: false,
    maxAutomaticRetries: 0,
    delaySeconds: null,
  },
};

export function isStopReasonCode(value: unknown): value is StopReasonCode {
  return (
    typeof value === "string" &&
    (STOP_REASON_CODES as readonly string[]).includes(value)
  );
}

export function stopReasonPolicy(
  value: unknown,
): StopReasonPolicy | undefined {
  return isStopReasonCode(value) ? STOP_REASON_POLICIES[value] : undefined;
}

export function stopReasonError(): string {
  return (
    "reason_code должен быть одним из: " + STOP_REASON_CODES.join(", ")
  );
}
