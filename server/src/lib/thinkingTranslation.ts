// Размышления роли по-русски (владелец 08.11.2026): модель думает на языке
// инструкций, телефон показывает английский поток сознания. Переводим на
// сервере готовый блок размышлений, локальной моделью на видеокарте .110:
// внешних вызовов нет, время хода не растёт (перевод идёт после того, как
// блок закончился), при недоступности модели остаётся оригинал.

const CHUNK_MAX = 1200;
/** Меньше этого переводить нечего: «ok», «let me check» — не текст для чтения. */
const MIN_CHARS = 30;

const cache = new Map<string, string>();
const CACHE_MAX = 300;

const PROMPT = [
  "Ты переводчик технических размышлений разработчика на русский язык.",
  "Переведи текст на русский, сохранив смысл и тон.",
  "Код, команды, имена файлов, функции, пути и идентификаторы не переводи и не меняй — оставь как в оригинале.",
  "Не добавляй пояснений, вступлений и markdown-заголовков: верни только перевод.",
].join(" ");

/** Есть ли в тексте что переводить: латиница и хоть какой-то объём. */
export function shouldTranslate(text: string): boolean {
  const body = text.trim();
  if (body.length < MIN_CHARS) return false;
  const latin = (body.match(/[A-Za-z]/g) ?? []).length;
  const letters = (body.match(/[A-Za-zА-Яа-яЁё]/g) ?? []).length;
  // Если латиницы меньше трети букв, текст уже русский.
  return letters > 0 && latin / letters > 0.3;
}

interface Piece {
  text: string;
  code: boolean;
}

/** Разбить размышление на куски: код не переводим, длинные куски режем. */
export function splitForTranslation(text: string): Piece[] {
  const pieces: Piece[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("```")) {
      pieces.push({ text: part, code: true });
      continue;
    }
    let rest = part;
    while (rest.length > CHUNK_MAX) {
      // Режем по границе предложения, если она есть недалеко от предела.
      const window = rest.slice(0, CHUNK_MAX);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
      const at = cut > CHUNK_MAX * 0.4 ? cut + 1 : CHUNK_MAX;
      pieces.push({ text: rest.slice(0, at), code: false });
      rest = rest.slice(at);
    }
    if (rest.trim()) pieces.push({ text: rest, code: false });
  }
  return pieces;
}

async function defaultModel(chunk: string): Promise<string> {
  const { callUnifiedAi } = await import("./aiClient.js");
  const { LOCAL_DEFAULT_MODEL } = await import("./localModels.js");
  const out = await callUnifiedAi({
    systemPrompt: PROMPT,
    userPrompt: chunk,
    provider: "local",
    localModel: LOCAL_DEFAULT_MODEL,
    temperature: 0.1,
    predictTokens: 900,
  });
  return String(out ?? "").trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("перевод не успел")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Перевести размышление на русский. Возвращает null, если переводить нечего
 * или переводчик недоступен: вызывающий тогда оставляет оригинал.
 */
export async function translateThinkingRu(
  text: string,
  deps?: { model?: (chunk: string) => Promise<string>; timeoutMs?: number },
): Promise<string | null> {
  if (!shouldTranslate(text)) return null;
  const cached = cache.get(text);
  if (cached) return cached;
  const model = deps?.model ?? defaultModel;
  const timeoutMs = deps?.timeoutMs ?? 20_000;
  const pieces = splitForTranslation(text);
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.code || !piece.text.trim()) {
      out.push(piece.text);
      continue;
    }
    try {
      const translated = (await withTimeout(model(piece.text), timeoutMs)).trim();
      if (!translated) return null;
      // Совсем короткий ответ на длинный кусок — модель обрезала или отказалась.
      if (piece.text.length > 200 && translated.length < piece.text.length * 0.25) return null;
      out.push(translated);
    } catch {
      return null;
    }
  }
  const result = out.join("");
  if (!result.trim()) return null;
  cache.set(text, result);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return result;
}

/** Для тестов: очистить кэш переводов. */
export function _resetThinkingTranslationCache(): void {
  cache.clear();
}
