import { describe, it, expect } from "vitest";
// Конвертер живёт на СЕРВЕРЕ (агенты пишут документацию через API), а
// прогон тестов настроен на клиентский src/ — отсюда путь через ../../server.
import {
  markdownToTiptap,
  deriveTitleFromMarkdown,
} from "../../server/src/lib/markdownToTiptap";
import { tiptapToMarkdown } from "../../server/src/lib/tiptapToMarkdown";

/** Разбирает результат конвертера обратно в объект — так читаемее в тестах. */
const doc = (md: string) => JSON.parse(markdownToTiptap(md));

describe("markdownToTiptap: блоки", () => {
  it("заголовки разных уровней", () => {
    const d = doc("# Раз\n\n## Два");
    expect(d.content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(d.content[1]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(d.content[0].content[0].text).toBe("Раз");
  });

  it("абзацы", () => {
    const d = doc("Первый.\n\nВторой.");
    expect(d.content).toHaveLength(2);
    expect(d.content[0].content[0].text).toBe("Первый.");
  });

  it("пустой вход даёт валидный пустой документ", () => {
    const d = doc("");
    expect(d.type).toBe("doc");
    expect(d.content).toEqual([{ type: "paragraph" }]);
  });

  it("цитата собирает подряд идущие строки", () => {
    const d = doc("> Раз\n> Два");
    expect(d.content[0].type).toBe("blockquote");
    expect(d.content[0].content).toHaveLength(2);
  });

  it("блок кода сохраняет язык и переносы", () => {
    const d = doc("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(d.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
    });
    expect(d.content[0].content[0].text).toBe("const a = 1;\nconst b = 2;");
  });

  it("внутри блока кода разметка не разбирается", () => {
    const d = doc("```\n**не жирный**\n```");
    expect(d.content[0].content[0].text).toBe("**не жирный**");
  });

  it("горизонтальная черта", () => {
    expect(doc("---").content[0].type).toBe("horizontalRule");
  });
});

describe("markdownToTiptap: списки", () => {
  it("маркированный", () => {
    const d = doc("- раз\n- два");
    expect(d.content[0].type).toBe("bulletList");
    expect(d.content[0].content).toHaveLength(2);
  });

  it("нумерованный", () => {
    const d = doc("1. раз\n2. два");
    expect(d.content[0].type).toBe("orderedList");
  });

  it("нумерация не с единицы сохраняется", () => {
    const d = doc("5. пятый\n6. шестой");
    expect(d.content[0].attrs).toMatchObject({ start: 5 });
  });

  it("чек-лист с отметками", () => {
    const d = doc("- [x] сделано\n- [ ] нет");
    expect(d.content[0].type).toBe("taskList");
    expect(d.content[0].content[0].attrs).toMatchObject({ checked: true });
    expect(d.content[0].content[1].attrs).toMatchObject({ checked: false });
    // Сама скобка в текст попасть не должна.
    expect(d.content[0].content[0].content[0].content[0].text).toBe("сделано");
  });

  it("вложенный список уходит внутрь пункта", () => {
    const d = doc("- верх\n  - низ");
    const top = d.content[0].content[0];
    expect(top.content).toHaveLength(2);
    expect(top.content[1].type).toBe("bulletList");
  });

  it("текст после списка остаётся отдельным абзацем", () => {
    const d = doc("- пункт\n\nПосле.");
    expect(d.content).toHaveLength(2);
    expect(d.content[1].type).toBe("paragraph");
  });
});

describe("markdownToTiptap: инлайн", () => {
  const marksOf = (md: string) => doc(md).content[0].content[0].marks?.[0]?.type;

  it("жирный", () => expect(marksOf("**текст**")).toBe("bold"));
  it("курсив", () => expect(marksOf("*текст*")).toBe("italic"));
  it("курсив подчёркиванием", () => expect(marksOf("_текст_")).toBe("italic"));
  it("зачёркнутый", () => expect(marksOf("~~текст~~")).toBe("strike"));
  it("маркер", () => expect(marksOf("==текст==")).toBe("highlight"));
  it("инлайн-код", () => expect(marksOf("`код`")).toBe("code"));

  it("ссылка несёт href", () => {
    const n = doc("[туда](https://ya.ru)").content[0].content[0];
    expect(n.text).toBe("туда");
    expect(n.marks[0]).toMatchObject({
      type: "link",
      attrs: { href: "https://ya.ru" },
    });
  });

  it("смешанный текст режется на куски", () => {
    const c = doc("до **жир** после").content[0].content;
    expect(c).toHaveLength(3);
    expect(c[0].text).toBe("до ");
    expect(c[1].marks[0].type).toBe("bold");
    expect(c[2].text).toBe(" после");
  });

  it("экранированные символы возвращаются как есть", () => {
    // tiptapToMarkdown экранирует «5 * 3», чтобы не вышло курсива.
    expect(doc("5 \\* 3").content[0].content[0].text).toBe("5 * 3");
  });

  it("звёздочки внутри инлайн-кода не считаются разметкой", () => {
    const n = doc("`a * b`").content[0].content[0];
    expect(n.text).toBe("a * b");
    expect(n.marks[0].type).toBe("code");
  });
});

describe("deriveTitleFromMarkdown", () => {
  it("берёт первую значимую строку", () => {
    expect(deriveTitleFromMarkdown("# Заголовок\n\nтекст")).toBe("Заголовок");
  });

  it("пропускает пустые строки и забор кода", () => {
    expect(deriveTitleFromMarkdown("\n\n```\nкод\n```\nПосле")).toBe("После");
  });

  it("снимает разметку цитаты", () => {
    expect(deriveTitleFromMarkdown("> цитата")).toBe("цитата");
  });

  it("пустой вход — пустая строка", () => {
    expect(deriveTitleFromMarkdown("")).toBe("");
  });
});

describe("круговой прогон markdown → TipTap → markdown", () => {
  // Ловит рассогласование двух конвертеров. Именно так 26.08.2026
  // нашлась лишняя косая: обычная точка в конце предложения уезжала в
  // файл как «предложение\\.», потому что escapeMd экранировал . - + # ( )
  // — символы, которые значат что-то лишь в НАЧАЛЕ строки.
  const round = (md: string) => tiptapToMarkdown(markdownToTiptap(md)).trim();

  it("обычный текст возвращается без добавленных косых", () => {
    for (const src of [
      "Обычный текст с точкой.",
      "Диапазон 5 - 3, скобки (важно), решётка #1",
      "Заметку создал агент через `taskflow_doc_write`.",
      "**жирный** и *курсив*.",
    ]) {
      expect(round(src)).toBe(src);
    }
  });

  it("спецсимволы экранируются, но текст сохраняется", () => {
    // Одиночная звёздочка и обратная косая ОБЯЗАНЫ экранироваться, иначе
    // при следующем чтении станут разметкой. Побайтового совпадения тут
    // не ждём — проверяем, что сам текст не изменился.
    for (const src of ["5 * 3 = 15", "путь C:\\Users\\max"]) {
      const once = round(src);
      expect(round(once)).toBe(once); // повторный круг ничего не портит
      expect(plainText(markdownToTiptap(src))).toBe(
        plainText(markdownToTiptap(once)),
      );
    }
  });

  it("структура переживает круг", () => {
    const src = [
      "# Заголовок",
      "",
      "- [x] сделано",
      "- [ ] нет",
      "",
      "> цитата",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n");
    expect(round(src)).toBe(src);
  });
});

describe("markdownToTiptap: таблицы", () => {
  const round = (md: string) => tiptapToMarkdown(markdownToTiptap(md)).trim();
  const md = [
    "| Роль | Что делает |",
    "|---|---|",
    "| Researcher | Ищет источники |",
    "| Analyst | Считает выводы |",
  ].join("\n");

  it("собирает строки в один узел таблицы", () => {
    const d = doc(md);
    expect(d.content).toHaveLength(1);
    const table = d.content[0];
    expect(table.type).toBe("table");
    expect(table.content).toHaveLength(3);
    expect(table.content[0].content[0].type).toBe("tableHeader");
    expect(table.content[1].content[0].type).toBe("tableCell");
    expect(table.content[1].content[0].content[0].content[0].text).toBe(
      "Researcher",
    );
  });

  it("строка короче шапки дополняется пустыми ячейками", () => {
    const d = doc("| a | b | c |\n|---|---|---|\n| 1 |");
    expect(d.content[0].content[1].content).toHaveLength(3);
  });

  it("экранированная палка остаётся текстом ячейки", () => {
    const d = doc("| выражение |\n|---|\n| a \\| b |");
    expect(d.content[0].content[1].content[0].content[0].content[0].text).toBe(
      "a | b",
    );
  });

  it("палки без строки-разделителя таблицей не считаются", () => {
    const d = doc("| просто текст с палками |");
    expect(d.content[0].type).toBe("paragraph");
  });

  it("таблица переживает круг", () => {
    expect(round(md)).toBe(md);
  });
});
/** Весь текст документа подряд — для сравнения «по смыслу». */
function plainText(json: string): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (typeof n?.text === "string") out.push(n.text);
    (n?.content || []).forEach(walk);
  };
  walk(JSON.parse(json));
  return out.join("");
}
