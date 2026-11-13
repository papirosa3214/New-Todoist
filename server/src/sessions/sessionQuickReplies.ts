// ═══ КОПИЯ ДЛЯ СЕССИЙ (владелец 13.11.2026: «скопировать из того файлика в этот»).
// Исходник у ролей — server/src/lib/quickReplies.ts. Правки сессий — сюда, ролей — туда.
/** Быстрые ответы (владелец 25.09.2026): модель заканчивает ответ строкой
 *  `БЫСТРО: вариант1 | вариант2 | вариант3` — разбираем и убираем из
 *  текста, который ложится в ленту. Раньше жило только у Помощника владельца,
 *  теперь это общий формат ответа любой роли. */
export function extractQuickReplies(text: string): { clean: string; replies: string[] | null } {
  const lines = text.split("\n");
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx < 0) return { clean: text, replies: null };
  // Маркер ищем в любом месте последней непустой строки (владелец 11.11.2026:
  // роль приписывает его в конец абзаца, и кнопки терялись). Варианты — всё,
  // что стоит после маркера до конца строки; сам маркер вырезаем вместе с
  // пробелом или переводом строки перед ним.
  const line = lines[lastIdx];
  const marker = /(^|\s)БЫСТРО:\s*/i.exec(line);
  if (!marker) return { clean: text, replies: null };
  const prefix = line.slice(0, marker.index + marker[1].length).trimEnd();
  const replies = line
    .slice(marker.index + marker[0].length)
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!replies.length) return { clean: text, replies: null };
  const head = [...lines.slice(0, lastIdx), prefix].filter((part) => part.trim() !== "").join("\n");
  const tail = lines.slice(lastIdx + 1).join("\n").trim();
  const clean = (tail ? `${head}\n${tail}` : head).trimEnd();
  return { clean, replies };
}

/** Разбор `БЫСТРО:` по всему ответу роли (владелец 28.10.2026: «раздел быстрых
 *  ответов перестал отрисовываться, идёт как текст»). Строка живёт не только в
 *  обычном блоке `text`, но и в тексте отчёта — а отчёт это блок `report` со
 *  своими секциями, и прежний разбор смотрел только `type: "text"`. Из-за
 *  этого кнопки у отчёта оставались простым текстом в «Ограничениях».
 *
 *  Возвращает очищенный output и варианты (последние 4 из найденных). Пустой
 *  после вырезания текстовый блок убирается целиком, чтобы в ленте не висела
 *  пустая строка. */
export function pullQuickReplies(output: Record<string, unknown>[]): {
  output: Record<string, unknown>[];
  replies: string[] | null;
} {
  const replies: string[] = [];
  const pull = (value: string): string => {
    const extracted = extractQuickReplies(value);
    if (extracted.replies) replies.push(...extracted.replies);
    return extracted.clean;
  };
  const cleanBlocks = (list: unknown[]): unknown[] =>
    list.map((item) => {
      if (!item || typeof item !== "object") return item;
      const inner = item as Record<string, unknown>;
      if (typeof inner.text !== "string") return item;
      return { ...inner, text: pull(inner.text) };
    });

  const cleaned = output.flatMap((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      const text = pull(block.text);
      return text.trim() ? [{ ...block, text }] : [];
    }
    if (block.type === "report") {
      const sections = block.sections;
      if (!sections || typeof sections !== "object") return [block];
      const next: Record<string, unknown> = { ...(sections as Record<string, unknown>) };
      for (const key of ["result", "work", "limitations"]) {
        const value = next[key];
        if (Array.isArray(value)) next[key] = cleanBlocks(value as unknown[]);
      }
      return [{ ...block, sections: next }];
    }
    return [block];
  });

  return { output: cleaned, replies: replies.length ? replies.slice(0, 4) : null };
}
