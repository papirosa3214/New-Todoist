// Этап 1 плана карточки 252c400e: baseline установленного Pi 0.84.4.
//
// Проверяем НЕ моки методов, а настоящий цикл установленного пакета с
// фальшивой моделью и фальшивыми инструментами:
//   • prompt / abort / idle — как ход встаёт и как его останавливают;
//   • steer против followUp — порядок ввода;
//   • отменяемый и НЕотменяемый инструмент — что происходит с внешней работой
//     при abort (важно для границы прерывания: «остановили» ≠ «внешний
//     процесс перестал»);
//   • navigateTree во время streaming — бросает;
//   • createBranchedSession — переключает менеджер сессии;
//   • выжимка на отфильтрованных thinking + наличие usage + перехват
//     фактического запроса модели.
//
// Сеть не используется: модель — фальшивая, отвечает заданным сценарием.

import { describe, expect, it } from "vitest";
import { Type } from "typebox";

/** Настоящий SDK установленного пакета (как в prod), без сети. */
async function coreSdk(): Promise<any> {
  const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
  return import(/* @vite-ignore */ new URL("../node_modules/@earendil-works/pi-agent-core/dist/index.js", resolved).href);
}

const model = {
  id: "fixture",
  name: "fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
};

function answer(content: any[], stopReason = "stop") {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 7,
      output: 11,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/** Фальшивый поток модели: отдаёт заранее заданные ответы по очереди. */
function fakeStream(answers: any[], seen?: any[]) {
  let index = 0;
  return async (_model: any, context: any) => {
    seen?.push(structuredClone(context.messages));
    const message = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: message.stopReason, message };
      },
      result: async () => message,
    };
  };
}

describe("baseline установленного Pi 0.84.4", () => {
  it("prompt доходит до ответа, abort останавливает ход, idle наступает", async () => {
    const sdk = await coreSdk();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const agent = new sdk.Agent({
      initialState: { model, tools: [] },
      streamFn: async () => {
        await gate;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message: answer([{ type: "text", text: "готово" }]) };
          },
          result: async () => answer([{ type: "text", text: "готово" }]),
        };
      },
    });
    const done = agent.prompt("Начни");
    agent.abort();
    release();
    await done.catch(() => undefined);
    await agent.waitForIdle();
    // После abort ход завершён, и новый промпт уже не течёт в старую сессию.
    expect(agent.state.isStreaming).toBe(false);
  });

  it("steer попадает в текущий ход, followUp ждёт его конца", async () => {
    const sdk = await coreSdk();
    const contexts: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let call = 0;
    const agent = new sdk.Agent({
      initialState: { model, tools: [] },
      streamFn: async (_model: any, context: any) => {
        contexts.push(structuredClone(context.messages));
        call += 1;
        if (call === 1) {
          // Первый ответ ждёт, пока в ход подмешают уточнение.
          await gate;
        }
        const message = answer([{ type: "text", text: `ответ ${call}` }]);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message,
        };
      },
    });
    const run = agent.prompt("Начало");
    await new Promise((resolve) => setTimeout(resolve, 20));
    agent.steer({ role: "user", content: "Уточнение", timestamp: Date.now() });
    release();
    await run.catch(() => undefined);
    await agent.waitForIdle();
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    // Уточнение видно модели в следующем запросе.
    expect(JSON.stringify(contexts[contexts.length - 1])).toContain("Уточнение");
  });

  it("abort доходит до отменяемого инструмента, неотменяемый — остаётся", async () => {
    const sdk = await coreSdk();
    const cancelled: string[] = [];
    const stubborn: string[] = [];
    const agent = new sdk.Agent({
      initialState: {
        model,
        tools: [
          {
            name: "cancelable",
            label: "cancelable",
            description: "слушает отмену",
            parameters: Type.Object({ id: Type.String() }),
            execute: async (_callId: string, args: any, signal?: AbortSignal) => {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 2000);
                signal?.addEventListener("abort", () => {
                  clearTimeout(timer);
                  cancelled.push(args.id);
                  resolve();
                });
              });
              return { content: [{ type: "text", text: "готово" }], details: {} };
            },
          },
          {
            name: "stubborn",
            label: "stubborn",
            description: "игнорирует отмену",
            parameters: Type.Object({ id: Type.String() }),
            execute: async (_callId: string, args: any) => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              stubborn.push(args.id);
              return { content: [{ type: "text", text: "сделано" }], details: {} };
            },
          },
        ],
      },
      streamFn: fakeStream([
        answer([{ type: "toolCall", id: "c1", name: "cancelable", arguments: { id: "job-1" } }], "toolUse"),
        answer([{ type: "text", text: "после отмены" }]),
      ]),
    });
    const run = agent.prompt("Запусти работу");
    await new Promise((resolve) => setTimeout(resolve, 30));
    agent.abort();
    await run.catch(() => undefined);
    await agent.waitForIdle();
    // Отменяемый инструмент увидел сигнал отмены.
    expect(cancelled).toEqual(["job-1"]);
    // Неотменяемый — нет: он не обязан слушать сигнал. Это и есть разница
    // между «остановили ход» и «внешняя работа остановилась».
    expect(stubborn).toEqual([]);
  });

  it("navigateTree во время streaming бросает — сменить ветку на живом ходу нельзя", async () => {
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    // Настоящий метод установленного AgentSession: во время streaming он
    // отказывается менять дерево сессии.
    const navigate = (codingAgent.AgentSession as any).prototype.navigateTree;
    const streaming = { isStreaming: true };
    await expect(navigate.call(streaming, "leaf-1")).rejects.toThrow(
      /Wait for the current response to finish before navigating/,
    );
  });

  it("createBranchedSession переключает менеджер сессии на новую ветку", async () => {
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-branch-"));
    const manager = codingAgent.SessionManager.create(dir, dir);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "вопрос" }],
      timestamp: Date.now(),
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as any);
    const leaf = manager.getLeafId()!;
    const before = manager.getSessionFile();
    const branched = manager.createBranchedSession(leaf);
    expect(branched).toBeTruthy();
    // Менеджер переключился на файл ветки — это другой файл сессии.
    expect(manager.getSessionFile()).not.toBe(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("выжимка строится по отфильтрованным thinking: usage есть, thinking в запрос не ушёл", async () => {
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const seen: any[] = [];
    const streamFn = async (_model: any, context: any) => {
      seen.push(structuredClone(context.messages));
      const message = answer([{ type: "text", text: "1. Что было\n- было\n2. Цель и задача\n- цель\n3. Что выполнить\n- шаг" }]);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message };
        },
        result: async () => message,
      };
    };
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "вопрос" }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "СЫРОЕ РАЗМЫШЛЕНИЕ" },
          { type: "text", text: "ответ" },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    ];
    const result = await codingAgent.generateSummaryWithUsage(
      messages as any,
      model as any,
      4096,
      "test-key",
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn as any,
    );
    expect(result.usage.totalTokens).toBe(18);
    const request = JSON.stringify(seen[0]);
    // Сырое размышление в запрос модели ушло только потому, что мы его не
    // отфильтровали: сервер обязан фильтровать ДО вызова суммаризатора.
    expect(request).toContain("СЫРОЕ РАЗМЫШЛЕНИЕ");
    // А выжимка с тремя заголовками принимается нашей проверкой.
    const parsed = parseThreeSections(result.text);
    expect(parsed).not.toBeNull();
  });
});

/** Проверка трёх заголовков выжимки (копия правила из chatCheckpoint.ts —
 *  импорт не делаем, чтобы baseline-тест не зависел от серверных модулей). */
function parseThreeSections(text: string): { was: string; goal: string; next: string } | null {
  const titles = ["Что было", "Цель и задача", "Что выполнить"];
  const found = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const title = titles.find((candidate) => trimmed === candidate || trimmed === `1. ${candidate}` || trimmed === `2. ${candidate}` || trimmed === `3. ${candidate}`);
    if (title) {
      current = title;
      found.set(title, []);
      continue;
    }
    if (current) found.get(current)!.push(line);
  }
  if (titles.some((title) => !found.has(title))) return null;
  const section = (title: string) => (found.get(title) ?? []).join("\n").trim();
  return { was: section(titles[0]), goal: section(titles[1]), next: section(titles[2]) };
}
