import db from "../db.js";

// Ступени эскалации моделей (карточка f8e8a055, проект dca29510).
//
// Модель хранится в `model_ladder` ступенями; на каждой ступени по две
// учётки-провайдера (anthropic | openai-codex), ступень 0 — MiniMax-M3.
//
// Два правила движения:
//   • не потянул по существу (`insufficient_capability`) — ВВЕРХ на ступень;
//   • упёрся в лимит (`provider_limit`) — ВБОК, в соседнюю учётку той же
//     ступени (лимит выедается на УЧЁТКУ целиком, поэтому вверх по лимиту
//     не идём — это дороже).
//
// Состояние лимитов — `provider_limits`, по провайдеру, не по модели.

export type LadderEntry = {
  step: number;
  provider: string;
  model: string;
  priority: number;
};

export function ladderEntryForModel(model: string | null): LadderEntry | null {
  if (!model) return null;
  return (
    (db
      .prepare(
        "SELECT step, provider, model, priority FROM model_ladder WHERE model = ?",
      )
      .get(model) as LadderEntry | undefined) ?? null
  );
}

/** Провайдер не в лимите: в provider_limits нет неистёкшей пометки. */
export function providerAvailable(provider: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM provider_limits
        WHERE provider = ? AND unavailable_until IS NOT NULL
          AND unavailable_until > datetime('now')`,
    )
    .get(provider);
  return !row;
}

/** Пометить учётку недоступной до восстановления лимита. */
export function markProviderLimited(
  provider: string,
  windowKind: string | null,
  reason: string | null,
): void {
  // Тип окна пока не разобран (фаза 4) — консервативно берём пятичасовое,
  // недельное ставим только если оно уже известно.
  const until = windowKind === "weekly" ? "+7 days" : "+5 hours";
  db.prepare(
    `INSERT INTO provider_limits (provider, unavailable_until, window_kind, reason, updated_at)
     VALUES (?, datetime('now', ?), ?, ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET
       unavailable_until = excluded.unavailable_until,
       window_kind = excluded.window_kind,
       reason = excluded.reason,
       updated_at = datetime('now')`,
  ).run(provider, until, windowKind, reason);
}

/** Куда уходить с текущей модели при такой причине. null — двигаться некуда
 *  (незнакомая модель или нет живой учётки), тогда задача встанет в блок. */
export function nextModelForFailure(
  currentModel: string | null,
  reasonCode: string,
): LadderEntry | null {
  const cur = ladderEntryForModel(currentModel);
  if (!cur) return null;
  const rows = db
    .prepare("SELECT step, provider, model, priority FROM model_ladder ORDER BY step, priority")
    .all() as LadderEntry[];

  const upFrom = (from: number): LadderEntry | null =>
    rows
      .filter((r) => r.step > from)
      .sort((a, b) => a.step - b.step || a.priority - b.priority)
      .find((r) => providerAvailable(r.provider)) ?? null;

  if (reasonCode === "provider_limit") {
    // Вбок — в соседнюю учётку той же ступени, если она есть и жива.
    const sideways = rows.find(
      (r) =>
        r.step === cur.step &&
        r.provider !== cur.provider &&
        providerAvailable(r.provider),
    );
    if (sideways) return sideways;
    // Ступень одиночная (как 0, один MiniMax) или сосед выбит — уходим ВВЕРХ
    // (решение владельца 16.09.2026: M2.7 не запасной, со ступени 0 при
    // лимите идём на ступень 1).
    return upFrom(cur.step);
  }
  if (reasonCode === "insufficient_capability") {
    return upFrom(cur.step);
  }
  return null;
}
