import { describe, it, expect } from "vitest";
import { tiptapToMarkdown, safeFileName } from "./tiptapToMarkdown";

/** Короткая сборка документа TipTap для тестов. */
const doc = (...content: unknown[]) => JSON.stringify({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: { type: string; attrs?: unknown }[]) => ({
  type: "text",
  text,
  ...(marks ? { marks } : {}),
});

describe("tiptapToMarkdown", () => {
  it("пустой ввод не роняет и даёт пустую строку", () => {
    expect(tiptapToMarkdown(null)).toBe("");
    expect(tiptapToMarkdown("")).toBe("");
    expect(tiptapToMarkdown("   ")).toBe("");
    expect(tiptapToMarkdown(doc())).toBe("");
  });

  it("не-JSON отдаётся как есть — старые записи могли быть текстом", () => {
    expect(tiptapToMarkdown("просто текст")).toBe("просто текст");
  });

  it("заголовки по уровням, глубже 6 не уходит", () => {
    expect(
      tiptapToMarkdown(
        doc({ type: "heading", attrs: { level: 2 }, content: [t("Заголовок")] }),
      ),
    ).toBe("## Заголовок");
    expect(
      tiptapToMarkdown(
        doc({ type: "heading", attrs: { level: 9 }, content: [t("Глубоко")] }),
      ),
    ).toBe("###### Глубоко");
  });

  it("абзацы разделяются пустой строкой", () => {
    expect(tiptapToMarkdown(doc(p(t("Первый")), p(t("Второй"))))).toBe(
      "Первый\n\nВторой",
    );
  });

  it("инлайн-форматирование", () => {
    expect(
      tiptapToMarkdown(doc(p(t("жирный", [{ type: "bold" }])))),
    ).toBe("**жирный**");
    expect(
      tiptapToMarkdown(doc(p(t("курсив", [{ type: "italic" }])))),
    ).toBe("*курсив*");
    expect(
      tiptapToMarkdown(doc(p(t("зачёркнут", [{ type: "strike" }])))),
    ).toBe("~~зачёркнут~~");
    // ==выделение== — синтаксис Obsidian, ради него всё и затевалось.
    expect(
      tiptapToMarkdown(doc(p(t("маркер", [{ type: "highlight" }])))),
    ).toBe("==маркер==");
  });

  it("внутри инлайн-кода markdown не экранируется", () => {
    expect(
      tiptapToMarkdown(doc(p(t("a*b*c", [{ type: "code" }])))),
    ).toBe("`a*b*c`");
  });

  it("ссылка оборачивает уже отформатированный текст", () => {
    expect(
      tiptapToMarkdown(
        doc(
          p(
            t("тут", [
              { type: "bold" },
              { type: "link", attrs: { href: "https://e.com" } },
            ]),
          ),
        ),
      ),
    ).toBe("[**тут**](https://e.com)");
  });

  it("маркированный список", () => {
    expect(
      tiptapToMarkdown(
        doc({
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(t("раз"))] },
            { type: "listItem", content: [p(t("два"))] },
          ],
        }),
      ),
    ).toBe("- раз\n- два");
  });

  it("нумерованный список считает от start", () => {
    expect(
      tiptapToMarkdown(
        doc({
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            { type: "listItem", content: [p(t("третий"))] },
            { type: "listItem", content: [p(t("четвёртый"))] },
          ],
        }),
      ),
    ).toBe("3. третий\n4. четвёртый");
  });

  it("чек-лист даёт - [ ] и - [x]", () => {
    expect(
      tiptapToMarkdown(
        doc({
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [p(t("сделано"))],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [p(t("нет"))],
            },
          ],
        }),
      ),
    ).toBe("- [x] сделано\n- [ ] нет");
  });

  it("вложенный список отбивается двумя пробелами", () => {
    expect(
      tiptapToMarkdown(
        doc({
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                p(t("внешний")),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [p(t("внутренний"))] }],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("- внешний\n  - внутренний");
  });

  it("цитата и горизонтальная черта", () => {
    expect(
      tiptapToMarkdown(
        doc({ type: "blockquote", content: [p(t("цитата"))] }, {
          type: "horizontalRule",
        }),
      ),
    ).toBe("> цитата\n\n---");
  });

  it("блок кода сохраняет язык", () => {
    expect(
      tiptapToMarkdown(
        doc({
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;" }],
        }),
      ),
    ).toBe("```ts\nconst a = 1;\n```");
  });

  it("звёздочки в обычном тексте экранируются, а не форматируют", () => {
    expect(tiptapToMarkdown(doc(p(t("5 * 3 = 15"))))).toBe("5 \\* 3 = 15");
  });

  it("неизвестный узел не роняет экспорт — берётся текст детей", () => {
    expect(
      tiptapToMarkdown(
        doc({ type: "какой-тоНовыйУзел", content: [p(t("внутри"))] }),
      ),
    ).toBe("внутри");
  });

  it("hardBreak переносит строку внутри абзаца", () => {
    expect(
      tiptapToMarkdown(doc(p(t("первая"), { type: "hardBreak" }, t("вторая")))),
    ).toBe("первая\nвторая");
  });
});

describe("safeFileName", () => {
  it("добавляет .md", () => {
    expect(safeFileName("Планы")).toBe("Планы.md");
  });

  it("вычищает запрещённые в файловых системах символы", () => {
    expect(safeFileName('от 26/08 <тест>: "да"')).toBe(
      "от 26-08 -тест-- -да-.md",
    );
  });

  it("пустое название подменяется запасным", () => {
    expect(safeFileName("")).toBe("Заметка.md");
    expect(safeFileName("   ")).toBe("Заметка.md");
  });

  it("длинное название обрезается", () => {
    expect(safeFileName("я".repeat(200))).toBe(`${"я".repeat(80)}.md`);
  });
});