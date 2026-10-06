/**
 * Тип блокировки и признак «меняет результат карточки» (MAK-98).
 *
 * Раньше роль уходила в `blocked` без различия причин: «dependency»
 * (ждёт другой шаг и снимется сама), «needs_input» (нужно решение),
 * «capability» (нет нужной компетенции) и «transient» (временное) в ленте
 * выглядели одинаково. Автоматика не могла решить, что делать: снять блок
 * при готовности зависимости, позвать владельца, поднять другую роль или
 * просто повторить. Здесь — закрытый список типов и ЧИСТЫЕ функции без
 * обращения к БД, чтобы одну и ту же трактовку делили `/state`, `/work`
 * и тесты.
 *
 * Legacy-значения `technical`/`wrong_role`/`dead` (планировщик, шаг 2
 * конвейера) остаются допустимыми: их пишет серверная автоматика, и
 * ломать принятое в MAK-90 нельзя.
 */

/** Четыре типа, которые ставит роль при осмысленном блоке. */
export const ROLE_BLOCK_TYPES = [
  "dependency",
  "needs_input",
  "capability",
  "transient",
] as const;

export type RoleBlockType = (typeof ROLE_BLOCK_TYPES)[number];

/** Служебные типы автоматики (планировщик, конвейер) — как было. */
export const SERVICE_BLOCK_TYPES = ["technical", "wrong_role", "dead"] as const;

export const ALL_BLOCK_TYPES = [
  ...ROLE_BLOCK_TYPES,
  ...SERVICE_BLOCK_TYPES,
] as const;

export type BlockType = (typeof ALL_BLOCK_TYPES)[number];

const LABELS: Record<BlockType, string> = {
  dependency: "ждёт другую работу и снимется сама",
  needs_input: "нужно решение",
  capability: "нет нужной компетенции",
  transient: "временная помеха",
  technical: "технический сбой",
  wrong_role: "не та роль",
  dead: "тупик",
};

export function blockTypeLabel(value: string | null | undefined): string {
  return value && value in LABELS ? LABELS[value as BlockType] : "не указан";
}

export function isBlockType(value: unknown): value is BlockType {
  return (
    typeof value === "string" &&
    (ALL_BLOCK_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Какой тип блока соответствует структурированному коду остановки
 * (`stopReasons.ts`). Нужно для `/stop` и старых клиентов, которые шлют
 * только `reason_code`: сервер выводит тип сам, а не отвергает запрос.
 */
export function blockTypeFromReasonCode(
  reasonCode: string | null | undefined,
): RoleBlockType | null {
  switch (reasonCode) {
    case "insufficient_capability":
    case "different_competence":
      return "capability";
    case "permission_or_owner":
    case "result_feedback":
      return "needs_input";
    case "provider_limit":
    case "technical_failure":
    case "lease_expired":
    case "budget_exhausted":
      return "transient";
    default:
      return null;
  }
}

/**
 * Кому адресован сигнал от блока:
 *   • `needs_input` с признаком «меняет результат карточки» — владельцу
 *     (затрагивает «Результат», «Критерии приёмки» или «Границы»);
 *   • остальные осмысленные блоки — оркестратору;
 *   • `dependency`/`transient` — никому: они снимаются сами
 *     (готовностью зависимости / повторным запуском).
 */
export function blockSignalTarget(
  blockType: string | null | undefined,
  changesResult: boolean,
): "owner" | "orchestrator" | null {
  if (blockType === "needs_input") {
    return changesResult ? "owner" : "orchestrator";
  }
  if (blockType === "capability") return "orchestrator";
  return null;
}

export type BlockedTypeDecision =
  | { ok: true; blockType: string }
  | { ok: false; error: string; hint: string };

/**
 * Проверка перехода в blocked: тип обязателен (явный или выведенный из
 * `reason_code`), причина — непустой текст. Возвращает решение, а не
 * бросает: одна проверка на все входы (задача, шаг, /stop).
 */
export function evaluateBlockedType(input: {
  blockType?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
}): BlockedTypeDecision {
  const explicit = (input.blockType ?? "").trim();
  if (explicit && !isBlockType(explicit)) {
    return {
      ok: false,
      error: `неизвестный block_type «${explicit}»`,
      hint: `допустимо: ${ROLE_BLOCK_TYPES.join(", ")}`,
    };
  }
  const resolved =
    explicit || blockTypeFromReasonCode(input.reasonCode ?? null) || "";
  if (!resolved) {
    return {
      ok: false,
      error:
        "blocked принимается только с типом: объясни, ПОЧЕМУ стоишь — " +
        "dependency (ждёт другой шаг), needs_input (нужно решение), " +
        "capability (нет компетенции), transient (временное).",
      hint: "передай block_type вместе со state=blocked",
    };
  }
  if (!((input.reason ?? "").trim())) {
    return {
      ok: false,
      error:
        "blocked принимается только с причиной: что мешает и чего ждёшь",
      hint: "передай comment (задача) или result (шаг)",
    };
  }
  return { ok: true, blockType: resolved };
}
