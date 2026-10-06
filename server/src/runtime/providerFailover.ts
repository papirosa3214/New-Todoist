// Автопереключение провайдера при лимите (владелец 06.10.2026: «если слетели, сразу
// переключились на запасные»). Цепочка берётся из role-routing.yaml: models[роль] — основной,
// fallbacks[роль] — запасные по порядку. Упёрлись в лимит — провайдер помечается занятым
// (`provider_limits`, пять часов) и ход перезапускается на следующей модели цепочки; пока метка
// не истекла, новые запуски сразу берут первую доступную модель, а потом сами возвращаются
// на основную.
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

/** С какой модели начинать: явная, иначе первая доступная из цепочки роли. */
export function pickStartModel(routing: RoleRouting, role: string, explicit?: string | null): string {
  if (explicit) return explicit;
  const chain = [routing.models[role as keyof typeof routing.models], ...(routing.fallbacks[role as keyof typeof routing.fallbacks] ?? [])].filter(Boolean) as string[];
  const live = chain.find((m) => providerAvailable(parseModelRef(m).provider));
  return live ?? chain[0];
}

/**
 * Лимит на `currentRef`: помечаем его провайдера занятым и отдаём следующую модель цепочки на
 * другом, живом провайдере. null — запасных не осталось (тогда шаг блокируется как раньше).
 */
export function pickFailoverModel(routing: RoleRouting, role: string, currentRef: string, reason: string): string | null {
  const current = parseModelRef(currentRef);
  markProviderLimited(current.provider, null, reason.slice(0, 200));
  const chain = [routing.models[role as keyof typeof routing.models], ...(routing.fallbacks[role as keyof typeof routing.fallbacks] ?? [])].filter(Boolean) as string[];
  return chain.find((m) => {
    const p = parseModelRef(m).provider;
    return p !== current.provider && providerAvailable(p);
  }) ?? null;
}
