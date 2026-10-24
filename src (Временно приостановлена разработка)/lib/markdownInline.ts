// ═══════════ Markdown: inline-разметка для названий и описаний задач ═══════════
//
// Крошечный парсер для названий (task.title, subtask.title) и описаний
// (task.description). Цель — сделать жирный/курсив/код/ссылки видимыми в
// интерфейсе там, где сейчас стоит `{task.title}` как обычная строка.
//
// Почему НЕ marked/markdown-it: правило проекта — «новые npm-зависимости
// не добавляются без явного одобрения Максима». Кроме того, нам нужна
// ровно inline-разметка (жирный, курсив, код, ссылка), а не полный
// Markdown-движок — блоки в однострочном заголовке всё равно не нужны.
//
// Безопасность:
//  1. Сначала экранируем ВСЕ символы, у которых есть HTML-значение
//     (`&`, `<`, `>`, `"`, `'`). Это убивает любые попытки встроить
//     `<script>` / `<img onerror=…>`.
//  2. Потом запускаем замену паттернов Markdown → HTML. Поскольку
//     опасные символы уже превратились в entities (`&lt;`, `&gt;`),
//     они никогда не окажутся внутри HTML-тегов, которые мы генерим.
//
// Что поддерживается (ровно то, что в корневой цели задачи):
//   **жирный** или __жирный__
//   *курсив*  или _курсив_
//   `код`
//   [текст](https://example.com)
//
// Что НЕ поддерживается намеренно:
//   - блочные конструкции (#, >, ```, списки) — для одной строки
//     заголовка или короткого описания они не нужны;
//   - картинки ![…](…) — потенциальный вектор XSS через onerror;
//   - reference-link [текст][ref] — избыточно для текущего UX;
//   - HTML-инъекции через «сырой HTML» — запрещено правилом проекта
//     (AttachmentViewerSheet.tsx: «Разметка markdown НЕ рендерится»).
//
// Граничные случаи (см. тест):
//   - пустая строка → "";
//   - только пробелы → как есть, без обрезки;
//   - непарные `*` / `[` → считаются обычным текстом;
//   - пустой `[]()` без URL → обычный текст;
//   - `javascript:` в URL → URL выкидывается, текст ссылки остаётся.

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** true, если протокол ссылки безопасный для href. */
function isSafeUrl(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // Разрешаем http(s), mailto, относительные ссылки (/path, foo, ?q=).
  // Всё, что похоже на javascript:/data:/vbscript: — отбрасываем.
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return false;
  return true;
}

/**
 * Разбирает Markdown в HTML-строку. Возвращаемый фрагмент безопасно
 * класть в `dangerouslySetInnerHTML` — все спецсимволы уже экранированы,
 * протоколы ссылок проверены.
 */
export function renderInlineMarkdown(input: string | null | undefined): string {
  if (input == null || input === "") return "";
  const escaped = escapeHtml(input);

  // 1. Код `…` — заменяем на плейсхолдер, чтобы Markdown-разметка внутри
  //    него (звёздочки, подчёркивания, скобки) не трогалась дальше.
  const codeStash: string[] = [];
  let staged = escaped.replace(
    /`([^`\n]+?)`/g,
    (_m, code: string) => {
      const idx = codeStash.push(
        `<code class="md-inline-code">${code}</code>`,
      ) - 1;
      // Плейсхолдер — набор непечатных символов, которые не пересекутся
      // ни с одним Markdown-паттерном.
      return `\u0000CODE${idx}\u0000`;
    },
  );

  // 2. Ссылки [текст](url) — аналогично через плейсхолдер, чтобы текст
  //    ссылки не был обработан как жирный/курсив.
  const linkStash: string[] = [];
  staged = staged.replace(
    /\[([^\]\n]+?)\]\(([^)\s]+)\)/g,
    (_m, text: string, href: string) => {
      const html = isSafeUrl(href)
        ? `<a class="md-inline-link" href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
      const idx = linkStash.push(html) - 1;
      return `\u0000LINK${idx}\u0000`;
    },
  );

  // 3. Жирный **…** и __…__.
  staged = staged.replace(
    /\*\*([^*\n]+?)\*\*/g,
    (_m, text: string) => `<strong>${text}</strong>`,
  );
  staged = staged.replace(
    /__([^_\n]+?)__/g,
    (_m, text: string) => `<strong>${text}</strong>`,
  );

  // 4. Курсив *…* и _…_ (после жирного, чтобы `**` не съел одиночные).
  //    Три ограничения против UI-артефактов:
  //    а) внутри должно быть хотя бы что-то кроме пробелов — иначе
  //       опечатка `* *` даёт пустой <em>, который в строке выглядит как
  //       фантомный курсив и ломает line-clamp;
  //    б) внутри не должно быть пробелов на границах — `* foo *` со
  //       пробелами по краям тоже опечатка, и курсив « foo » выглядит
  //       как наклонная пустота между словами;
  //    в) внутри должно быть что-то кроме цифр — `_1_` в названии задачи
  //       это обычно число версии/счётчик, а курсив на цифре ломает
  //       выравнивание и читаемость строки с цифрами.
  staged = staged.replace(
    /(^|[^*])\*([^*\n]+?)\*(?!\*)/g,
    (_m, lead: string, text: string) => {
      if (
        !/\S/.test(text) ||
        /^\s|\s$/.test(text) ||
        /^\d+$/.test(text)
      ) {
        return `${lead}*${text}*`;
      }
      return `${lead}<em>${text}</em>`;
    },
  );
  staged = staged.replace(
    /(^|[^_\w])_([^_\n]+?)_(?!\w)/g,
    (_m, lead: string, text: string) => {
      if (
        !/\S/.test(text) ||
        /^\s|\s$/.test(text) ||
        /^\d+$/.test(text)
      ) {
        return `${lead}_${text}_`;
      }
      return `${lead}<em>${text}</em>`;
    },
  );

  // 5. Восстанавливаем плейсхолдеры — ссылки до кода, чтобы код не
  //    оказался внутри ссылки, если ссылка начиналась с кода.
  const final = staged
    .replace(/\u0000LINK(\d+)\u0000/g, (_m, i: string) => linkStash[+i])
    .replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeStash[+i]);

  return final;
}