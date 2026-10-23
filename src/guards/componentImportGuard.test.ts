// Сторож регрессии 72eb2f27: компонент рендера названий задач
// (<MarkdownInline>) в трёх файлах веба использовался БЕЗ импорта.
// На живой странице это выглядело как «Экран не смог отрисоваться»
// (ReferenceError: MarkdownInline is not defined) — то есть экран падал
// целиком, как только на нём рисовалось название задачи.
//
// Компилятор такие места ловит, но только если проверка типов реально
// запускается перед выкладкой. Этот тест — дешёвый сторож на уровне
// исходников: ни один файл src/ не имеет права использовать компонент
// из src/components/, не импортировав его.
//
// Правило проверки: если в файле есть JSX-использование <Имя>, а в файле
// нет импорта с этим локальным именем — компонент «забыт», и файл упадёт
// в рантайме. Проверяются только компоненты, чьё имя совпадает с именем
// файла (MarkdownInline.tsx → MarkdownInline): это исключает ложные
// срабатывания на общих именах вроде Icon.
//
// Файлы читаются через import.meta.glob (Vite), а не через node:fs:
// тесты лежат в src/, где types = ["vite/client"] и node-модули недоступны.

import { describe, it, expect } from "vitest";

const files = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  eager: true,
}) as Record<string, string | { default: string }>;

/** Текст файла: в разных сборщиках ?raw приходит строкой или объектом с default. */
function textOf(raw: string | { default: string }): string {
  return typeof raw === "string" ? raw : raw.default;
}

/** Имена компонентов из src/components, совпадающие с именем файла. */
function componentNames(): string[] {
  const names: string[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const src = textOf(raw);
    const m = path.match(/\/components\/([A-Z][A-Za-z0-9]*)\.tsx$/);
    if (!m) continue;
    const base = m[1];
    const exported = new RegExp(
      `export\\s+(default\\s+)?(function|const|class)\\s+${base}\\b`,
    ).test(src);
    if (exported) names.push(base);
  }
  return names;
}

/** Локальные имена, привязанные импортами (учитываем `as`). */
function importedBindings(src: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (!piece) continue;
      const asMatch = piece.match(/\bas\s+([A-Za-z0-9_$]+)$/);
      names.add(asMatch ? asMatch[1] : piece);
    }
  }
  const defRe = /import\s+([A-Za-z0-9_$]+)\s+from/g;
  while ((m = defRe.exec(src))) names.add(m[1]);
  return names;
}

describe("сторож импортов компонентов", () => {
  const names = componentNames();

  it("находит хотя бы один компонент для проверки", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("ни один файл src/ не использует компонент без импорта", () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(files)) {
      const src = textOf(raw);
      const bound = importedBindings(src);
      for (const name of names) {
        const used = new RegExp(`<${name}[\\s/>]`).test(src);
        if (used && !bound.has(name)) {
          offenders.push(`${path}: <${name}> без импорта`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
