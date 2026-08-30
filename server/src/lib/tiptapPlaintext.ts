// ═══════════ Tiptap JSON → plain text ═══════════
//
// Владелец 26.08.2026: «заметки по дням — в списке показывай первые две
// строки». Tiptap хранит документ как дерево JSON; чтобы получить превью,
// обходим дерево и собираем текстовые узлы в одну строку с разумными
// переносами между блоками.
//
// Правила:
// - текст — узел {type:"text", text:"..."} → его `text`;
// - block-узлы (paragraph, heading, listItem, taskItem, blockquote) → закрываются
//   одним "\n";
// - mark/highlight — игнорируем (визуальная разметка, не меняет текст);
// - пустые блоки не дают лишних переносов.
//
// Один и тот же формат и для превью на сервере (тут — journalPreview), и для
// «выделенный текст» в NoteEditorScreen.runAssist — но на клиенте мы идём по
// state.doc, а тут по готовому JSON.

interface TiptapNode {
  type?: string;
  text?: string;
  content?: TiptapNode[];
}

export function tiptapToPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const out: string[] = [];
  walk(doc as TiptapNode, out);
  // схлопываем подряд идущие пустые строки и подрезаем
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function walk(node: TiptapNode, out: string[]): void {
  if (!node) return;
  if (typeof node.text === "string") {
    out.push(node.text);
    return;
  }
  if (Array.isArray(node.content)) {
    const isBlock =
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "listItem" ||
      node.type === "taskItem" ||
      node.type === "blockquote";
    for (const child of node.content) walk(child, out);
    if (isBlock) out.push("\n");
  }
}

/** Превью заметки — первые `max` символов. Режем по последнему пробелу,
 *  чтобы не оставлять огрызков слова на разрыве. */
export function journalPreview(contentJson: string, max = 140): string {
  if (!contentJson) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(contentJson);
  } catch {
    return "";
  }
  const full = tiptapToPlainText(doc);
  if (full.length <= max) return full;
  const cut = full.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // если пробел слишком близко к началу — режем как есть, иначе по пробелу
  const trimmed = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimmed + "…";
}