import db from "./db.js";

// «Сначала проверка Reviewer» — ОБЩИЙ рубильник владельца, читается ЖИВЬЁМ
// в момент решения. Ничего не «запекается» в карточку: включён — через
// Reviewer идут все карточки (старые и новые), выключен — ни одна.
//
// Раньше это был флаг на каждой карточке (`tasks.requires_reviewer_review`),
// выставленный при создании. Владелец 19.09.2026: «мне надо, чтобы решалось
// в моменте: включён — все карточки идут через него; выключен — не идут».
// Колонка осталась для совместимости, но решения больше по ней не принимаются.
//
// Короткий кэш (2 с) — только чтобы список задач не делал по одному SELECT
// на каждую строку. На «в моменте» это не влияет.

let cached: { value: boolean; at: number } | null = null;

export function reviewerFirstEnabled(): boolean {
  const now = Date.now();
  if (cached && now - cached.at < 2000) return cached.value;

  let value = false;
  try {
    const owner = db
      .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
      .get() as { id?: string } | undefined;
    if (owner?.id) {
      const row = db
        .prepare("SELECT reviewer_first_default FROM users WHERE id = ?")
        .get(owner.id) as { reviewer_first_default?: number } | undefined;
      value = (row?.reviewer_first_default ?? 1) === 1;
    }
  } catch {
    // Колонки ещё нет (БД до миграции) — считаем как раньше, включённой.
    value = true;
  }

  cached = { value, at: now };
  return value;
}
