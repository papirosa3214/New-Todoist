// Живой каталог моделей шлюзов OpenCode.
//
// Каталог models.dev (его отдаёт Pi SDK) содержит модели, которые шлюзы уже
// не обслуживают. Выбор такой модели в приложении даёт ошибку провайдера:
// 04.11.2026 в `opencode` так вёл себя mimo-v2.5-free / space-bunny-free /
// cat-jam-free (`400 Model is unavailable`), 06.11.2026 в `opencode-go` —
// mimo-v2.5 и mimo-v2.5-pro (`410 ModelDeprecated`, шлюз советует
// mimo-v2.6-*). Владелец 06.11.2026: «в списке модели, которые не работают,
// список не обновляется».
//
// Поэтому список моделей каждого шлюза сверяется с его живым каталогом.
// Ответ кэшируется на час: приложение не дёргает шлюз на каждый показ
// списка, а отозванная модель исчезает из выбора в пределах часа, без
// перезапуска сервера.
const CATALOG_URLS = {
  opencode: "https://opencode.ai/zen/v1/models",
  "opencode-go": "https://opencode.ai/inference/go/v1/models",
} as const;

export type LiveGateway = keyof typeof CATALOG_URLS;

const TTL_MS = 60 * 60 * 1000;

const cache = new Map<LiveGateway, { at: number; ids: Set<string> }>();

function isLiveGateway(provider: string): provider is LiveGateway {
  return Object.hasOwn(CATALOG_URLS, provider);
}

/** Модели, которые шлюз реально обслуживает. null — узнать не удалось. */
async function gatewayModelIds(gateway: LiveGateway, now: number): Promise<Set<string> | null> {
  const hit = cache.get(gateway);
  if (hit && now - hit.at < TTL_MS) return hit.ids;
  try {
    const res = await fetch(CATALOG_URLS[gateway], {
      headers: { "user-agent": "taskflow-server" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return hit?.ids ?? null;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = new Set<string>();
    for (const m of body.data ?? []) {
      if (typeof m?.id === "string" && m.id) ids.add(m.id);
    }
    // Пустой ответ — не повод выкидывать весь список моделей провайдера.
    if (ids.size === 0) return hit?.ids ?? null;
    cache.set(gateway, { at: now, ids });
    return ids;
  } catch {
    // Сеть или шлюз недоступны: отдаём прошлый снимок, а если его нет —
    // не режем список вовсе. Пусть лучше ошибка будет по конкретной модели,
    // чем пустой экран выбора моделей.
    return hit?.ids ?? null;
  }
}

/**
 * Живые каталоги всех шлюзов сразу.
 *
 * Отсутствие провайдера в результате означает «каталог узнать не удалось» —
 * его модели не фильтруются.
 */
export async function liveGatewayModelIds(
  now = Date.now(),
): Promise<Map<LiveGateway, Set<string>>> {
  const gateways = Object.keys(CATALOG_URLS) as LiveGateway[];
  const resolved = await Promise.all(
    gateways.map(async (gateway) => [gateway, await gatewayModelIds(gateway, now)] as const),
  );
  const out = new Map<LiveGateway, Set<string>>();
  for (const [gateway, ids] of resolved) {
    if (ids) out.set(gateway, ids);
  }
  return out;
}

/** Отбрасывает модели шлюзов, которых в живом каталоге нет. */
export function filterByLiveCatalog<T extends { id: string; provider: string }>(
  models: T[],
  live: Map<LiveGateway, Set<string>>,
): T[] {
  if (live.size === 0) return models;
  return models.filter((m) => {
    if (!isLiveGateway(m.provider)) return true;
    const ids = live.get(m.provider);
    return !ids || ids.has(m.id);
  });
}

/** Сброс кэша — тестам. */
export function _resetLiveCatalogForTests(): void {
  cache.clear();
}
