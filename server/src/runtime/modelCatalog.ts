// Провайдер-qualified модели (карточка e11eae7a, пункт 1 контракта).
//
// Правило: модель в каталоге Pi — это пара (провайдер, id). Одни и те же
// имена бывают у разных провайдеров (deepseek-v4.1-flash есть и у
// opencode-go, и у minimax), поэтому наружу модель отдаётся только как
// «провайдер/модель», а явный выбор «провайдер/модель» НЕ подменяется
// моделью с тем же именем у другого провайдера. Голый id (обратная
// совместимость) работает как раньше: ищем по имени, при равенстве имён
// предпочитаем провайдера роли.
import { KNOWN_MODEL_PROVIDERS, parseModelRef } from "../lib/attemptModel.js";
import { providerOfModel } from "../roleRouting.js";

export type CatalogModel = {
  id: string;
  provider: string;
  name?: string | null;
  contextWindow?: number | null;
  available?: boolean;
};

/** «провайдер/модель» — единственный однозначный вид модели в каталоге. */
export function qualifiedModelId(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Модель из маршрутизации приводим к виду «провайдер/модель». */
export function qualifyModelRef(model: string | null | undefined): string | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return null;
  const ref = parseModelRef(trimmed);
  if (!ref.id) return null;
  // Уже квалифицированная запись известного провайдера — не разворачиваем.
  if (ref.provider && ref.id !== trimmed) return qualifiedModelId(ref.provider, ref.id);
  return qualifiedModelId(providerOfModel(trimmed), trimmed);
}

/** Явная запись «провайдер/модель» (любой префикс, не только известный). */
export function isQualifiedModelRef(ref: string): boolean {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && !!trimmed.slice(slash + 1);
}

/**
 * Поиск модели в каталоге Pi.
 *
 * Явный выбор «провайдер/модель» ищется строго: та же модель другого
 * провайдера не подставляется (неизвестный вызов — отсутствие совпадения,
 * а не тихая замена). Голый id ищется как раньше, при равенстве имён
 * предпочитается провайдер роли.
 */
export function resolveCatalogModel(
  catalog: CatalogModel[],
  requested: string | null | undefined,
  preferProvider?: string | null,
): CatalogModel | null {
  const trimmed = (requested ?? "").trim();
  if (!trimmed) return null;
  if (isQualifiedModelRef(trimmed)) {
    const slash = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    const exact = catalog.find((m) => m.provider === provider && m.id === id);
    if (exact) return exact;
    // Известный провайдер, но модели с таким именем у него нет — подмены нет.
    if ((KNOWN_MODEL_PROVIDERS as readonly string[]).includes(provider)) return null;
    return null;
  }
  if (preferProvider) {
    const preferred = catalog.find((m) => m.id === trimmed && m.provider === preferProvider);
    if (preferred) return preferred;
  }
  return catalog.find((m) => m.id === trimmed) ?? null;
}

/** Каталог роли для клиента: модели не сливаются между провайдерами. */
export function roleModelOptions(
  catalog: CatalogModel[],
): Array<{ id: string; title: string; provider: string; modelID: string; contextWindow?: number }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string; provider: string; modelID: string; contextWindow?: number }> = [];
  for (const model of catalog) {
    if (model.available === false) continue;
    const id = qualifiedModelId(model.provider, model.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const entry: { id: string; title: string; provider: string; modelID: string; contextWindow?: number } = {
      id,
      title: model.name ?? model.id,
      provider: model.provider,
      modelID: model.id,
    };
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
      entry.contextWindow = model.contextWindow;
    }
    out.push(entry);
  }
  return out;
}
