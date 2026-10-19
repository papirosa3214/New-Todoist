import {describe,it,expect,vi} from "vitest";
import {Type} from "typebox";
import {createUniversalTaskflow} from "../src/runtime/universalTaskflow.js";

// Авария 19.10.2026: роль не могла записать файл на мак. `taskflow_host_edit`
// объявлен как операция-писатель, но её схема не содержит `request_id`,
// а createUniversalTaskflow требует его для любой записи. Рантайм агента
// отбрасывает поле, которого нет в схеме, — и вызов падал с «Для изменения
// нужен request_id» при любой попытке записи (проверено 8 формами вызова).
const context = { actor: "role_builder", role: "builder", mode: "work" as const, runId: "test-run" };
const decode = (r: any) => JSON.parse(r.content[0].text);

// Схема как у host-операций: вложенный объект arguments, request_id нет.
const writeTool = (execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))) => ({
  name: "taskflow_host_edit",
  description: "Правка файла на маке",
  parameters: Type.Object({
    arguments: Type.Object({ path: Type.String(), edits: Type.Array(Type.Any()) }),
  }),
  execute,
});

describe("request_id операций-писателей", () => {
  it("принимает request_id внутри arguments, когда его нет в схеме операции", async () => {
    const t = writeTool();
    const api = createUniversalTaskflow([t], context);
    const r = await api.execute("1", {
      action: "invoke", operation: t.name, version: 1, request_id: "outer",
      arguments: { arguments: { path: "/tmp/a.swift", edits: [] }, request_id: "inner" },
    });
    expect(decode(r).ok, JSON.stringify(decode(r))).toBe(true);
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it("объявляет request_id в схеме операции-писателя, чтобы рантайм его не отбрасывал", async () => {
    const api = createUniversalTaskflow([writeTool()], context);
    const schema = decode(await api.execute("2", { action: "describe", operation: "taskflow_host_edit" })).data.inputSchema;
    expect(Object.keys(schema.properties)).toContain("request_id");
  });

  it("не ослабляет защиту: запись без request_id по-прежнему отклоняется", async () => {
    const t = writeTool();
    const api = createUniversalTaskflow([t], context);
    const r = await api.execute("3", {
      action: "invoke", operation: t.name, version: 1,
      arguments: { arguments: { path: "/tmp/a.swift", edits: [] } },
    });
    expect(decode(r).error.code).toBe("INVALID_ARGUMENTS");
    expect(t.execute).not.toHaveBeenCalled();
  });
});
// Владелец 19.10.2026: отказ без следующего шага бесполезен — в каждой ошибке
// должен быть совет, что делать дальше.
describe("подсказки в отказах", () => {
  const codes = ["INVALID_ARGUMENTS", "FORBIDDEN", "MODE_RESTRICTED", "CONTEXT_REQUIRED",
    "UNKNOWN_OPERATION", "VERSION_MISMATCH", "CONFLICT", "OPERATION_FAILED"] as const;
  it("каждый отказ несёт непустую подсказку", async () => {
    const api = createUniversalTaskflow([writeTool()], context);
    const отказ = decode(await api.execute("h1", { action: "invoke", operation: "taskflow_host_edit", version: 1, arguments: { arguments: {} } } as any));
    expect(отказ.error.hint.length).toBeGreaterThan(20);
    expect(отказ.error.hint).toMatch(/describe|discover|request_id|задач/i);
    const неизвестная = decode(await api.execute("h2", { action: "invoke", operation: "taskflow_нет_такой", version: 1, arguments: {} } as any));
    expect(неизвестная.error.hint).toContain("discover");
    for (const code of codes) {
      const ответ = decode(await api.execute("h-" + code, { action: "describe", operation: "нет" } as any));
      expect(typeof ответ.error.hint).toBe("string");
    }
  });
});
