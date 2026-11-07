// Юнит-тесты безопасной компакции Pi (25.10.2026).
//
// Запрос выжимки уходил одним большим текстом и ронялся по таймауту
// провайдера («Request timed out.»), а мы шли дальше на сырой истории — и ход
// роли умирал уже на запросе к модели. Теперь запрос ужимается, а если выжимка
// не вышла — пишем локальную выжимку и продолжаем ход.
import { describe, expect, it } from "vitest";
import {
  COMPACTION_INSTRUCTIONS,
  DEFAULT_COMPACTION_LIMITS,
  buildLocalSummary,
  compactSessionSafely,
  measureMessages,
  planHistoryTrim,
  repairToolPairs,
  trimMessage,
  truncateText,
} from "../src/runtime/compactionFallback.js";

const LIMITS = {
  ...DEFAULT_COMPACTION_LIMITS,
  targetContextChars: 2_000,
  minMessageChars: 50,
  maxMessageChars: 200,
  goalChars: 120,
  recentMessages: 3,
  recentChars: 200,
  roleChars: { user: 120, assistant: 200, toolResult: 80 },
  thinkingChars: 40,
  toolCallArgsChars: 60,
  localKeepMessages: 3,
};

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });

/** Менеджер сессии: повторяет контракт Pi (ветка, compaction-запись, контекст). */
class FakeManager {
  entries: any[];
  constructor(messages: any[]) {
    this.entries = messages.map((message, index) => ({
      type: "message",
      id: `e${index}`,
      parentId: index ? `e${index - 1}` : null,
      timestamp: "2026-10-25T12:00:00.000Z",
      message,
    }));
  }
  getBranch() {
    return this.entries;
  }
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number) {
    this.entries.push({
      type: "compaction",
      id: `c${this.entries.length}`,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: "2026-10-25T12:30:00.000Z",
      summary,
      firstKeptEntryId,
      tokensBefore,
    });
  }
  buildSessionContext() {
    const compaction = [...this.entries].reverse().find((entry) => entry.type === "compaction");
    if (!compaction) {
      return { messages: this.entries.filter((entry) => entry.type === "message").map((entry) => entry.message) };
    }
    const index = this.entries.findIndex((entry) => entry.id === compaction.id);
    const kept = this.entries
      .slice(0, index)
      .filter((entry) => entry.type === "message" && entry.id >= compaction.firstKeptEntryId)
      .map((entry) => entry.message);
    const after = this.entries.slice(index + 1).filter((entry) => entry.type === "message").map((entry) => entry.message);
    return {
      messages: [
        { role: "compactionSummary", summary: compaction.summary, tokensBefore: compaction.tokensBefore },
        ...kept,
        ...after,
      ],
    };
  }
}

function makeSession(messages: any[]) {
  const sessionManager = new FakeManager(messages);
  const session: any = { sessionManager, agent: { state: { messages: [...messages] } }, compactCalls: 0 };
  session.compact = async (instructions?: string) => {
    session.compactCalls += 1;
    session.lastInstructions = instructions;
    if (session.compactError) throw session.compactError;
    sessionManager.appendCompaction("выжимка от модели", "e0", 100);
    session.agent.state.messages = sessionManager.buildSessionContext().messages;
  };
  return session;
}

describe("урез запроса", () => {
  it("обрезает текст и помечает, сколько выкинули", () => {
    const cut = truncateText("а".repeat(500), 100);
    expect(cut.length).toBeLessThanOrEqual(140);
    expect(cut).toContain("обрезано 400 симв.");
    expect(truncateText("коротко", 100)).toBe("коротко");
  });

  it("держит цель и последние ходы, режет старые нагрузки инструментов", () => {
    const messages = [
      user("ЦЕЛЬ: починить компакцию"),
      assistant("а".repeat(4_000)),
      toolResult("вывод ls: ".concat("b".repeat(8_000))),
      assistant("последний ответ роли: сделано"),
    ];
    const plan = planHistoryTrim(messages, LIMITS);
    expect(plan.truncatedMessages).toBeGreaterThan(0);
    expect(plan.charsAfter).toBeLessThan(plan.charsBefore);
    expect(JSON.stringify(plan.messages[0])).toContain("ЦЕЛЬ: починить компакцию");
    expect(JSON.stringify(plan.messages.at(-1))).toContain("последний ответ роли: сделано");
    expect(JSON.stringify(plan.messages[2]).length).toBeLessThan(1_000);
  });

  it("размышления выкидывает целиком, аргументы вызова режет, JSON остаётся валидным", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "c".repeat(500), thinkingSignature: "sig" },
        { type: "text", text: "ответ" },
        { type: "toolCall", id: "t1", name: "taskflow", arguments: { operation: "doc_write", markdown: "x".repeat(5_000) } },
      ],
    };
    const trimmed = trimMessage(message, { cap: 100, thinking: 40, toolCallArgs: 60 });
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.message.content.some((block: any) => block.type === "thinking")).toBe(false);
    expect(trimmed.message.content.some((block: any) => block.text === "ответ")).toBe(true);
    const args = trimmed.message.content.find((block: any) => block.type === "toolCall").arguments;
    expect(args.operation).toBe("doc_write");
    expect(JSON.parse(JSON.stringify(args)).markdown.length).toBeLessThan(120);
  });
});

describe("локальная выжимка без модели", () => {
  it("сохраняет цель и последний ответ роли", () => {
    const summary = buildLocalSummary(
      [user("ЦЕЛЬ: починить компакцию сессии"), assistant("сделал часть работы"), toolResult("вывод")],
      LIMITS,
    );
    expect(summary).toContain("ЦЕЛЬ: починить компакцию сессии");
    expect(summary).toContain("сделал часть работы");
  });

  it("в выжимку попадают хвост диалога и перечень инструментов", () => {
    const summary = buildLocalSummary(
      [
        user("ЦЕЛЬ: разобрать выжимку"),
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "вывод" }] },
        assistant("проверил лог, нашёл причину"),
        user("дальше что"),
      ],
      LIMITS,
    );
    expect(summary).toContain("Хвост диалога");
    expect(summary).toContain("проверил лог, нашёл причину");
    expect(summary).toContain("bash×1");
    expect(summary).toContain("вызовов инструментов: 1");
  });
});

describe("безопасная компакция", () => {
  it("штатная выжимка проходит — инструкция передана, ход продолжается", async () => {
    const session = makeSession([user("ЦЕЛЬ"), assistant("ответ")]);
    const outcome = await compactSessionSafely(session, { label: "тест", limits: LIMITS });
    expect(outcome.mode).toBe("compacted");
    expect(session.compactCalls).toBe(1);
    expect(session.lastInstructions).toBe(COMPACTION_INSTRUCTIONS);
  });

  it("выжимка упала по таймауту — включается локальный урез, ход не падает", async () => {
    const messages = [
      user("ЦЕЛЬ: починить компакцию сессии"),
      assistant("старое рассуждение".repeat(50)),
      toolResult("вывод инструмента".repeat(200)),
      assistant("свежий ответ роли"),
    ];
    const session = makeSession(messages);
    session.compactError = new Error("Request timed out.");
    const outcome = await compactSessionSafely(session, { label: "тест", limits: LIMITS });
    expect(outcome.mode).toBe("fallback");
    expect(outcome.error).toContain("Request timed out.");
    const compaction = session.sessionManager.entries.find((entry: any) => entry.type === "compaction");
    expect(compaction).toBeTruthy();
    expect(compaction.summary).toContain("ЦЕЛЬ: починить компакцию сессии");
    // В модель уходит маленький контекст, но свежий ход и цель на месте.
    const context = session.agent.state.messages;
    expect(measureMessages(context).chars).toBeLessThan(measureMessages(messages).chars);
    expect(JSON.stringify(context)).toContain("свежий ответ роли");
    expect(JSON.stringify(context)).toContain("ЦЕЛЬ: починить компакцию сессии");
  });

  it("«нечего сжимать» — это не поломка: локальный урез не включается", async () => {
    const session = makeSession([user("коротко")]);
    session.compactError = new Error("Nothing to compact (session too small)");
    const outcome = await compactSessionSafely(session, { label: "тест", limits: LIMITS });
    expect(outcome.mode).toBe("skipped");
    expect(session.sessionManager.entries.some((entry: any) => entry.type === "compaction")).toBe(false);
  });

  it("тяжёлый вход: запрос выжимки к модели не отправляем, режем локально", async () => {
    const messages = [
      user("ЦЕЛЬ: разобрать выжимку"),
      assistant("старое рассуждение".repeat(50)),
      toolResult("вывод инструмента".repeat(200)),
      assistant("свежий ответ роли"),
    ];
    const session = makeSession(messages);
    const outcome = await compactSessionSafely(session, {
      label: "тест",
      limits: { ...LIMITS, maxCompactInputChars: 2_000 },
    });
    expect(outcome.mode).toBe("fallback");
    expect(session.compactCalls).toBe(0); // модель не дёргали вообще
    expect(outcome.error).toContain("too large");
    const compaction = session.sessionManager.entries.find((entry: any) => entry.type === "compaction");
    expect(compaction).toBeTruthy();
    expect(compaction.summary).toContain("ЦЕЛЬ: разобрать выжимку");
    expect(measureMessages(session.agent.state.messages).chars).toBeLessThan(measureMessages(messages).chars);
  });
});

describe("пары «вызов — результат» (провайдер отклоняет сиротский результат)", () => {
  it("результат без вызова уходит, вызов без результата уходит, целая пара остаётся", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call_ok", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "call_ok", toolName: "bash", content: [{ type: "text", text: "ok" }] },
      { role: "toolResult", toolCallId: "call_orphan", toolName: "bash", content: [{ type: "text", text: "сирота" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "call_pending", name: "bash", arguments: {} }] },
    ];
    const repaired = repairToolPairs(messages);
    expect(repaired.some((m: any) => m.role === "toolResult" && m.toolCallId === "call_orphan")).toBe(false);
    expect(repaired.some((m: any) => m.role === "assistant" && m.content?.some((b: any) => b.id === "call_pending"))).toBe(false);
    expect(repaired.some((m: any) => m.role === "toolResult" && m.toolCallId === "call_ok")).toBe(true);
    expect(repaired.some((m: any) => m.role === "assistant" && m.content?.some((b: any) => b.id === "call_ok"))).toBe(true);
  });

  it("сообщение без вызовов и результатов не теряется", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "привет" }] }];
    expect(repairToolPairs(messages)).toHaveLength(1);
  });
});
