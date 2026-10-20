/**
 * Интеграции роли: какие сервисы ей разрешены и подключены ли они.
 *
 * Источник подключения — тот же каталог Composio, что и в
 * `GET /api/roles/:role/composio` (`inspectComposio` → `session.toolkits`):
 * одна правда в двух местах чтения, своей проверки «подключён ли Todoist»
 * здесь не заводим.
 *
 * Три правила, из-за которых модуль отдельный:
 *   - каталог живёт во внешнем process (сессия Composio), поэтому ответ
 *     ждём не дольше CATALOG_TIMEOUT_MS, а по таймауту отдаём честное
 *     «состояние неизвестно», а не «не подключено»;
 *   - каталог спрашивают несколько экранов, поэтому копия живёт
 *     CACHE_TTL_MS, а параллельные вопросы ждут один вызов, а не плодят
 *     процессы;
 *   - `toolkits` в политике — это РАЗРЕШЁННЫЕ роли сервисы, а не
 *     подключённые: подключение — это `connected` из каталога.
 */
import { composioCredentialConfigured, roleComposioPolicy, type ComposioPolicy } from "./composioPolicy.js";
import { inspectComposio } from "./composioRuntime.js";

/** Один сервис в карточке роли. */
export type RoleIntegrationToolkit = {
  /** Ключ сервиса: `todoist`, `linear`. */
  slug: string;
  /** Название сервиса от Composio; null — сервера не спросили. */
  name: string | null;
  /** Подключён ли сервис у владельца; null — состояние неизвестно. */
  connected: boolean | null;
};

/** Сведения об интеграциях роли — блок `integrations` в профиле роли. */
export type RoleIntegrations = {
  /** Разрешено ли роли работать через Composio. */
  enabled: boolean;
  /** Разрешённые роли сервисы; пустой список — сервисов не разрешено. */
  toolkits: RoleIntegrationToolkit[];
  /** Известно ли состояние подключения у всех сервисов. */
  connected_known: boolean;
  /** Честная причина, если состояние неизвестно. */
  error: string | null;
};

/** Строка каталога Composio — ровно та, что отдаёт `session.toolkits`. */
export type ComposioCatalogItem = {
  slug: string;
  name: string | null;
  connected: boolean;
  noAuth: boolean;
};

/** Как долго живёт удачный ответ каталога. */
const CACHE_TTL_MS = 60_000;
/** Как долго живёт неудачный ответ: чтобы не слать запрос в каждом кадре. */
const CACHE_ERROR_TTL_MS = 15_000;
/** Сколько ждём внешний процесс, прежде чем честно сказать «не ответил». */
const CATALOG_TIMEOUT_MS = 5_000;

type CacheEntry = { at: number; items: ComposioCatalogItem[]; error: string | null };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ComposioCatalogItem[]>>();

/** Забыть копию каталога: тестам и смене ключа нужен чистый старт. */
export function clearComposioCache(): void {
  cache.clear();
  inflight.clear();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Каталог с таймаутом: внешний процесс не должен висеть в запросе.
 * Ошибку приводим к тексту — наверх идёт честная причина, а не стек.
 */
async function catalogWithTimeout(policy: ComposioPolicy, search: string): Promise<ComposioCatalogItem[]> {
  const call = inspectComposio(policy, "catalog", search).then((raw: any) => {
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items
      .map((item: any) => ({
        slug: String(item?.slug ?? ""),
        name: item?.name == null ? null : String(item.name),
        connected: !!item?.connected,
        noAuth: !!item?.noAuth,
      }))
      .filter((item: ComposioCatalogItem) => !!item.slug);
  });
  // Если выиграл таймаут, поздний отказ не должен быть «необработанным».
  call.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Composio не ответил вовремя")), CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Каталог сервисов владельца: из копии, иначе — из Composio.
 * Параллельные вопросы ждут один вызов (один внешний процесс).
 */
export async function composioCatalog(
  ownerId: string,
  search = "",
): Promise<{ items: ComposioCatalogItem[]; error: string | null }> {
  const key = `${ownerId}|${search}`;
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.error ? CACHE_ERROR_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return { items: cached.items, error: cached.error };
  }
  const pending = inflight.get(key);
  if (pending) {
    try {
      const items = await pending;
      return { items, error: null };
    } catch (error) {
      return { items: [], error: messageOf(error) };
    }
  }
  const policy: ComposioPolicy = { role: "integrations", ownerId, enabled: true, toolkits: [] };
  const call = catalogWithTimeout(policy, search);
  inflight.set(key, call);
  try {
    const items = await call;
    cache.set(key, { at: Date.now(), items, error: null });
    return { items, error: null };
  } catch (error) {
    const message = messageOf(error);
    cache.set(key, { at: Date.now(), items: [], error: message });
    return { items: [], error: message };
  } finally {
    inflight.delete(key);
  }
}

/**
 * Сведения об интеграциях роли: разрешённые сервисы и их состояние.
 *
 * `toolkits` в политике — разрешение; `connected` — из каталога. Если
 * каталог не пришёл, состояние остаётся неизвестным (null), а в `error`
 * лежит причина. «Неизвестно» и «не подключено» — разные вещи, и путать
 * их нельзя: иначе экран скажет «не подключено» при живой связи.
 */
export async function roleIntegrations(role: string, ownerId?: string): Promise<RoleIntegrations> {
  const policy = roleComposioPolicy(role, ownerId);
  const allowed = policy.toolkits;

  // Роль выключена: показываем, что ей разрешено, но состояние не важно —
  // она и так не ходит в Composio.
  if (!policy.enabled) {
    return { enabled: false, toolkits: listAllowed(allowed), connected_known: false, error: null };
  }
  if (!composioCredentialConfigured()) {
    return {
      enabled: true,
      toolkits: listAllowed(allowed),
      connected_known: false,
      error: "Ключ Composio ещё не настроен на сервере",
    };
  }

  // Весь каталог: спрашиваем один раз и показываем, что вернули.
  if (allowed === null) {
    const { items, error } = await composioCatalog(policy.ownerId, "");
    return {
      enabled: true,
      toolkits: items.map((item) => ({ slug: item.slug, name: item.name, connected: item.connected })),
      connected_known: error === null,
      error,
    };
  }

  // Выборочный список: спрашиваем каталог по каждому сервису — так
  // нужный сервис найдётся даже когда каталог длиннее первой страницы.
  const { items, error } = await resolveToolkits(policy.ownerId, allowed);
  const toolkits = allowed.map((slug) => {
    const found = items.find((item) => item.slug === slug) ?? null;
    return { slug, name: found?.name ?? null, connected: found ? found.connected : null };
  });
  const connected_known = error === null && toolkits.every((item) => item.connected !== null);
  return { enabled: true, toolkits, connected_known, error };
}

/**
 * Сервисы по их ключам, не глядя на первую страницу каталога.
 *
 * Каталог Composio постраничный (первая страница — 50 сервисов), и нужного
 * сервиса (например, todoist) в ней может не быть. Поэтому каждый ключ
 * спрашиваем отдельно: экраны настроек получают его название и состояние,
 * а не «состояние неизвестно» про подключённый сервис. Копия и таймаут —
 * те же, что у страницы каталога (`composioCatalog`).
 */
export async function resolveToolkits(
  ownerId: string,
  slugs: string[],
): Promise<{ items: ComposioCatalogItem[]; error: string | null }> {
  const answers = await Promise.all(slugs.map((slug) => composioCatalog(ownerId, slug)));
  const items: ComposioCatalogItem[] = [];
  slugs.forEach((slug, index) => {
    const found = answers[index].items.find((item) => item.slug === slug);
    if (found) items.push(found);
  });
  const error = answers.map((answer) => answer.error).find((message) => !!message) ?? null;
  return { items, error };
}

/**
 * Разрешённые роли сервисы без каталога: имена неизвестны, состояние
 * неизвестно. Так выглядит честно, когда каталог не дошёл.
 */
function listAllowed(allowed: string[] | null): RoleIntegrationToolkit[] {
  if (allowed === null) return [];
  return allowed.map((slug) => ({ slug, name: null, connected: null }));
}
