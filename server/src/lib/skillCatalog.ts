/**
 * Человеческие имена навыков для показа владельцу.
 *
 * Навык живёт как `~/taskflow/roles/<роль>/skills/<имя>/SKILL.md`. Имя папки —
 * латиницей (`diagnosing-bugs`), владельцу оно ничего не говорит. Первая строка
 * `# ` в теле навыка — русский заголовок («Диагностика багов»), и он уже есть у
 * всех 198 навыков после приведения к общей структуре. Поэтому отдельного поля
 * в шапке не заводим: заголовок читаем из тела.
 */

import fs from "node:fs";

export type SkillLabel = {
  /** Имя папки — латиницей, для логов и отладки. */
  name: string;
  /** Заголовок по-русски для владельца. */
  title: string;
};

/** Первый заголовок `# ` из тела навыка, без решётки и пробелов. */
export function russianTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# ")) continue;
    const title = trimmed.slice(2).trim();
    if (title) return title;
  }
  return fallback;
}

/** Заголовок навыка по пути к SKILL.md; файл не читается — вернётся имя. */
export function skillLabel(name: string, filePath: string | null | undefined): SkillLabel {
  if (!filePath) return { name, title: name };
  try {
    return { name, title: russianTitle(fs.readFileSync(filePath, "utf8"), name) };
  } catch {
    return { name, title: name };
  }
}

/** Список для показа: без повторов, в порядке подключения. */
export function skillLabels(items: Array<{ name: string; filePath?: string | null }>): SkillLabel[] {
  const seen = new Set<string>();
  const out: SkillLabel[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(skillLabel(item.name, item.filePath));
  }
  return out;
}
