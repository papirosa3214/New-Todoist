// Спек 1.2, задача 1.2.6: заполнить role_embeddings для 8 ролей из role-routing.yaml
// (researcher, analyst, critic_verifier, architect, builder, qa, designer).
//
// Каждая роль получает:
//   - tags: JSON-массив коротких категориальных меток (грубый фильтр)
//   - embedding: bge-m3 вектор от длинного описания роли (тонкий cosine)
//
// Запуск: npx tsx server/scripts/seed-role-embeddings.ts
//
// Идемпотентно: при повторном запуске перезаписывает. Логирует diff
// (сколько строк обновлено, сколько вставлено).

import db from "../src/db.js";
import { getEmbeddings } from "../src/lib/embeddingClient.js";

// Описания ролей — длинный текст, который bge-m3 векторизует. Теги —
// короткие ключевые слова для грубого фильтра (категориальное пересечение).
// Источник истины — спек 1.1 (роли) + специфика из опыта (что делает каждая роль).
const ROLE_DEFINITIONS: Array<{
  role: string;
  tags: string[];
  description: string;
}> = [
  {
    role: "researcher",
    tags: ["research", "explore", "compare", "investigate", "survey"],
    description:
      "Исследователь: собирает и сравнивает информацию, изучает предмет " +
      "с разных сторон. Используется на этапе разведки — что уже делали " +
      "по похожей теме, какие уроки есть в базе знаний, какие подходы " +
      "применялись. Результат — картина предметной области и список " +
      "релевантных источников для следующего шага. " +
      "Типичные формулировки задач: изучить, разведать, выяснить, найти информацию, посмотреть как у других, собрать источники, разобраться в предмете, что известно про.",
  },
  {
    role: "analyst",
    tags: ["data", "metrics", "numbers", "statistics", "finance", "cost"],
    description:
      "Аналитик: работает с цифрами, метриками, данными. Считает, " +
      "сравнивает, строит выводы из количественных показателей. " +
      "Применяется там, где нужно оценить эффект, посчитать стоимость, " +
      "сравнить варианты по метрикам. Результат — числа с интерпретацией. " +
      "Типичные формулировки задач: посчитать, оценить стоимость, сравнить по цифрам, измерить, свести метрики, насколько выгодно, сколько занимает, дать диагноз по данным.",
  },
  {
    role: "critic_verifier",
    tags: ["review", "verify", "audit", "check", "qa", "validate"],
    description:
      "Критик-верификатор: проверяет чужую работу. Ищет ошибки, " +
      "несоответствия спецификации, пропущенные краевые случаи, " +
      "неконсистентность с уже принятыми решениями. Не правит сам, " +
      "а указывает — что не так, где, и каким должен быть правильный " +
      "вариант. Используется перед приёмкой. " +
      "Типичные формулировки задач: отревьюить, проверить чужую работу, вычитать, сверить со спецификацией, провести аудит, найти несоответствия, принять или вернуть на доработку.",
  },
  {
    role: "architect",
    tags: ["architecture", "design", "rest", "api", "schema", "components"],
    description:
      "Архитектор: проектирует структуру. REST API, схема БД, " +
      "границы модулей, контракты между ними. Думает о будущих " +
      "изменениях, расширяемости, совместимости. Код не пишет — " +
      "пишет схему и обоснование. Результат — диаграмма или " +
      "документ с решением, а не реализация. " +
      "Типичные формулировки задач: спроектировать, продумать структуру, описать контракт, договориться о границах модулей, выбрать подход, разложить на слои, как это должно быть устроено.",
  },
  {
    role: "builder",
    tags: ["implement", "code", "build", "feature", "fix"],
    description:
      "Строитель: пишет код. Реализует то, что спроектировал архитектор, " +
      "исправляет то, что нашёл критик. Основной объём работы по " +
      "карточкам. Результат — коммиты, проходящие тесты, и комментарии " +
      "в ленте сделанного. " +
      "Типичные формулировки задач: сделать, реализовать, починить, исправить баг, добавить функцию, поправить поведение, доделать, подключить, переписать код, кнопка не работает.",
  },
  {
    role: "qa",
    tags: ["test", "validate", "edge-case", "regression"],
    description:
      "Тестировщик: пишет и гоняет тесты. Покрывает граничные случаи, " +
      "регрессии, проверяет что фича не сломала соседнее. Результат — " +
      "зелёный прогон и описание что именно проверялось. " +
      "Типичные формулировки задач: протестировать, покрыть тестами, прогнать проверку, воспроизвести баг, проверить что не сломалось, краевые случаи, регрессия.",
  },
  {
    role: "designer",
    tags: ["ui", "ux", "design", "interaction", "interface", "visual"],
    description:
      "Дизайнер: интерфейсы. Экраны, потоки, состояния, типографика, " +
      "цвет. Думает о пользователе и о том, как задача будет " +
      "выглядеть и ощущаться. Результат — макеты или код UI по " +
      "дизайн-системе. " +
      "Типичные формулировки задач: нарисовать экран, сделать макет, придумать как выглядит, поправить вёрстку, отступы и цвета, состояния интерфейса, как пользователь это увидит.",
  },
];

async function main() {
  console.log(`[seed-role-embeddings] старт, ролей: ${ROLE_DEFINITIONS.length}`);
  const tagsFor = (r: typeof ROLE_DEFINITIONS[number]) => JSON.stringify(r.tags);

  // Сгенерируем эмбеддинги ПАЧКОЙ (одним запросом к Ollama), чтобы
  // не делать N отдельных HTTP-вызовов.
  const inputs = ROLE_DEFINITIONS.map((r) => r.description);
  const { embeddings, dim } = await getEmbeddings(inputs);
  if (!Array.isArray(embeddings)) {
    throw new Error("getEmbeddings вернул не массив — нельзя батчить");
  }
  console.log(`[seed-role-embeddings] модель вернула ${embeddings.length} векторов, dim=${dim}`);

  const insert = db.prepare(
    `INSERT INTO role_embeddings (role, embedding, tags, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(role) DO UPDATE SET
         embedding = excluded.embedding,
         tags = excluded.tags,
         updated_at = datetime('now')`,
  );

  let written = 0;
  for (let i = 0; i < ROLE_DEFINITIONS.length; i += 1) {
    const r = ROLE_DEFINITIONS[i];
    const vector = embeddings[i];
    const buf = Buffer.from(new Float32Array(vector).buffer);
    insert.run(r.role, buf, tagsFor(r));
    written += 1;
    console.log(`[seed-role-embeddings] ${r.role}: dim=${vector.length}, tags=${r.tags.length}`);
  }

  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM role_embeddings").get() as { n: number }
  ).n;
  console.log(`[seed-role-embeddings] готово: записано ${written}, в таблице ${total}`);
}

main().catch((err) => {
  console.error("[seed-role-embeddings] ОШИБКА:", err);
  process.exit(1);
});
