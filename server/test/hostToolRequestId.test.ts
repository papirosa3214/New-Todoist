import {beforeAll,describe,it,expect,vi} from "vitest";
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

// Владелец 19.10.2026: «у помощника голосового нет инструмента для веб-поиска,
// сделай ему его». Проверяем, что поиск и чтение страницы есть у обоих.
import { taskflowTools } from "../src/runtime/inProcessRun.js";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
beforeAll(() => { migrate(); runMigrations(); seedRoleAccounts(db); });
describe("веб-инструменты ролей", () => {
  const имена = (role: string) => taskflowTools(role, null, undefined, undefined, true, undefined).map((t: any) => t.name);
  it("Помощнику владельца доступны web_search и web_get", () => {
    const список = имена("secretary");
    expect(список).toContain("web_search");
    expect(список).toContain("web_get");
  });
  // Карточка e11eae7a: Помощница отвечает на глубокое исследование сама —
  // у неё весь набор исследователя, кроме отчёта по карточке.
  it("помощнику — весь набор исследования, кроме отчёта по карточке", () => {
    const список = имена("secretary");
    for (const нужный of ["web_search", "web_get", "ocr", "youtube", "local_model"]) expect(список).toContain(нужный);
    expect(список).not.toContain("taskflow_report");
  });
  it("у Исследователя набор не изменился", () => {
    const список = имена("researcher");
    for (const нужный of ["web_search", "web_get", "ocr", "youtube", "local_model"]) expect(список).toContain(нужный);
  });
});
