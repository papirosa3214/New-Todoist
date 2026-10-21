// Автопереключение провайдера при лимите (владелец 06.10.2026: «если слетели, сразу
// переключились на запасные»). Цепочка берётся из role-routing.yaml: models[роль] — основной,
// fallbacks[роль] — запасные по порядку. Упёрлись в лимит — провайдер помечается занятым
// (`provider_limits`, пять часов) и ход перезапускается на следующей модели цепочки; пока метка
// не истекла, новые запуски сразу берут первую доступную модель, а потом сами возвращаются
// на основную. Как именно метка снимается (владелец 07.10.2026):
//   • провайдер до этого РАБОТАЛ и упёрся — пять часов засекаются от этого момента, возврат
//     автоматом через 5 ч 5 мин, без прощупываний (режим timer);
//   • упёрлись сразу при старте — остаток до сброса неизвестен, метку снимает проба
//     (providerProbe.ts, режим probe).
import db from "../db.js";
import { getFailoverSettings } from "../lib/failoverSettings.js";
import { parseModelRef } from "../lib/attemptModel.js";
import { markProviderLimited, providerAvailable } from "../lib/modelLadder.js";
import type { RoleRouting } from "../roleRouting.js";

/** Сообщение об ошибке — это лимит или перегрузка провайдера, а не сбой работы. */
const PROVIDER_LIMIT_RE = /\b429\b|rate[ _-]?limit|usage limit|token plan|quota|too many requests|overloaded/i;

export function isProviderLimitText(text: unknown): boolean {
  return typeof text === "string" && PROVIDER_LIMIT_RE.test(text);
}

/**
 * Последний ответ модели закончился ошибкой лимита. Библиотека агента не бросает исключение
 * (после своих двух повторов ход просто заканчивается с `stopReason: "error"`), поэтому смотрим
 * в историю сессии. Возвращает текст ошибки или null.
 */
export function lastAssistantLimitError(session: any): string | null {
  const messages: any[] = session?.state?.messages ?? [];
  const answer = [...messages].reverse().find((m) => m?.role === "assistant");
  if (!answer || answer.stopReason !== "error") return null;
  const text = String(answer.errorMessage ?? "");
  return isProviderLimitText(text) ? text : null;
}

/**
 * Ответ модели без слов: content пустой, расход токенов 0/0, ошибки
 * провайдера нет (21.10.2026, роль critic_verifier: 13 таких ответов подряд).
 * Такой ход снаружи не виден: ошибки нет, heartbeat тикает, сторож потом
 * закрывает попытку как auto_restarted. Считаем это пустым ответом.
 *
 * Не пустой: текст, вызов инструмента (ход ещё идёт), ошибка модели и
 * отмена — у них свои пути.
 */
export function emptyAssistantAnswer(message: any): string | null {
  if (!message || message.role !== "assistant") return null;
  const stop = String(message.stopReason ?? "");
  // Ошибка модели и отмена ловятся своими путями (лимит провайдера, остановка).
  if (stop === "error" || stop === "aborted") return null;
  const content: any[] = Array.isArray(message.content) ? message.content : [];
  const hasText = content.some((part) => part?.type === "text" && String(part.text ?? "").trim().length > 0);
  const hasToolCall = content.some((part) => part?.type === "toolCall");
  if (hasText || hasToolCall) return null;
  return "модель вернула пустой ответ: ни текста, ни вызова инструмента";
}

/**
 * Последний ответ модели в сессии — пустой. Причина молчания или null,
 * если ответ был: текст, вызов инструмента или понятная ошибка.
 */
export function lastAssistantEmptyAnswer(session: any): string | null {
  const messages: any[] = session?.state?.messages ?? [];
  const answer = [...messages].reverse().find((m) => m?.role === "assistant");
  if (!answer) return null;
  return emptyAssistantAnswer(answer);
}

/** С какой модели начинать: явная, иначе первая доступная из цепочки роли. */
export function pickStartModel(routing: RoleRouting, role: string, explicit?: string | null): string {
  if (explicit) return explicit;
  const chain = [routing.models[role as keyof typeof routing.models], ...(routing.fallbacks[role as keyof typeof routing.fallbacks] ?? [])].filter(Boolean) as string[];
  const live = chain.find((m) => providerAvailable(parseModelRef(m).provider));
  return live ?? chain[0];
}

/** Сколько минут работы провайдера до лимита считаем «работал, а не упёрся сразу». */
const WORKED_MIN_MINUTES = 10;

/**
 * Провайдер до этого работал: за последние пять часов была попытка на нём, начатая не меньше
 * десяти минут назад и закончившаяся не лимитом. Попытка, упавшая на лимите сразу после старта,
 * не считается — это «упёрлись сразу».
 */
export function providerWorkedRecently(provider: string): boolean {
  const rows = db
    .prepare(
      `SELECT provider, model, reason_code, reason FROM attempts
        WHERE started_at > datetime('now', '-5 hours')
          AND started_at <= datetime('now', '-${WORKED_MIN_MINUTES} minutes')`,
    )
    .all() as { provider: string | null; model: string | null; reason_code: string | null; reason: string | null }[];
  return rows.some((r) => {
    const p = r.provider || (r.model ? parseModelRef(r.model).provider : null);
    const limited = r.reason_code === "provider_limit" || (r.reason ?? "").startsWith("provider_limit");
    return p === provider && !limited;
  });
}

/**
 * Лимит на `currentRef`: помечаем его провайдера занятым и отдаём следующую модель цепочки на
 * другом, живом провайдере. null — запасных не осталось (тогда шаг блокируется как раньше).
 */
export function pickFailoverModel(routing: RoleRouting, role: string, currentRef: string, reason: string): string | null {
  const current = parseModelRef(currentRef);
  markProviderLimited(current.provider, null, reason.slice(0, 200), providerWorkedRecently(current.provider) ? "timer" : "probe");
  // Автопереключение выключено владельцем: лимит запомнили, но на запасную не уходим — шаг встанет как раньше.
  if (!getFailoverSettings().autoSwitch) return null;
  const chain = [routing.models[role as keyof typeof routing.models], ...(routing.fallbacks[role as keyof typeof routing.fallbacks] ?? [])].filter(Boolean) as string[];
  return chain.find((m) => {
    const p = parseModelRef(m).provider;
    return p !== current.provider && providerAvailable(p);
  }) ?? null;
}
