// Закрытый словарь причин сбоя запуска шага и ОДИН классификатор по тексту
// ошибки (владелец 06.10.2026, MAK-96). Образец — `bot_failure_reasons.py`
// у Гермеса: любой провал кончается кодом из короткого списка, а не свободным
// текстом, по которому нельзя принять решение.
//
// Здесь только распознавание. Что делать с кодом (повтор, смена модели, блок)
// — следующая задача проекта; этот модуль намеренно не хранит политику и
// ничего не запускает.
//
// Классификатор — единственная точка, где текст ошибки превращается в код:
// иначе разные места записи сбоя разойдутся в трактовке одного и того же 429.

export const FAILURE_REASON_CODES = [
  "provider_quota_limit",
  "provider_rate_limit",
  "provider_server_error",
  "provider_auth_or_access",
  "context_overflow",
  "missing_config",
  "taskcontext_timeout",
  "model_unavailable",
  "step_stalled",
  "runtime_died",
  "cancelled",
  "unknown",
] as const;

export type FailureReasonCode = (typeof FAILURE_REASON_CODES)[number];

/** Человеческая подпись кода — для ленты и сводок. */
export const FAILURE_REASON_LABELS: Record<FailureReasonCode, string> = {
  provider_quota_limit: "исчерпана квота провайдера",
  provider_rate_limit: "лимит частоты провайдера",
  provider_server_error: "ошибка на стороне провайдера",
  provider_auth_or_access: "нет доступа к провайдеру (ключ/права)",
  context_overflow: "переполнение контекста",
  missing_config: "не настроено (конфиг провайдера/маршрутизации)",
  taskcontext_timeout: "сборка TaskContext превысила лимит времени",
  model_unavailable: "модель недоступна",
  step_stalled: "ход шага закончился без сдачи",
  runtime_died: "рантайм умер / оборвалась связь",
  cancelled: "запуск отменён",
  unknown: "причина не распознана",
};

export function failureReasonLabel(code: FailureReasonCode): string {
  return FAILURE_REASON_LABELS[code] ?? FAILURE_REASON_LABELS.unknown;
}

export function isFailureReasonCode(value: unknown): value is FailureReasonCode {
  return typeof value === "string" && (FAILURE_REASON_CODES as readonly string[]).includes(value);
}

type Rule = { code: FailureReasonCode; re: RegExp };

// Порядок важен: более специфичные шаблоны выше общих. `TaskContext … 15
// секунд` — это таймаут моста, а не переполнение контекста модели; строка
// `fallbacks.builder должен быть списком строк` — конфиг, а не «недоступная
// модель». 429 с телом `insufficient_quota` — это квота, а не частота,
// поэтому квота проверяется раньше частоты.
const RULES: Rule[] = [
  // «сборка TaskContext v1 превысила 15 секунд» (taskContextBridge.ts).
  { code: "taskcontext_timeout", re: /taskcontext|task context[^\n]*превыс|сборка taskcontext/i },
  // «fallbacks.builder должен быть списком строк», «role-routing.yaml».
  { code: "missing_config", re: /role[-_ ]?routing|fallbacks?\.\w|должен быть списком|missing config|not configured|not configurated|конфиг/i },
  // 401/403 и явные слова про доступ/ключ.
  { code: "provider_auth_or_access", re: /\b(401|403)\b|unauthorized|forbidden|invalid api key|api key[^\n]*(invalid|missing)|authentication failed|permission denied|access denied|нет доступа|доступ запрещ/i },
  // Квота/оплата: 402 и явные маркеры биллинга.
  { code: "provider_quota_limit", re: /insufficient_quota|quota|billing|payment required|\b402\b|exceeded your current|credit balance/i },
  // Частота/перегрузка: 429, rate limit, «слишком много запросов».
  { code: "provider_rate_limit", re: /\b429\b|rate[ _-]?limit|provider[ _-]?limit|лимит провайдера|too many requests|overloaded|usage limit|token plan|превышен лимит запросов/i },
  // 5xx и явные серверные ошибки апстрима.
  { code: "provider_server_error", re: /\b5\d{2}\b|server error|internal error|bad gateway|service unavailable|upstream[^\n]*error|провайдер[^\n]*ошибк/i },
  // Модели нет в каталоге/она отключена.
  { code: "model_unavailable", re: /model[_ ]?not[_ ]?available|no such model|unknown model|model[^\n]*not found|модель[^\n]*недоступ|(openai\/|anthropic\/|claude-|gpt-)[^\n]*недоступ|недоступна модель|модель[^\n]*не найдена/i },
  // Переполнение окна контекста модели.
  { code: "context_overflow", re: /context[_ ]?(overflow|length_exceeded|length|window)|context_length_exceeded|maximum context|переполнени[ея] контекста|too many tokens|prompt is too long|exceeds?[^\n]*tokens|token limit/i },
  // Отмена/остановка владельцем или системой.
  { code: "cancelled", re: /cancel|aborted|\babort\b|прерван|отменен|отменён|остановлен владельц/i },
  // Ход шага кончился без сдачи: застой, тишина, лимит продолжений.
  { code: "step_stalled", re: /stalled|ход закончился без сдачи|тишина \d+ мин|без движения|лимит продолжений|шаг заблокирован|заблокирован владельц/i },
  // Рантайм умер, связь оборвалась, процесс перезапустился.
  { code: "runtime_died", re: /runtime[_ ]?(died|unavailable|is unavailable)|econnreset|socket hang up|econnrefused|connection refused|process exited|out of memory|\boom\b|killed|перезапуск[а-я]* сервер|сервер[^\n]*перезапуст|перезапустил|ход оборвался|рантайм[^\n]*(умер|недоступ)/i },
];

/** Один классификатор: текст ошибки → код из закрытого списка. */
export function classifyFailureReason(text: unknown): FailureReasonCode {
  if (typeof text !== "string" || !text.trim()) return "unknown";
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.code;
  }
  return "unknown";
}

/** Классификатор для Error/строки/чего угодно на границе. */
export function classifyFailure(error: unknown): FailureReasonCode {
  if (error instanceof Error) return classifyFailureReason(error.message || error.name);
  return classifyFailureReason(error);
}
