// Каталог моделей для моков Pi SDK собирается из боевого
// scripts/role-routing.yaml — того же файла, который сервер читает на
// машине. Раньше в фейковых каталогах было жёстко вписано «MiniMax-M3»,
// и любая смена основной модели ролей (13.10.2026, f982c835 —
// MiniMax-M3.1-Flash-Preview) валила 38 тестов чатов и маршрутизации с
// model_not_available: подделки не знали про новую модель. Тесты проверяют
// механику хода роли, а не выбор модели, поэтому каталог должен содержать
// ровно те модели, на которые ссылается роутинг.
import path from "path";
import { loadRoleRouting, providerOfModel } from "../../src/roleRouting.js";

export interface FakeModel {
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
}

export interface FakeProvider {
  id: string;
  name: string;
  auth: { apiKey: Record<string, never>; oauth: Record<string, never> };
}

const LIVE_ROUTING = loadRoleRouting(
  path.resolve(__dirname, "../../scripts/role-routing.yaml"),
);

/** Основная модель роли по боевому role-routing.yaml. */
export function liveModelOf(role: string): string {
  const model = LIVE_ROUTING.models[role];
  if (!model) {
    throw new Error(
      `liveRoutingModels: у роли «${role}» нет основной модели в scripts/role-routing.yaml`,
    );
  }
  return model;
}

/** Запись каталога Pi для основной модели роли (id + провайдер). */
export function liveCatalogEntryOf(role: string): FakeModel {
  return catalogEntry(liveModelOf(role));
}

/** Каталог для мока: основные модели всех ролей и их запасные цепочки. */
export function liveRoutingCatalog(): FakeModel[] {
  const ids = new Set<string>();
  for (const model of Object.values(LIVE_ROUTING.models)) ids.add(model);
  for (const chain of Object.values(LIVE_ROUTING.fallbacks)) {
    for (const model of chain) ids.add(model);
  }
  return [...ids].map(catalogEntry);
}

/** Провайдеры каталога — ответы getProviders()/getProvider() в моке SDK. */
export function liveRoutingProviders(): FakeProvider[] {
  const byId = new Map<string, FakeProvider>();
  for (const model of liveRoutingCatalog()) {
    if (byId.has(model.provider)) continue;
    byId.set(model.provider, {
      id: model.provider,
      name: model.provider,
      auth: { apiKey: {}, oauth: {} },
    });
  }
  return [...byId.values()];
}

// Провайдер модели: «opencode-go/deepseek-…» — уже задан префиксом,
// остальное угадывается по имени (та же эвристика, что в src).
// Как в настоящем каталоге Pi: префикс — это провайдер, а id модели — без
// него («opencode/deepseek-…» лежит как provider «opencode» + id «deepseek-…»).
function catalogEntry(model: string): FakeModel {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : providerOfModel(model);
  return {
    id: slash > 0 ? model.slice(slash + 1) : model,
    provider,
    name: model,
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ["text"],
  };
}
