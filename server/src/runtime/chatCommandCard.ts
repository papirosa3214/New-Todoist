// Карточка команды чата (владелец 27.10.2026): навыки и инструменты —
// одинаковыми карточками: понятное русское название, значок, что делает
// «в двух словах». Подробное описание — только на экране «Подробнее».
import fs from "node:fs";
import { mcpToolTitle } from "./chatLiveTurn.js";

export interface CommandCard {
  title: string;
  summary: string;
  /** Имя SF Symbol для приложения. */
  icon: string;
}

const NATIVE_ICONS: Record<string, string> = {
  read: "doc.text",
  write: "square.and.pencil",
  edit: "pencil",
  bash: "terminal",
  grep: "text.magnifyingglass",
  find: "magnifyingglass",
  ls: "folder",
};

/** Первая фраза описания: до двоеточия, точки или тире, не длиннее 48 знаков. */
export function shortPhrase(text: string): string {
  const first = text.replace(/\s+/g, " ").trim().split(/[.:;—]\s|[.:;]$/)[0]?.trim() ?? "";
  return first.length > 48 ? first.slice(0, 47).trimEnd() + "…" : first;
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(frontmatter);
  if (!match) return null;
  const value = match[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return value && !value.startsWith(">") && !value.startsWith("|") ? value : null;
}

/** Поля `title`, `summary`, `icon` из шапки SKILL.md; чего нет — из имени и описания. */
export function skillCard(filePath: string, name: string, description: string): CommandCard {
  let frontmatter = "";
  try {
    frontmatter = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(filePath, "utf8"))?.[1] ?? "";
  } catch {
    frontmatter = "";
  }
  return {
    title: frontmatterValue(frontmatter, "title") ?? name.replace(/[-_]+/g, " "),
    summary: frontmatterValue(frontmatter, "summary") ?? shortPhrase(description),
    icon: frontmatterValue(frontmatter, "icon") ?? "sparkles",
  };
}

/** Встроенный инструмент или операция трекера: подпись шага, значок по имени. */
export function toolCard(name: string, title: string, description: string): CommandCard {
  const words = title === name ? mcpToolTitle(name) : title;
  return {
    title: words.charAt(0).toUpperCase() + words.slice(1),
    summary: shortPhrase(description),
    icon: NATIVE_ICONS[name] ?? "wrench.and.screwdriver",
  };
}
