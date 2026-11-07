import {it, expect} from "vitest";
import {filterByLiveCatalog} from "../src/lib/liveModelCatalog.js";

// 04.11.2026: models.dev держит в провайдере opencode модели, которых шлюз
// Zen уже не обслуживает (mimo-v2.5-free, space-bunny-free, cat-jam-free).
// 06.11.2026: то же в провайдере opencode-go — mimo-v2.5 и mimo-v2.5-pro
// отдают 410 ModelDeprecated, а в выборе модели они продолжали висеть.
// Выбор такой модели в приложении давал ошибку провайдера.
const models = [
  {id: "mimo-v2.5-free", provider: "opencode"},
  {id: "beam-free", provider: "opencode"},
  {id: "mimo-v2.5", provider: "opencode-go"},
  {id: "mimo-v2.6-flash", provider: "opencode-go"},
  {id: "gpt-5.2", provider: "openai"},
];

it("выкидывает модели opencode, которых нет в живом каталоге Zen", () => {
  const out = filterByLiveCatalog(models, new Map([["opencode", new Set(["beam-free"])]]));
  expect(out.map((m) => m.id)).toEqual([
    "beam-free",
    "mimo-v2.5",
    "mimo-v2.6-flash",
    "gpt-5.2",
  ]);
});

it("выкидывает отозванные модели opencode-go", () => {
  const out = filterByLiveCatalog(
    models,
    new Map([["opencode-go", new Set(["mimo-v2.6-flash"])]]),
  );
  expect(out.map((m) => m.id)).toEqual([
    "mimo-v2.5-free",
    "beam-free",
    "mimo-v2.6-flash",
    "gpt-5.2",
  ]);
});

it("фильтрует оба шлюза сразу и не трогает чужих провайдеров", () => {
  const out = filterByLiveCatalog(
    models,
    new Map([
      ["opencode", new Set(["beam-free"])],
      ["opencode-go", new Set(["mimo-v2.6-flash"])],
    ]),
  );
  expect(out.map((m) => m.id)).toEqual(["beam-free", "mimo-v2.6-flash", "gpt-5.2"]);
});

it("каталог одного шлюза не узнали — его модели отдаём как есть", () => {
  const out = filterByLiveCatalog(models, new Map([["opencode", new Set(["beam-free"])]]));
  expect(out.some((m) => m.provider === "opencode-go" && m.id === "mimo-v2.5")).toBe(true);
});

it("не узнали ни одного каталога — отдаём список как есть", () => {
  expect(filterByLiveCatalog(models, new Map())).toEqual(models);
});
