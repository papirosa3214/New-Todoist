// Конверт ответа роли с лишней запятой перед ] или } (владелец 27.10.2026,
// скриншот: ответ Помощника про хранилище пришёл сырым JSON). RED на старом
// коде: мягкий разбор срезал только хвостовые скобки, запятую — нет.
import { it, expect } from "vitest";
import { normalizeRoleReplyV1 } from "../src/lib/roleContractV1.js";

const reply = '{"schema_version":1,"ok":true,"output":[{"type":"heading","level":2,"text":"Хранилище — стопка папок"},'
  + '{"type":"table","title":"Оценка","columns":["Раздел","Файлов"],"rows":[["Работа/","225"],["raw-дампы","33"]],},'
  + '{"type":"text","text":"Итог, без запятой внутри строки: a,]"}],"artifacts":[],"facts":[],"plan_artifact":null,"error":null,"next_hint":null,"needs_human":true}';

it("лишняя запятая перед } и ] не превращает ответ в сырой JSON", () => {
  const result = normalizeRoleReplyV1(reply);
  expect(result.displayText).not.toContain('"schema_version"');
  expect(result.displayText).toContain("## Хранилище — стопка папок");
  expect(result.displayText).toContain("| Работа/ | 225 |");
  // Запятая внутри строки остаётся как есть.
  expect(result.displayText).toContain("Итог, без запятой внутри строки: a,]");
});

it("конверт, который не разобрать никак, всё равно не доходит сырым JSON", () => {
  // Ключ без кавычек посреди конверта — никакая починка не спасёт.
  const broken = '{"schema_version":1,"ok":true,"output":[{"type":"text","text":"Первый абзац ответа."},{type:"text","text":"второй"}]}';
  const result = normalizeRoleReplyV1(broken);
  expect(result.displayText).not.toContain('"schema_version"');
  expect(result.displayText).not.toMatch(/^\s*\{/);
});
