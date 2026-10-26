import { describe, expect, it } from "vitest";
import { chatBlocks, chatBlocksCached, jsonWithTextBlocks, ownerText, preparationWithBlocks, sourcedChatBlocks, withTextBlocks } from "../src/lib/chatBlocks.js";

describe("chatBlocks: ответ готовыми блоками (правило ChatRichContent из iOS)", () => {
  it("обычный текст — один документ TipTap с разметкой", () => {
    const [b] = chatBlocks("Привет, **мир**\n\n- раз\n- два");
    expect(b.type).toBe("doc");
    const doc = (b as any).doc;
    expect(doc.type).toBe("doc");
    expect(JSON.stringify(doc)).toContain('"bold"');
    expect(JSON.stringify(doc)).toContain("bulletList");
  });

  it("таблица — отдельным блоком с выравниванием и ячейками-строками TipTap", () => {
    const blocks = chatBlocks("До\n\n| a | b |\n|:--|--:|\n| **x** | y |\n\nПосле");
    expect(blocks.map((b) => b.type)).toEqual(["doc", "table", "doc"]);
    const t = blocks[1] as any;
    expect(t.align).toEqual(["leading", "trailing"]);
    expect(t.header[0][0].text).toBe("a");
    expect(t.rows[0][0][0]).toMatchObject({ text: "x", marks: [{ type: "bold" }] });
  });

  it("виджет, tf-json и html — своими блоками; код остаётся текстом", () => {
    const text = "```widget\n{\"type\":\"metrics\"}\n```\n```tf-json\n{\"ok\":true}\n```\n```html\n<b>1</b>\n```\n```bash\nls\n```";
    expect(chatBlocks(text)).toMatchObject([
      { type: "widget", json: '{"type":"metrics"}' },
      { type: "structured_json", json: '{"ok":true}' },
      { type: "html", html: "<b>1</b>" },
      { type: "doc" },
    ]);
  });

  it("незакрытый блок в идущем ответе — заглушка, в готовом — блок как есть", () => {
    expect(chatBlocks("```widget\n{\"type\"", true)).toEqual([{ type: "pending", kind: "widget" }]);
    expect(chatBlocks("```tf-json\n{\"output\"", true)).toEqual([{ type: "structured_json_streaming", json: '{"output"' }]);
    expect(chatBlocks("```widget\n{\"type\"", false)).toEqual([{ type: "widget", json: '{"type"' }]);
  });

  it("пустой текст — нет блоков; кэш отдаёт тот же результат", () => {
    expect(chatBlocks("  \n ")).toEqual([]);
    expect(chatBlocksCached("Текст")).toEqual(chatBlocks("Текст"));
  });

  it("в живом ходе у блока — исходный кусок; готовые сообщения его не несут", () => {
    const text = "Итог:\n```widget\n{\"type\":\"metrics\"}\n```\n| a | b |\n|---|---|\n| 1 | 2 |\nконец";
    const blocks = sourcedChatBlocks(text, true);
    expect(blocks.map((b) => b.type)).toEqual(["doc", "widget", "table", "doc"]);
    expect(blocks.map((b) => b.source)).toEqual(["Итог:", "```widget\n{\"type\":\"metrics\"}\n```", "| a | b |\n|---|---|\n| 1 | 2 |", "конец"]);
    expect(chatBlocks(text).some((b) => "source" in b)).toBe(false);
  });

  it("размеченный текст внутри JSON получает готовые блоки, исходные поля не меняются", () => {
    const envelope = { output: [{ type: "text", text: "**да**" }, { type: "list", items: ["a"] }] };
    const out = withTextBlocks(envelope) as any;
    expect(out.output[0].text).toBe("**да**");
    expect(out.output[0].text_blocks[0].type).toBe("doc");
    expect(out.output[1].text_blocks).toBeUndefined();
    expect((withTextBlocks({ summary: "итог", note_id: "n" }, ["summary"]) as any).summary_blocks[0].type).toBe("doc");
    expect((withTextBlocks({ summary: "итог" }) as any).summary_blocks).toBeUndefined();
    expect(withTextBlocks(null)).toBeNull();
    expect(envelope.output[0]).not.toHaveProperty("text_blocks");
  });

  it("виджет и tf-json в ответе несут блоки для body и текстовых блоков", () => {
    const [w] = chatBlocks("```widget\n{\"type\":\"card\",\"body\":\"**жирно**\"}\n```");
    expect(JSON.parse((w as any).json).body_blocks[0].type).toBe("doc");
    expect(jsonWithTextBlocks("{не json")).toBe("{не json");
  });

  it("текст роли для владельца — как AgentTextSanitizer в iOS", () => {
    expect(ownerText("changes_requested:  D1 нужен taskflow_plan_request")).toBe("D1 нужен команда добавить слот в план");
    expect(ownerText("обычный текст")).toBe("обычный текст");
  });

  it("подготовка: вопрос и результаты направлений получают блоки", () => {
    const out = preparationWithBlocks({ question: "Что **важнее**?", card: { preparation: { question: "q", workstreams: [{ key: "a", result: "- пункт" }] } } });
    expect(out.question_blocks[0].type).toBe("doc");
    expect(out.card.preparation.question_blocks[0].type).toBe("doc");
    expect(out.card.preparation.workstreams[0].result_blocks[0].type).toBe("doc");
    expect(preparationWithBlocks(null)).toBeNull();
  });
});
