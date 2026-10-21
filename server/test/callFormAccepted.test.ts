// Форма вызова ролей — самый частый источник отказов (карточка c8083c2a,
// раздел И1 отчёта docs/2026-10-21-agent-speed-budget.md): за неделю 21.10.2026
// 971 отказ из 2157 — это та же операция в другой записи. Эти тесты фиксируют
// договор: сервер разворачивает запись до проверки схемы, а не отказывает.
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { createUniversalTaskflow } from "../src/runtime/universalTaskflow.js";

const ctx = { actor: "role_builder", role: "builder", mode: "work" as const, runId: "run-form" };
const seen: any[] = [];
const op = (name: string, parameters: any) => ({
  name,
  description: name,
  parameters,
  execute: async (_id: string, args: any) => {
    seen.push(args);
    return { content: [{ type: "text", text: "ok" }] };
  },
});
const parse = (r: any) => JSON.parse(r.content[0].text);
const планировщик = op(
  "taskflow_work_plan",
  Type.Object({
    base_revision: Type.Optional(Type.Number()),
    items: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          state: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")]),
        }),
      ),
    ),
  }),
);
const шаг = op(
  "taskflow_work",
  Type.Object({ id: Type.String(), state: Type.Optional(Type.String()), changes_result: Type.Optional(Type.Boolean()) }),
);
const мак = op(
  "taskflow_host_bash",
  Type.Object({ machine: Type.Optional(Type.String()), task_id: Type.Optional(Type.String()), arguments: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }) }),
);
const вызов = async (api: any, operation: string, args: any, request_id = "r1") =>
  parse(await api.execute(request_id, { action: "invoke", operation, version: 1, request_id, arguments: args }));

describe("массив пришёл объектом-обёрткой", () => {
  it("items как {\"item\": [...]} принимается и доходит массивом", async () => {
    const items = [{ id: "a", title: "Этап", state: "pending" }];
    const api: any = createUniversalTaskflow([планировщик as any], ctx);
    const r = await вызов(api, "taskflow_work_plan", { base_revision: 0, items: { item: items } });
    expect(r.ok).toBe(true);
    expect(seen.at(-1).items).toEqual(items);
  });

  it("items строкой JSON принимается массивом", async () => {
    const items = [{ id: "b", title: "Этап", state: "done" }];
    const api: any = createUniversalTaskflow([планировщик as any], ctx);
    const r = await вызов(api, "taskflow_work_plan", { items: JSON.stringify(items) });
    expect(r.ok).toBe(true);
    expect(seen.at(-1).items).toEqual(items);
  });
});

describe("число и boolean строкой", () => {
  it("base_revision \"0\" становится числом 0", async () => {
    const api: any = createUniversalTaskflow([планировщик as any], ctx);
    const r = await вызов(api, "taskflow_work_plan", { base_revision: "0", items: [] });
    expect(r.ok).toBe(true);
    expect(seen.at(-1).base_revision).toBe(0);
  });

  it("changes_result \"true\" становится boolean", async () => {
    const api: any = createUniversalTaskflow([шаг as any], ctx);
    const r = await вызов(api, "taskflow_work", { id: "s1", state: "blocked", changes_result: "true" });
    expect(r.ok).toBe(true);
    expect(seen.at(-1).changes_result).toBe(true);
  });
});

describe("версия и ключ повтора", () => {
  it("любая version — та же операция, отказов нет", async () => {
    for (const version of [1, 2, 7]) {
      const api: any = createUniversalTaskflow([шаг as any], ctx);
      api.operation = "taskflow_work";
      const r = parse(await api.execute("v" + version, { action: "invoke", operation: "taskflow_work", version, request_id: "v" + version, arguments: { id: "s1" } }));
      expect(r.ok).toBe(true);
    }
  });

  it("request_id: null — это «не задан», ключ подставляется сам", async () => {
    const api: any = createUniversalTaskflow([шаг as any], ctx);
    const r = parse(await api.execute("call-null", { operation: "taskflow_work", request_id: null, arguments: { id: "s1" } }));
    expect(r.ok).toBe(true);
    expect(r.request_id).toMatch(/:call-null$/);
  });
});

describe("плоский вызов host-операции", () => {
  it("command и timeout кладутся в arguments.arguments, типы приводятся", async () => {
    const api: any = createUniversalTaskflow([мак as any], ctx);
    const r = await вызов(api, "taskflow_host_bash", { command: "uptime", timeout: "120" });
    expect(r.ok).toBe(true);
    expect(seen.at(-1).arguments).toEqual({ command: "uptime", timeout: 120 });
  });
});
