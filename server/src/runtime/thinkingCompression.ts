// Сжатие рассуждений в запросе к модели (владелец 02.11.2026):
// «сжимать эти рассуждения нужно, когда они пачкой идут в контекст на
// следующий запрос — чтобы уже не полный текст рассуждений шёл, а два-три
// предложения».
//
// Полный текст рассуждений при этом НИКУДА не девается: он остаётся в сессии
// и в живом ходе (владельцу он нужен целиком, чтобы понять, что роль
// делала). В модель уходит короткая версия.

/** Сколько предложений оставляем из рассуждения. */
export const THINKING_SENTENCES = 3;

/** Короче этого текста не трогаем: сжимать нечего. */
export const THINKING_MIN_CHARS = 240;

/** Разбить текст на предложения (по знакам конца и переводам строк). */
export function splitSentences(text: string): string[] {
  return String(text ?? "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?…])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Сжать рассуждение до последних предложений.
 *
 * Оставляем ХВОСТ: в рассуждении вывод и решение стоят в конце («Decision:
 * …»), начало — это намерение, которое и так видно по вызову инструмента.
 */
export function compressThinking(text: string, keep: number = THINKING_SENTENCES): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= THINKING_MIN_CHARS) return trimmed;
  const sentences = splitSentences(trimmed);
  if (sentences.length <= keep) return trimmed;
  return sentences.slice(-keep).join(" ");
}

/**
 * Сжать рассуждения в сообщениях запроса к модели.
 *
 * Возвращает НОВЫЙ массив сообщений: полный текст остаётся в сессии и в
 * живом ходе, а в запрос уходит короткий.
 */
export function compressContextThoughts(context: any): any {
  const messages = context?.messages;
  if (!Array.isArray(messages)) return context;
  let touched = false;
  const out = messages.map((message: any) => {
    const content = message?.content;
    if (message?.role !== "assistant" || !Array.isArray(content)) return message;
    let messageChanged = false;
    const parts = content.map((part: any) => {
      if (part?.type !== "thinking" || typeof part.thinking !== "string") return part;
      const compressed = compressThinking(part.thinking);
      if (compressed === part.thinking) return part;
      messageChanged = true;
      return { ...part, thinking: compressed };
    });
    if (!messageChanged) return message;
    touched = true;
    return { ...message, content: parts };
  });
  return touched ? { ...context, messages: out } : context;
}
