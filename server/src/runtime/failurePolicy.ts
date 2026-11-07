// Политика реакции сервера на код причины сбоя шага (MAK-97, пункт 3 плана
// «Коммуникация агентов», 06.10.2026).
//
// Словарь кодов и классификатор текста живут в `failureReasons.ts` (MAK-96):
// там только распознавание. Здесь — что сервер делает с кодом, без модели и
// без живой сессии оркестратора:
//
//   • временное (`provider_rate_limit`, `provider_server_error`,
//     `taskcontext_timeout`, `runtime_died`) — повтор в той же сессии,
//     число повторов ограничено;
//   • `context_overflow` — сжать и продолжить;
//   • `provider_quota_limit` и `provider_rate_limit` — не блок, а переключение
//     на следующую модель цепочки роли (основная → запасная → бесплатная);
//     блок «лимит исчерпан» только когда цепочка кончилась (это решает
//     `providerFailover.pickFailoverModel`, вернув null);
//   • `provider_auth_or_access`, `missing_config`, `model_unavailable` —
//     модель не меняем и не повторяем: сразу блок с кодом.
//
// Таблица чистая и не трогает базу: её проверяют тесты на каждый код, а
// решает по ней вызывающий (`planSubtaskAdmission.settleStalledPlanNode`,
// `inProcessRun.scheduleProviderFailover`).

import type { FailureReasonCode } from "./failureReasons.js";

/** Что сервер делает по коду, если не считать число уже сделанных повторов. */
export type FailureActionKind =
  | "retry"
  | "retry_then_switch"
  | "switch_model"
  | "compress_continue"
  | "block"
  /** Сеть: не провал роли. Повторяем, карточку не блокируем (владелец
   *  02.11.2026: «сетевые обрывы не засчитывать, пусть долбится»). */
  | "network_retry";

export type FailurePolicy = {
  kind: FailureActionKind;
  /** Потолок повторов в той же сессии до смены действия/блока. */
  maxRetries: number;
  /** Короткая подпись для ленты и тестов. */
  label: string;
};

/**
 * Таблица по каждому коду закрытого словаря. Порядок ключей совпадает с
 * `FAILURE_REASON_CODES` — тест сверяет, что ни один код не забыт.
 */
export const FAILURE_POLICIES: Record<FailureReasonCode, FailurePolicy> = {
  // Лимит частоты: сначала пара дешёвых повторов в той же сессии, потом —
  // на запасную модель цепочки (метку занятости провайдера ставит failover).
  provider_rate_limit: { kind: "retry_then_switch", maxRetries: 2, label: "повтор, затем запасная модель" },
  // Временная ошибка апстрима — повтор в той же сессии.
  provider_server_error: { kind: "retry", maxRetries: 2, label: "повтор" },
  // Обрыв сети: запрос не дошёл до провайдера и ничего не стоил. Роль не
  // виновата — повторяем щедро, карточку не блокируем (владелец 02.11.2026).
  provider_network: { kind: "network_retry", maxRetries: 12, label: "повтор (сеть)" },
  // Сборка TaskContext не уложилась в лимит — повтор.
  taskcontext_timeout: { kind: "retry", maxRetries: 1, label: "повтор" },
  // Рантайм умер / связь оборвалась — повтор.
  runtime_died: { kind: "retry", maxRetries: 2, label: "повтор" },
  // Переполнение окна — сжать контекст и продолжить, не блокировать.
  context_overflow: { kind: "compress_continue", maxRetries: 0, label: "сжать и продолжить" },
  // Квота исчерпана: модель меняем сразу, повтор бессмысленен.
  provider_quota_limit: { kind: "switch_model", maxRetries: 0, label: "запасная модель" },
  // Доступ/ключ, конфиг, отсутствие модели: сама проблема не пройдёт.
  provider_auth_or_access: { kind: "block", maxRetries: 0, label: "блок (доступ)" },
  missing_config: { kind: "block", maxRetries: 0, label: "блок (конфиг)" },
  model_unavailable: { kind: "block", maxRetries: 0, label: "блок (модель)" },
  // Отмена, застой шага и нераспознанная причина — дальше решает человек.
  cancelled: { kind: "block", maxRetries: 0, label: "блок (отменено)" },
  step_stalled: { kind: "block", maxRetries: 0, label: "блок (застой)" },
  // Пустой ответ модели (21.10.2026): ход молчал — ни текста, ни вызова
  // инструмента. Повтор в той же сессии может прийти таким же пустым,
  // поэтому ход блокируется с причиной: её видно и в ленте, и в попытке.
  empty_answer: { kind: "block", maxRetries: 0, label: "блок (пустой ответ)" },
  unknown: { kind: "block", maxRetries: 0, label: "блок (причина неизвестна)" },
};

export function failurePolicy(code: FailureReasonCode): FailurePolicy {
  return FAILURE_POLICIES[code] ?? FAILURE_POLICIES.unknown;
}

/** Немедленный блок: без повторов и без смены модели. */
export function isImmediateBlock(code: FailureReasonCode): boolean {
  return failurePolicy(code).kind === "block";
}

/** Код может повторяться в той же сессии (пока не кончится потолок). */
export function isRetryable(code: FailureReasonCode): boolean {
  const kind = failurePolicy(code).kind;
  return kind === "retry" || kind === "retry_then_switch" || kind === "network_retry";
}

/** Обрыв сети: это не сбой роли — карточку блокировать нельзя. */
export function isNetworkFailure(code: FailureReasonCode): boolean {
  return failurePolicy(code).kind === "network_retry";
}

/** Код ведёт на следующую модель цепочки. */
export function isModelSwitch(code: FailureReasonCode): boolean {
  const kind = failurePolicy(code).kind;
  return kind === "switch_model" || kind === "retry_then_switch";
}

export type FailureDecision =
  | "retry"
  | "switch_model"
  | "compress_continue"
  | "block"
  | "network_retry";

/**
 * Что делать сейчас, с учётом уже сделанных повторов. Для `retry` и
 * `retry_then_switch` при исчерпанном потолке: первый блокирует, второй
 * уходит на запасную модель (цепочку до конца доводит failover).
 */
export function decideFailureAction(code: FailureReasonCode, retriesDone = 0): FailureDecision {
  const policy = failurePolicy(code);
  switch (policy.kind) {
    case "retry":
      return retriesDone < policy.maxRetries ? "retry" : "block";
    case "network_retry":
      // Сеть: повторяем, пока не кончится потолок; дальше — не блок, а
      // «ждём сеть» (решает вызывающий: settleStalledPlanNode).
      return retriesDone < policy.maxRetries ? "network_retry" : "network_retry";
    case "retry_then_switch":
      return retriesDone < policy.maxRetries ? "retry" : "switch_model";
    case "switch_model":
      return "switch_model";
    case "compress_continue":
      return "compress_continue";
    case "block":
    default:
      return "block";
  }
}
