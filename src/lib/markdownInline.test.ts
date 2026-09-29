import { describe, it, expect } from "vitest";
import { renderInlineMarkdown } from "./markdownInline";

describe("renderInlineMarkdown: базовые случаи", () => {
  it("пустая строка → пустая строка", () => {
    expect(renderInlineMarkdown("")).toBe("");
  });

  it("null/undefined → пустая строка", () => {
    expect(renderInlineMarkdown(null)).toBe("");
    expect(renderInlineMarkdown(undefined)).toBe("");
  });

  it("обычный текст без разметки остаётся как есть", () => {
    expect(renderInlineMarkdown("Просто текст задачи")).toBe(
      "Просто текст задачи",
    );
  });

  it("жирный через ** превращается в <strong>", () => {
    expect(renderInlineMarkdown("Это **жирный** текст")).toBe(
      "Это <strong>жирный</strong> текст",
    );
  });

  it("жирный через __", () => {
    expect(renderInlineMarkdown("Это __жирный__ текст")).toBe(
      "Это <strong>жирный</strong> текст",
    );
  });

  it("курсив через * превращается в <em>", () => {
    expect(renderInlineMarkdown("Это *курсивный* текст")).toBe(
      "Это <em>курсивный</em> текст",
    );
  });

  it("курсив через _", () => {
    expect(renderInlineMarkdown("Это _курсивный_ текст")).toBe(
      "Это <em>курсивный</em> текст",
    );
  });

  it("инлайн-код в бэктиках", () => {
    expect(renderInlineMarkdown("См. `npm install`")).toBe(
      'См. <code class="md-inline-code">npm install</code>',
    );
  });

  it("ссылка [текст](https://…) с безопасным протоколом", () => {
    expect(renderInlineMarkdown("Открыть [доку](https://example.com)")).toBe(
      'Открыть <a class="md-inline-link" href="https://example.com" target="_blank" rel="noopener noreferrer">доку</a>',
    );
  });
});

describe("renderInlineMarkdown: граничные случаи", () => {
  it("непарные звёздочки НЕ превращаются в <em>", () => {
    expect(renderInlineMarkdown("цена: * 3 = 15")).toBe("цена: * 3 = 15");
  });

  it("непарный квадратной скобки → обычный текст", () => {
    expect(renderInlineMarkdown("Текст [без закрытия")).toBe(
      "Текст [без закрытия",
    );
  });

  it("пустой URL в ссылке остаётся обычным текстом (не ссылка)", () => {
    // Намеренно НЕ превращаем в `<a href="">` — это могло бы
    // перезагрузить текущую страницу при клике. Скобки/пустой URL —
    // обычный текст.
    const out = renderInlineMarkdown("[доку]()");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href");
  });

  it("жирный, вложенный в курсив, рендерится в правильном порядке", () => {
    // ** идёт до *, поэтому жирный собирается раньше, потом курсив.
    expect(renderInlineMarkdown("***foo***")).toBe("<em><strong>foo</strong></em>");
  });

  it("бэктики НЕ превращают * внутри в курсив", () => {
    expect(renderInlineMarkdown("`*a*b*`")).toBe(
      '<code class="md-inline-code">*a*b*</code>',
    );
  });

  it("перевод строки внутри бэктиков не считается концом кода", () => {
    // Многострочный код мы не поддерживаем; перевод строки разрывает.
    const out = renderInlineMarkdown("См. `npm\ninstall`");
    expect(out).not.toContain("<code");
  });

  it("жирный не пересекает строки (одна строка = один title)", () => {
    expect(renderInlineMarkdown("**первая\nвторая**")).toBe(
      "**первая\nвторая**",
    );
  });

  // Регрессия: опечатка `* *` оставляла пустой <em>, который в строке
  // выглядел как «невидимый курсив» и ломал line-clamp.
  it("пустой/пробельный курсив с * не курсивится", () => {
    expect(renderInlineMarkdown("* *")).toBe("* *");
    expect(renderInlineMarkdown("*   *")).toBe("*   *");
    expect(renderInlineMarkdown("* foo *")).toBe("* foo *");
  });

  // Регрессия: `_1_` превращался в <em>1</em>, и цифра в названии задачи
  // уходила в наклонный шрифт, выбиваясь из строки.
  it("курсив только из цифр не курсивится", () => {
    expect(renderInlineMarkdown("_1_")).toBe("_1_");
    expect(renderInlineMarkdown("_42_")).toBe("_42_");
    expect(renderInlineMarkdown("*7*")).toBe("*7*");
  });

  // Курсив из букв по-прежнему работает.
  it("курсив из букв по-прежнему работает", () => {
    expect(renderInlineMarkdown("слово _между_ подчёркиваниями")).toBe(
      "слово <em>между</em> подчёркиваниями",
    );
    expect(renderInlineMarkdown("a *x* b")).toBe("a <em>x</em> b");
    // Буква + цифра — тоже разметка, не число.
    expect(renderInlineMarkdown("_v2_")).toBe("<em>v2</em>");
  });
});

describe("renderInlineMarkdown: XSS и экранирование", () => {
  it("& экранируется в &amp;", () => {
    expect(renderInlineMarkdown("A & B")).toBe("A &amp; B");
  });

  it("<script> экранируется в &lt;script&gt;", () => {
    expect(renderInlineMarkdown("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("<img onerror=…> экранируется целиком", () => {
    const out = renderInlineMarkdown('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&quot;");
  });

  it("javascript: в URL ссылки отбрасывается, текст остаётся", () => {
    const out = renderInlineMarkdown("[вредная](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href");
    expect(out).toContain("вредная");
  });

  it("data: URL отбрасывается", () => {
    const out = renderInlineMarkdown("[доку](data:text/html,<script>1</script>)");
    expect(out).not.toContain("<a");
  });

  it("mailto: разрешён", () => {
    expect(renderInlineMarkdown("[почта](mailto:a@b.c)")).toContain("href=\"mailto:a@b.c\"");
  });
});

describe("renderInlineMarkdown: совместимость с типичными названиями задач", () => {
  it("обычное название без спецсимволов — не меняется", () => {
    expect(renderInlineMarkdown("Сделать отчёт за Q3")).toBe(
      "Сделать отчёт за Q3",
    );
  });

  it("название с эмодзи и знаками препинания — не ломается", () => {
    expect(renderInlineMarkdown("🔥 Горит — срочно сделать!")).toBe(
      "🔥 Горит — срочно сделать!",
    );
  });

  it("название с математикой `5 * 3` остаётся читаемым", () => {
    expect(renderInlineMarkdown("Посчитать 5 * 3 = 15")).toBe(
      "Посчитать 5 * 3 = 15",
    );
  });

  it("описание с комбинацией разметки", () => {
    expect(
      renderInlineMarkdown(
        "**Срочно**: см. [тред](https://ex.com) и `npm test`",
      ),
    ).toBe(
      '<strong>Срочно</strong>: см. <a class="md-inline-link" href="https://ex.com" target="_blank" rel="noopener noreferrer">тред</a> и <code class="md-inline-code">npm test</code>',
    );
  });
});