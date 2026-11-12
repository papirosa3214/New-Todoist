import { describe, expect, it } from "vitest";
import {
  attachServerHtml,
  blocksFromMarkdown,
  CHAT_TEMPLATES_VERSION,
  renderBlockHtml,
  SERVER_HTML_FIELD,
  SERVER_HTML_MAX,
} from "../src/lib/chatTemplates.js";
import { normalizeRoleReplyV1, validateStructuredRoleContractV1 } from "../src/lib/roleContractV1.js";

// Серверные шаблоны чата: таблица, график и схема собираются на сервере, а
// блок остаётся с данными. Проверяем три вещи, которые легко сломать молча:
// экранирование данных модели, отсутствие разметки модели в атрибутах и
// предел объёма, при котором блок остаётся без `server_html` (клиент рисует
// нативно, и ничего не теряется).

const tableBlock = {
  type: "table",
  title: "Задачи",
  columns: ["Роль", "Закрыто"],
  rows: [["Исследователь", "2"], ["Разработчик", "3"]],
};

const chartBlock = {
  type: "chart",
  title: "Закрыто по дням",
  kind: "bar",
  unit: "задач",
  points: [
    { label: "пн", value: 4 },
    { label: "вт", value: 7 },
  ],
};

const diagramBlock = {
  type: "diagram",
  title: "Где встали",
  kind: "chain",
  items: [
    { label: "план", state: "done" },
    { label: "сдача", state: "blocked" },
  ],
};

describe("серверные шаблоны блоков", () => {
  it("таблица: все строки и колонки на месте, шапка отделена", () => {
    const html = renderBlockHtml(tableBlock)!;
    expect(html).toContain("Задачи");
    for (const value of ["Роль", "Закрыто", "Исследователь", "Разработчик"]) {
      expect(html).toContain(value);
    }
    expect(html.match(/<tr>/g)!.length).toBe(3); // шапка + две строки
    expect(html).toContain(`data-tpl="${CHAT_TEMPLATES_VERSION}"`);
  });

  it("экранирует текст модели и не пропускает разметку в атрибуты", () => {
    const html = renderBlockHtml({
      ...tableBlock,
      rows: [['<script>alert(1)</script>', '"onmouseover="alert(2)']],
    })!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Кавычка из данных модели не должна закрыть текстовый узел и завести атрибут.
    expect(html).toContain("&quot;onmouseover=&quot;alert(2)");
    expect(html).not.toContain('onmouseover="');
  });

  it("таблица без колонок не рисуется — блок остаётся данными", () => {
    expect(renderBlockHtml({ type: "table", rows: [["a"]] })).toBeNull();
  });

  it("график: по столбцу на точку, значения подписаны", () => {
    const html = renderBlockHtml(chartBlock)!;
    expect(html.match(/<rect x=/g)!.length).toBe(2);
    expect(html.match(/class="tfh-val"/g)!.length).toBe(2);
    expect(html).toContain("пн");
    expect(html).toContain("задач");
  });

  it("график: нечисловое значение читается как 0, а не как дыра в разметке", () => {
    const html = renderBlockHtml({
      ...chartBlock,
      points: [{ label: "пн", value: "не число" }, { label: "вт", value: 5 }],
    })!;
    expect(html).not.toContain("NaN");
    expect(html).toContain(">0</text>");
  });

  it("линейный график: ломаная и точки", () => {
    const html = renderBlockHtml({ ...chartBlock, kind: "line" })!;
    expect(html).toContain("<polyline");
    expect(html.match(/<circle /g)!.length).toBe(2);
  });

  it("схема: три вида, неизвестное состояние красится как «в очереди»", () => {
    for (const kind of ["chain", "ladder", "timeline"]) {
      expect(renderBlockHtml({ ...diagramBlock, kind })).toContain("<svg");
    }
    const unknown = renderBlockHtml({
      ...diagramBlock,
      items: [{ label: "шаг", state: "что-то" }],
    })!;
    expect(unknown).toContain("#6E7681");
  });

  it("ноль точек и пустая схема не рисуются", () => {
    expect(renderBlockHtml({ ...chartBlock, points: [] })).toBeNull();
    expect(renderBlockHtml({ ...diagramBlock, items: [] })).toBeNull();
  });

  it("вид, который сервер не рисует, не получает разметки", () => {
    expect(renderBlockHtml({ type: "text", text: "привет" })).toBeNull();
    expect(renderBlockHtml({ type: "command", command: "ls" })).toBeNull();
  });

  it("слишком большой блок остаётся без разметки — клиент рисует нативно", () => {
    const cell = "я".repeat(500);
    const html = renderBlockHtml({
      type: "table",
      title: "Огромная",
      columns: Array.from({ length: 12 }, (_, index) => `К${index}`),
      rows: Array.from({ length: 100 }, () => Array.from({ length: 12 }, () => cell)),
    });
    expect(html).toBeNull();
    // И заведомо влезающий блок не отбрасывается: предел не мешает обычным.
    expect(Buffer.byteLength(renderBlockHtml(tableBlock)!, "utf8")).toBeLessThan(SERVER_HTML_MAX);
  });
});

describe("разметка свободного ответа", () => {
  const markdown = [
    "## Итог",
    "",
    "Сделал три вещи, две проверены.",
    "",
    "| Роль | Закрыто |",
    "| --- | --- |",
    "| Исследователь | 2 |",
    "",
    "- [x] сборка",
    "- [ ] прогон на телефоне",
    "",
    "✅ тесты зелёные",
    "⚠️ нет доступа к .110",
    "",
    "```bash",
    "npm run build",
    "```",
    "",
    "https://github.com/maksim/taskflow-server/pull/87",
  ].join("\n");

  it("заголовок, текст, таблица, чекбоксы, статусы, команда и ссылка — разными блоками", () => {
    const blocks = blocksFromMarkdown(markdown);
    const types = blocks.map((block) => block.type);
    expect(types).toEqual([
      "heading", "text", "table", "status", "status", "status", "status", "command", "link",
    ]);
    expect(blocks[0]).toMatchObject({ type: "heading", text: "Итог", level: 2 });
    expect(blocks[2]).toMatchObject({ type: "table", columns: ["Роль", "Закрыто"], rows: [["Исследователь", "2"]] });
    expect(blocks[3]).toMatchObject({ code: "passed", title: "сборка" });
    expect(blocks[4]).toMatchObject({ code: "skipped", title: "прогон на телефоне" });
    expect(blocks[5]).toMatchObject({ code: "passed", title: "тесты зелёные" });
    expect(blocks[6]).toMatchObject({ code: "blocked", title: "нет доступа к .110" });
    expect(blocks[7]).toMatchObject({ type: "command", command: "npm run build" });
  });

  it("собранный конверт проходит валидатор, а не падает на нём", () => {
    const checked = validateStructuredRoleContractV1({
      schema_version: 1, ok: true, output: blocksFromMarkdown(markdown),
      artifacts: [], plan_artifact: null, error: null, next_hint: null, needs_human: false,
    });
    expect(checked.errors).toEqual([]);
    expect(checked.valid).toBe(true);
  });

  it("список нумерованный и маркированный различаются", () => {
    expect(blocksFromMarkdown("- раз\n- два")).toEqual([{ type: "list", items: ["раз", "два"], ordered: false }]);
    expect(blocksFromMarkdown("1. раз\n2. два")).toEqual([{ type: "list", items: ["раз", "два"], ordered: true }]);
  });

  it("чужой фенс кода остаётся текстом, а не превращается в команду", () => {
    const blocks = blocksFromMarkdown("```python\nprint(1)\n```");
    expect(blocks[0]!.type).toBe("text");
    expect(String(blocks[0]!.text)).toContain("print(1)");
  });

  it("обычный ответ остаётся одним текстовым блоком", () => {
    const blocks = blocksFromMarkdown("Просто две строки\nи всё.");
    expect(blocks).toEqual([{ type: "text", text: "Просто две строки\nи всё." }]);
  });

  it("ссылка внутри предложения не выдёргивается из текста", () => {
    const blocks = blocksFromMarkdown("Смотри https://example.com/статья и всё.");
    expect(blocks).toEqual([{ type: "text", text: "Смотри https://example.com/статья и всё." }]);
  });

  it("на границе чата свободный ответ раскладывается, а текст для показа не меняется", () => {
    const normalized = normalizeRoleReplyV1(markdown);
    expect(normalized.envelope.output.length).toBe(9);
    expect(normalized.displayText).toBe(markdown.trim());
    expect(normalized.normalizedByServer).toBe(true);
    // Таблица получила и данные, и готовую разметку от сервера.
    const table = normalized.envelope.output[2] as any;
    expect(table.type).toBe("table");
    expect(table.server_html).toContain("<table>");
  });
});

describe("разметка в конверте", () => {
  const envelope = {
    schema_version: 1 as const,
    ok: true,
    output: [tableBlock, { type: "text", text: "пояснение" }, chartBlock, diagramBlock],
    artifacts: [],
    plan_artifact: null,
    error: null,
    next_hint: null,
    needs_human: false,
  };

  it("раскладывает разметку по своим блокам и не трогает остальные", () => {
    const filled = attachServerHtml(envelope);
    expect(filled.output.filter((block: any) => block[SERVER_HTML_FIELD]).length).toBe(3);
    expect((filled.output[1] as any)[SERVER_HTML_FIELD]).toBeUndefined();
    expect((filled.output[0] as any).type).toBe("table");
    expect(filled.output.length).toBe(envelope.output.length);
  });

  it("идемпотентно: второй проход даёт то же самое", () => {
    const once = attachServerHtml(envelope);
    const twice = attachServerHtml(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("ответ модели с готовым server_html по-прежнему не проходит валидатор", () => {
    const modelSupplied = {
      ...envelope,
      output: [{ ...tableBlock, [SERVER_HTML_FIELD]: "<b>свой html</b>" }],
    };
    const checked = validateStructuredRoleContractV1(modelSupplied);
    expect(checked.valid).toBe(false);
    expect(checked.errors.join(" ")).toContain("server_html");
    expect(checked.errors.join(" ")).toContain("поле не разрешено");
  });

  it("на границе чата конверт приходит с разметкой, текст для показа не меняется", () => {
    const reply = JSON.stringify({
      ...envelope,
      output: [chartBlock, { type: "text", text: "Готово." }],
    });
    const normalized = normalizeRoleReplyV1(reply);
    const chart = normalized.envelope.output[0] as any;
    expect(chart.type).toBe("chart");
    expect(chart.server_html).toContain("<svg");
    expect(normalized.displayText).toContain("Закрыто по дням");
    expect(normalized.displayText).toContain("Готово.");
  });

  it("обычный текст без конверта не получает разметки вообще", () => {
    const normalized = normalizeRoleReplyV1("Просто ответ роли без JSON.");
    expect(normalized.envelope.output.length).toBe(1);
    expect((normalized.envelope.output[0] as any)[SERVER_HTML_FIELD]).toBeUndefined();
    expect(normalized.displayText).toBe("Просто ответ роли без JSON.");
  });
});
