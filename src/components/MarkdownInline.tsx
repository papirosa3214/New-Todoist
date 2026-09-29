// React-обёртка над renderInlineMarkdown: кладёт HTML внутрь элемента
// с заданным тегом. Используется как замена `{task.title}` в местах,
// где раньше строка вставлялась напрямую — DOM-структура страницы не
// меняется (line-clamp, truncate, flex — продолжают работать как раньше).

import type { CSSProperties, ElementType } from "react";
import { renderInlineMarkdown } from "../lib/markdownInline";

export interface MarkdownInlineProps {
  source: string | null | undefined;
  /** Тег обёртки. По умолчанию span — вписывается в большинство мест. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  /** aria-label для доступности (если в тексте только Markdown-разметка,
   *  скринридер прочитает «звёздочка жирный текст звёздочка», что плохо) */
  "aria-label"?: string;
}

export function MarkdownInline({
  source,
  as,
  className,
  style,
  "aria-label": ariaLabel,
}: MarkdownInlineProps) {
  const Tag = as ?? "span";
  const html = renderInlineMarkdown(source);
  // Если после парсинга HTML пуст, но исходная строка была, значит это
  // были одни бэктики/звёздочки без пары — показываем как обычный текст.
  const fallback = html === "" && source ? source : html;
  return (
    <Tag
      className={className}
      style={style}
      aria-label={ariaLabel}
      dangerouslySetInnerHTML={{ __html: fallback }}
    />
  );
}