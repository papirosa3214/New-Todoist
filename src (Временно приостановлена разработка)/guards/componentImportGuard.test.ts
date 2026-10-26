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

// --- Дубль локального имени импорта -------------------------------------
//
// Два независимых изменения одного дефекта (07ce8893 из ветки роли 38ca01ac
// и 09e1c798) добавили `import { MarkdownInline }` в разные места одного
// файла. Git не увидел конфликта — строки добавлены в разное место, — и в
// main появился дубль импорта. Модуль перестал собираться: vite отдавал 500
// (PARSE_ERROR 'Identifier MarkdownInline has already been declared') на
// ВСЕХ экранах веба.
//
// Сторож выше (проверка «компонент использован без импорта») такой случай
// пропускал: importedBindings() собирает привязанные имена в Set, поэтому
// повторное локальное имя не видно.

/**
 * Убирает комментарии и содержимое строк, оставляя код. Кавычки строк
 * сохраняются (иначе не найти `from "модуль"`).
 *
 * Без этого разбор ловит примеры импортов в комментариях (в вебе есть
 * комментарии вида «import { PRIORITIES } from ...», объясняющие реэкспорт)
 * и строковые литералы с кодом — это ложные срабатывания сторожа.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      out += quote;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          i++;
          if (i < n) {
            if (src[i] === "\n") out += "\n";
            i++;
          }
          continue;
        }
        if (src[i] === "\n") out += "\n";
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Все локальные имена, привязанные импортами, по порядку появления.
 *
 * Учитываются: default-импорты, namespace-импорты (`* as ns`), именованные
 * импорты и алиасы (`X as Y`). Объявление целиком `import type ...` не
 * считается: оно стирается сборкой. Помеченный внутри фигурных скобок
 * `type`-импорт (например `import { type A }`) считается: имя всё равно
 * занимает пространство имён, и TypeScript ругается на повтор.
 */
function importBindingNames(src: string): string[] {
  const names: string[] = [];
  const code = stripCommentsAndStrings(src);
  // Клауза импорта не содержит кавычек и «;», поэтому Side-effect импорты
  // (`import "./x"`) и `import(...)` под этот шаблон не попадают.
  const re = /import\s+(type\s+)?([^'";]*?)\s+from\s*['"][^'"]*['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) continue; // объявление целиком type-only — стирается сборкой
    const clause = m[2].trim();
    const braceIdx = clause.indexOf("{");
    const head = (braceIdx === -1 ? clause : clause.slice(0, braceIdx))
      .replace(/,\s*$/, "")
      .trim();
    if (head.startsWith("*")) {
      const ns = head.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
      if (ns) names.push(ns[1]);
    } else if (head) {
      const def = head.match(/^[A-Za-z0-9_$]+/);
      if (def) names.push(def[0]);
    }
    if (braceIdx !== -1) {
      const end = clause.indexOf("}", braceIdx);
      const inner = clause.slice(braceIdx + 1, end === -1 ? undefined : end);
      for (const part of inner.split(",")) {
        const piece = part.trim().replace(/^type\s+/, "");
        if (!piece) continue;
        const asMatch = piece.match(/\bas\s+([A-Za-z0-9_$]+)$/);
        names.push(asMatch ? asMatch[1] : piece);
      }
    }
  }
  return names;
}

/** Имена, привязанные импортом больше одного раза (по возрастанию). */
function duplicateImportBindings(src: string): string[] {
  const counts = new Map<string, number>();
  for (const name of importBindingNames(src)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([name]) => name)
    .sort();
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

describe("сторож дублей импорта", () => {
  it("считает повторное локальное имя импорта (синтетический дубль)", () => {
    const src = [
      'import { MarkdownInline } from "../components/MarkdownInline";',
      'import { MarkdownInline } from "../ui/MarkdownInline";',
    ].join("\n");
    expect(duplicateImportBindings(src)).toEqual(["MarkdownInline"]);
  });

  it("видит дубль default-импорта и алиаса", () => {
    const src = [
      'import Card from "../components/Card";',
      'import { Card } from "../ui/Card";',
      'import { MarkdownInline as Md } from "../ui/MarkdownInline";',
      'import { MarkdownInline as Md } from "../components/MarkdownInline";',
    ].join("\n");
    expect(duplicateImportBindings(src)).toEqual(["Card", "Md"]);
  });

  it("не считает дублем разные имена и type-импорты", () => {
    const src = [
      'import { MarkdownInline } from "../components/MarkdownInline";',
      'import { MarkdownBlock } from "../components/MarkdownBlock";',
      'import type { MarkdownInline as MdType } from "../ui/types";',
      'import { type OnlyType } from "../ui/onlyType";',
      'import * as React from "react";',
    ].join("\n");
    expect(duplicateImportBindings(src)).toEqual([]);
  });

  it("ни один файл src/ не импортирует одно локальное имя дважды", () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(files)) {
      const src = textOf(raw);
      for (const name of duplicateImportBindings(src)) {
        offenders.push(`${path}: повторный импорт ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
