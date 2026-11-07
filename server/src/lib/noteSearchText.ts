/**
 * Plain-text для FTS по user_notes: content хранится как TipTap JSON.
 * search_text — денормализованный markdown body (cap), пишется вместе с content.
 */
import { tiptapToMarkdown } from "./tiptapToMarkdown.js";

export const NOTE_SEARCH_TEXT_MAX = 200_000;

export function noteSearchText(content: string | null | undefined): string {
  const raw = String(content ?? "");
  if (!raw) return "";
  let md = "";
  try {
    md = tiptapToMarkdown(raw);
  } catch {
    md = raw;
  }
  if (md.length > NOTE_SEARCH_TEXT_MAX) return md.slice(0, NOTE_SEARCH_TEXT_MAX);
  return md;
}
