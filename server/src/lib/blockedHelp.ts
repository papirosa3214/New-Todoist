/**
 * ПРОВЕРКА «ПЕРЕД BLOCKED ПОЗОВИ ПОМОЩЬ» (карточка cd10bf34).
 *
 * Сейчас роли в role-prompts/*.md только советуют звать помощь, и по факту
 * никто не зовёт: агент сразу ставит `blocked` и сам себе создаёт тупик.
 * Здесь вызов помощи становится частью самого пути к блокировке: сервер не
 * принимает `blocked` от агента, пока тот не скажет, кого звал и что
 * ответили (`help_attempt`), либо почему никто не решит (`help_skip_reason`).
 *
 * Исключение — блокировки, которые агент не может снять никакой помощью:
 * «нужен ответ владельца», права/доступ, секреты, внешние лимиты, бюджет,
 * технический сбой. Они проходят без нового поля, как раньше.
 *
 * Решение — ЧИСТАЯ функция без обращения к БД: её одинаково спрашивают
 * POST /api/tasks/:id/state, POST /api/tasks/:id/stop и
 * POST /api/subtasks/:id/work, и одна и та же проверка покрыта тестами.
 * Список кандидатов для подсказки берётся из живого реестра ролей
 * (`ROLE_NAMES`), а не из текста промптов.
 */
import { ROLE_NAMES } from "../roleRouting.js";

/** Поля, которыми агент отчитывается о вызове помощи (или его отсутствии). */
export const HELP_ATTEMPT_FIELD = "help_attempt";
export const HELP_SKIP_REASON_FIELD = "help_skip_reason";

export type BlockedHelpKind = "help_requested" | "blocked_without_help_call";

export type BlockedHelpDecision =
  | { ok: true; kind: BlockedHelpKind; detail: string | null }
  | { ok: false; error: string; hint: string; candidates: string[] };

/**
 * Причины остановки, при которых звать коллегу/модель бессмысленно.
 * Совпадают по смыслу с исключениями карточки: решения/доступ/секрет,
 * внешняя среда и бюджет — это не то, что снимет другая роль.
 * `insufficient_capability` — тоже серверный путь: /stop возвращает
 * next_attempt_template, и лесенка моделей сама поднимает ступень
 * (retry). Гейт не должен стоять поперёк этого механизма.
 */
const EXEMPT_REASON_CODES = new Set([
  "permission_or_owner",
  "provider_limit",
  "budget_exhausted",
  "lease_expired",
  "technical_failure",
  "result_feedback",
  "insufficient_capability",
]);

/**
 * Маркеры «это не решается другим агентом» в свободном тексте блокировки.
 * Нужны потому, что старые клиенты и тесты ставят `blocked` без
 * `reason_code`, а объяснение пишут в комментарии/result. Список намеренно
 * узкий и в нижнем регистре.
 */
const OWNER_OR_ENV_MARKERS = [
  // владелец / решение человека
  "владел",
  "owner",
  "ждёт решени",
  "ждет решени",
  "требуется решение",
  "решения владельца",
  // доступ / права
  "доступ",
  "access",
  "нет прав",
  "нужны права",
  "права доступа",
  "permission",
  // секреты
  "секрет",
  "secret",
  "токен",
  "token",
  "пароль",
  "password",
  "credential",
  "api-ключ",
  "ssh-ключ",
  "ключ доступа",
  // внешняя среда / бюджет
  "внешн",
  "external",
  "бюджет",
  "budget",
  "лимит средств",
  "оплат",
  "деньг",
];

/** Правда ли, что блокировка относится к «владелец/доступ/секрет/среда». */
export function isOwnerOrEnvBlock(
  reasonCode: string | null | undefined,
  text: string | null | undefined,
): boolean {
  if (reasonCode && EXEMPT_REASON_CODES.has(reasonCode)) return true;
  const t = (text ?? "").toLowerCase();
  if (!t) return false;
  return OWNER_OR_ENV_MARKERS.some((m) => t.includes(m));
}

/**
 * Кандидаты, которых подсказываем агенту. Роли из живого реестра минус
 * собственная роль вызывающего; пустой реестр — общий набор.
 */
export function helpCandidates(roleKey: string | null | undefined): string[] {
  const list = ROLE_NAMES.filter((r) => r !== roleKey);
  if (list.length) return list;
  return ["architect", "critic_verifier", "qa"];
}

const GATE_ERROR =
  "нельзя уйти в blocked, не попробовав позвать помощь. Сначала реши, " +
  "может ли препятствие снять другая роль или более сильная модель: " +
  "позови коллегу (taskflow_topic_send, kind=совещание) или возьми второе " +
  "мнение (taskflow_consult). Если помощь невозможна, объясни почему. " +
  "В запросе на blocked приложи help_attempt — «кого звал и что ответили», " +
  "либо help_skip_reason — «почему никто не решит». Блокировки «нужен " +
  "ответ владельца / доступ / секрет» проходят без этого шага.";

/**
 * Решение по блокировке агента. `text` — свободное объяснение (комментарий
 * или result шага), `helpAttempt`/`helpSkipReason` — поля запроса.
 */
export function evaluateBlockedHelp(input: {
  reasonCode?: string | null;
  text?: string | null;
  helpAttempt?: string | null;
  helpSkipReason?: string | null;
  roleKey?: string | null;
}): BlockedHelpDecision {
  const attempt = (input.helpAttempt ?? "").trim();
  if (attempt) {
    return { ok: true, kind: "help_requested", detail: attempt.slice(0, 400) };
  }
  const skip = (input.helpSkipReason ?? "").trim();
  if (skip) {
    return {
      ok: true,
      kind: "blocked_without_help_call",
      detail: skip.slice(0, 400),
    };
  }
  if (isOwnerOrEnvBlock(input.reasonCode ?? null, input.text ?? null)) {
    // Проходит как раньше, но факт «заблокирован без вызова помощи» в ленту
    // пишем — он нужен для статистики (п. 3 карточки).
    return { ok: true, kind: "blocked_without_help_call", detail: null };
  }
  const candidates = helpCandidates(input.roleKey ?? null);
  return {
    ok: false,
    error: GATE_ERROR,
    hint:
      "Кого позвать: " +
      candidates.slice(0, 8).join(", ") +
      ". Если они не помогут — taskflow_consult (старшая модель).",
    candidates,
  };
}

/** Тело ошибки 409 для клиента: причина, подсказка и список кандидатов. */
export function blockedHelpError(decision: Extract<BlockedHelpDecision, { ok: false }>) {
  return { error: decision.error, hint: decision.hint, candidates: decision.candidates };
}
