import {it, expect} from "vitest";
import {filterByZenCatalog} from "../src/lib/zenModelCatalog.js";

// 04.11.2026: models.dev держит в провайдере opencode модели, которых шлюз
// уже не обслуживает (mimo-v2.5-free, space-bunny-free, cat-jam-free).
// Выбор такой модели в приложении давал 400 «Model is unavailable».
const models = [
  {id: "mimo-v2.5-free", provider: "opencode"},
  {id: "beam-free", provider: "opencode"},
  {id: "gpt-5.2", provider: "openai"},
];

it("выкидывает модели opencode, которых нет в живом каталоге шлюза", () => {
  const out = filterByZenCatalog(models, new Set(["beam-free"]));
  expect(out.map((m) => m.id)).toEqual(["beam-free", "gpt-5.2"]);
});

it("чужих провайдеров не трогает", () => {
  const out = filterByZenCatalog(models, new Set<string>());
  expect(out.map((m) => m.id)).toEqual(["gpt-5.2"]);
});

it("не узнали каталог — отдаём список как есть", () => {
  expect(filterByZenCatalog(models, null)).toEqual(models);
});
