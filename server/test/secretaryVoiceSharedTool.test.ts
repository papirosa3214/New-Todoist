import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { setInProcessApp } from "../src/runtime/inProcessRun.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { voiceToolManifest, runVoiceTool } from "../src/lib/secretaryVoiceTools.js";

const decode = (result: any) => JSON.parse(result.content[0].text);

describe("голосовой Помощник владельца работает через общий инструмент TaskFlow", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    setInProcessApp(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it("голос получает ровно один инструмент — тот же taskflow, что и текст", async () => {
    const manifest = await voiceToolManifest();
    expect(manifest.map((tool) => tool.name)).toEqual(["taskflow"]);

    const chat = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "chat", chatId: "chat", messageId: "msg" });
    const voice = buildRoleToolCatalog({ role: "secretary", mode: "voice", runId: "voice" });
    expect(chat.customTools[0].name).toBe("taskflow");
    expect(voice.customTools[0].name).toBe("taskflow");
    expect(voice.activeNames).toEqual(["taskflow"]);
    // Реестр операций общий: новая операция появляется один раз и сразу в обоих режимах.
    expect(voice.operations.map((tool) => tool.name)).toEqual(chat.operations.map((tool) => tool.name));
  });

  it("схема голоса — та же, только в понятном виде: action перечислен, arguments — свободный объект", async () => {
    const [manifest] = await voiceToolManifest();
    expect(manifest.parameters.properties.action).toEqual({
      type: "string",
      enum: ["discover", "describe", "invoke"],
    });
    expect(manifest.parameters.properties.arguments).toEqual({
      type: "object",
      description: "произвольные поля значения",
    });
    for (const property of Object.values(manifest.parameters.properties as Record<string, any>)) {
      expect(JSON.stringify(property)).not.toContain("patternProperties");
      expect(JSON.stringify(property)).not.toContain("anyOf");
    }
  });

  it("операция Things 3 одна и та же в тексте и в голосе: discover и describe совпадают", async () => {
    const chat = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "chat", chatId: "chat", messageId: "msg" });
    const voice = buildRoleToolCatalog({ role: "secretary", mode: "voice", runId: "voice" });

    const discoverIn = async (catalog: ReturnType<typeof buildRoleToolCatalog>) =>
      decode(await catalog.customTools[0].execute("x", { action: "discover", query: "things", limit: 20 }));
    const chatThings = (await discoverIn(chat)).data.operations.filter((operation: any) => operation.operation === "taskflow_things3");
    const voiceThings = (await discoverIn(voice)).data.operations.filter((operation: any) => operation.operation === "taskflow_things3");

    expect(chatThings).toHaveLength(1);
    expect(voiceThings).toEqual(chatThings);
    expect(voiceThings[0].available).toBe(true);

    const describe = async (catalog: ReturnType<typeof buildRoleToolCatalog>) =>
      decode(await catalog.customTools[0].execute("x", { action: "describe", operation: "taskflow_things3" }));
    expect(await describe(voice)).toEqual(await describe(chat));
    expect((await describe(voice)).data.inputSchema.properties.tool.enum).toContain("things_add");
  });

  it("вызов Things 3 из голоса идёт тем же execute, что и из текста", async () => {
    const voiceCall = (requestId: string, arguments_: Record<string, unknown>) =>
      runVoiceTool("u-secretary", "taskflow", {
        action: "invoke",
        operation: "taskflow_things3",
        version: 1,
        arguments: arguments_,
        request_id: requestId,
      });

    // Повтор того же действия с тем же request_id возвращает тот же итог, а не новый вызов.
    const first = await voiceCall("voice-things", { tool: "things_today" });
    const repeat = await voiceCall("voice-things", { tool: "things_today" });
    expect(first.ok).toBe(true);
    expect(repeat).toEqual(first);

    const chat = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "chat", chatId: "chat", messageId: "msg" });
    const chatCall = async (requestId: string, arguments_: Record<string, unknown>) =>
      decode(await chat.customTools[0].execute("x", {
        action: "invoke",
        operation: "taskflow_things3",
        version: 1,
        arguments: arguments_,
        request_id: requestId,
      }));
    // Оба режима отвечают одинаково: без машины с Things3 это один и тот же отказ.
    expect(JSON.parse(first.result).error).toEqual((await chatCall("chat-things", { tool: "things_today" })).error);

    // Несуществующее значение отсекается общей схемой одинаково в обоих режимах.
    expect(JSON.parse((await voiceCall("voice-bad", { tool: "нет-такого" })).result).error).toEqual(
      (await chatCall("chat-bad", { tool: "нет-такого" })).error,
    );
  });

  it("голос не получает отдельного имени операции, а удаление закрыто как в тексте", async () => {
    await expect(runVoiceTool("u-secretary", "taskflow_things3", {})).rejects.toThrow("неизвестный инструмент");

    const voice = buildRoleToolCatalog({ role: "secretary", mode: "voice", runId: "voice" });
    expect(voice.operations.some((tool) => /delete|purge|remove/i.test(tool.name))).toBe(false);

    // Физическое удаление остаётся недоступным: роль секретаря его не видит в каталоге.
    const purged = decode(await voice.customTools[0].execute("x", { action: "describe", operation: "taskflow_tasks_purge" }));
    expect(purged.ok).toBe(false);
    expect(purged.error.code).toBe("UNKNOWN_OPERATION");
  });
});