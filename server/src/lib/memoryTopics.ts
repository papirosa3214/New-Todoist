// Темы памяти — ключи для детерминированной подсказки (владелец 08.11.2026).
//
// «Раз у нас отдельная служба строчит эту память, можно чисто детерминированно
// фиксировать какие-то темы, и когда у роли в раздумьях возникают подобные темы,
// сразу подсказка: темы были, иди ищи там ещё».
//
// Темы — это нормализованные слова записи без словоизменительных окончаний.
// Никакой модели: одна и та же функция считает темы записи и темы вопроса,
// поэтому совпадение — это буквально равенство строк.
import db from "../db.js";

/** Слова, которые ничего не называют. */
const STOP_WORDS = new Set([
  "это", "этот", "эта", "эти", "тот", "та", "те", "для", "как", "так", "что", "чтобы", "чем",
  "когда", "где", "если", "или", "либо", "есть", "был", "была", "было", "были", "быть", "будет",
  "надо", "нужно", "можно", "нельзя", "тоже", "также", "ещё", "еще", "уже", "вот", "всё", "все",
  "весь", "при", "про", "под", "над", "без", "для", "из", "от", "до", "по", "за", "на", "не",
  "ни", "но", "да", "нет", "ли", "же", "бы", "мы", "вы", "он", "она", "они", "оно", "я", "ты",
  "свой", "своя", "свои", "себя", "который", "которая", "которые", "этого", "этом", "этой",
  "потом", "сейчас", "теперь", "просто", "очень", "более", "менее", "самый", "самая",
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "have",
  "has", "had", "was", "were", "are", "will", "would", "should", "could", "you", "your", "our",
  "not", "but", "all", "any", "can", "may", "must", "one", "two", "out", "use", "used",
]);

/** Окончания, которые срезаем: сравниваем темы, а не точные словоформы. */
const RU_ENDINGS = [
  "иями", "ями", "ами", "ией", "иях", "ого", "его", "ому", "ему", "ыми", "ими", "ая", "яя",
  "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ей", "ов", "ев", "ам", "ям", "ах", "ях", "ом",
  "ем", "ую", "юю", "ии", "ия", "ию", "ы", "и", "а", "я", "е", "о", "у", "ю", "ь",
];

const EN_ENDINGS = ["ings", "ing", "ers", "er", "ies", "ed", "es", "s"];

function stem(word: string): string {
  let out = word;
  for (const ending of RU_ENDINGS) {
    if (out.length - ending.length >= 4 && out.endsWith(ending)) {
      out = out.slice(0, out.length - ending.length);
      break;
    }
  }
  if (/^[a-z]+$/.test(out)) {
    for (const ending of EN_ENDINGS) {
      if (out.length - ending.length >= 4 && out.endsWith(ending)) {
        out = out.slice(0, out.length - ending.length);
        break;
      }
    }
  }
  // Пять знаков — общая основа для словоформ: «колонок» и «колонки» дают
  // «колон», «таблица» и «таблицы» — «табли». Дальше сравниваем префиксы.
  return out.length > 5 ? out.slice(0, 5) : out;
}

/** Темы текста: нормализованные слова, по одному разу, в порядке появления. */
export function topicsOf(text: string, limit = 40): string[] {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const word of words) {
    const topic = stem(word);
    if (topic.length < 4 || STOP_WORDS.has(topic) || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(topic);
    if (topics.length >= limit) break;
  }
  return topics;
}

/** Темы конкретного вопроса — те же, что у записи, поэтому сравнение прямое. */
export function queryTopics(text: string): string[] {
  return topicsOf(text, 32);
}

/** Пересчитать темы одной записи (после записи или правки памяти). */
export function reindexTopicOf(memoryId: string, title: string | null, text: string): void {
  db.prepare(`DELETE FROM memory_topics WHERE memory_id = ?`).run(memoryId);
  const titleTopics = new Set(topicsOf(title ?? "", 24));
  const topics = topicsOf(`${title ?? ""} ${text}`.slice(0, 4000));
  if (!topics.length) return;
  // Тема из заголовка весит вдвое: о чём запись, а не где это упомянуто.
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO memory_topics (topic, memory_id, weight) VALUES (?, ?, ?)`,
  );
  for (const topic of topics) stmt.run(topic, memoryId, titleTopics.has(topic) ? 2 : 1);
}

/** Пересчитать темы всех записей — после смены правил разбора или миграции. */
export function reindexAllTopics(): number {
  const rows = db
    .prepare(`SELECT id, title, text FROM memories WHERE kind <> 'file'`)
    .all() as Array<{ id: string; title: string | null; text: string }>;
  for (const row of rows) reindexTopicOf(row.id, row.title, row.text);
  return rows.length;
}

interface TopicHit {
  memory_id: string;
  strong: number;
  score: number;
}

/**
 * Записи, к которым подходит вопрос, по совпадению тем.
 * Редкие темы весят больше: «таблиц» важнее, чем «сервер».
 */
export function topicMatches(topics: string[], limit = 8): TopicHit[] {
  if (!topics.length) return [];
  const marks = topics.map(() => "?").join(", ");
  // Одно общее слово («чате») записью по теме не считается: при длинном
  // вопросе требуем хотя бы два совпадения, иначе подсказка шумит.
  const need = topics.length >= 3 ? 2 : 1;
  return db
    .prepare(
      `WITH totals AS (SELECT topic, COUNT(*) AS c FROM memory_topics GROUP BY topic)
       SELECT mt.memory_id AS memory_id,
              COUNT(*) AS hits,
              SUM(CASE WHEN mt.weight > 1 THEN 1 ELSE 0 END) AS strong,
              SUM(mt.weight * (1.0 / (1.0 + t.c))) AS score
         FROM memory_topics mt JOIN totals t ON t.topic = mt.topic
        WHERE mt.topic IN (${marks})
        GROUP BY mt.memory_id
       HAVING COUNT(*) >= ?
        ORDER BY SUM(CASE WHEN mt.weight > 1 THEN 1 ELSE 0 END) DESC, hits DESC, score DESC
        LIMIT ?`,
    )
    .all(...topics, need, limit) as TopicHit[];
}
