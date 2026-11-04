// Живой каталог моделей OpenCode Zen.
//
// Каталог models.dev (его отдаёт Pi SDK) для провайдера `opencode` содержит
// модели, которые шлюз уже не обслуживает: mimo-v2.5-free, space-bunny-free,
// cat-jam-free. Выбор такой модели в приложении даёт от шлюза
// `400 Upstream request failed: Model is unavailable` (проверено 04.11.2026
// по логу сервера и по живому /zen/v1/models: 80 моделей против 132 в каталоге).
//
// Поэтому список моделей провайдера `opencode` сверяется с живым каталогом
// шлюза. Ответ кэшируется на 6 часов: приложение не дёргает шлюз на каждый
// показ списка, а сам список обновляется без перезапуска сервера.
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const TTL_MS = 6 * 60 * 60 * 1000;

let cache: { at: number; ids: Set<string> } | null = null;

/** Модели, которые шлюз реально обслуживает. null — узнать не удалось. */
export async function zenModelIds(now = Date.now()): Promise<Set<string> | null> {
  if (cache && now - cache.at < TTL_MS) return cache.ids;
  try {
    const res = await fetch(ZEN_MODELS_URL, {
      headers: { "user-agent": "taskflow-server" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return cache?.ids ?? null;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = new Set<string>();
    for (const m of body.data ?? []) {
      if (typeof m?.id === "string" && m.id) ids.add(m.id);
    }
    // Пустой ответ — не повод выкидывать весь список моделей провайдера.
    if (ids.size === 0) return cache?.ids ?? null;
    cache = { at: now, ids };
    return ids;
  } catch {
    // Сеть или шлюз недоступны: отдаём прошлый снимок, а если его нет —
    // не режем список вовсе. Пусть лучше ошибка будет по конкретной модели,
    // чем пустой экран выбора моделей.
    return cache?.ids ?? null;
  }
}

/** Отбрасывает модели `opencode`, которых шлюз не обслуживает. */
export function filterByZenCatalog<T extends { id: string; provider: string }>(
  models: T[],
  ids: Set<string> | null,
): T[] {
  if (!ids) return models;
  return models.filter((m) => m.provider !== "opencode" || ids.has(m.id));
}

/** Сброс кэша — тестам. */
export function _resetZenCatalogForTests(): void {
  cache = null;
}
