// Починка формы вызова (инцидент 24.10.2026, карточка 252c400e): роль
// повторяла сломанный вызов 55 раз подряд, хотя сервер уже знал, как его
// привести к схеме, — но отказывал и ждал повтора от модели. Теперь сервер
// приводит аргументы и выполняет вызов сам; нечинимое остаётся отказом.
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  createUniversalTaskflow,
  memoryRequestStore,
} from "../src/runtime/universalTaskflow.js";

const context = {
  actor: "role_builder",
  role: "builder",
  mode: "work" as const,
  runId: "test-run",
};
const decode = (r: any) => JSON.parse(r.content[0].text);

const writeOp = (
  execute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
) => ({
  name: "taskflow_comment",
  description: "Комментарий в задачу",
  parameters: Type.Object({ id: Type.String(), text: Type.String() }),
  execute,
});

describe("починка формы вызова: приводим и выполняем", () => {
  it("поле, присланное на верхнем уровне, переносится в arguments — и вызов идёт", async () => {
    const t = writeOp();
    const api = createUniversalTaskflow([t], context);
    const r = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        request_id: "r1",
        arguments: {},
        id: "T1",
        text: "привет",
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.execute.mock.calls[0][1]).toEqual({ id: "T1", text: "привет" });
    expect(r.data.repaired.changes.join(" ")).toContain("id → arguments.id");
    expect(r.data.repaired.note).toContain("Повторять не нужно");
  });

  it("лишний уровень arguments снимается — и вызов идёт", async () => {
    const t = {
      name: "taskflow_task_summary",
      description: "summary",
      parameters: Type.Object({ query: Type.String() }),
      execute: vi.fn(async () => ({ content: [] })),
    };
    const api = createUniversalTaskflow([t], context);
    const r = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        arguments: { arguments: { query: "сводка" } },
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(t.execute.mock.calls[0][1]).toEqual({ query: "сводка" });
  });

  it("повтор того же починенного вызова с тем же request_id не выполняет операцию дважды", async () => {
    const t = writeOp();
    const store = memoryRequestStore();
    const api = createUniversalTaskflow([t], context, store);
    const первый = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        request_id: "r2",
        arguments: {},
        id: "T2",
        text: "x",
      }),
    );
    expect(первый.ok).toBe(true);
    const второй = decode(
      await api.execute("2", {
        action: "invoke",
        operation: t.name,
        version: 1,
        request_id: "r2",
        arguments: {},
        id: "T2",
        text: "x",
      }),
    );
    expect(второй.ok).toBe(true);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(store.get(context.actor, "r2")?.state).toBe("succeeded");
  });

  it("починенный вызов не считается ошибкой — тренер не останавливает ход", async () => {
    const t = writeOp();
    const api = createUniversalTaskflow([t], context);
    for (const id of ["1", "2", "3", "4"]) {
      const r = decode(
        await api.execute(id, {
          action: "invoke",
          operation: t.name,
          version: 1,
          request_id: "r-" + id,
          arguments: {},
          id: "T",
          text: "x",
        }),
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.error?.coach).toBeUndefined();
    }
    expect(t.execute).toHaveBeenCalledTimes(4);
  });
});

describe("нечинимое остаётся отказом", () => {
  it("неверный тип внутри элемента массива: называем точное место", async () => {
    const t = {
      name: "taskflow_work_plan",
      description: "plan",
      parameters: Type.Object({
        base_revision: Type.Number(),
        items: Type.Array(
          Type.Object({
            id: Type.String(),
            state: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
          }),
        ),
      }),
      execute: vi.fn(async () => ({ content: [] })),
    };
    const api = createUniversalTaskflow([t], context);
    const r = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        request_id: "p1",
        arguments: { base_revision: "0", items: [{ id: 1, state: "started" }] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_ARGUMENTS");
    expect(r.error.message).toContain("arguments.items[0].id");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("выдуманное поле вместо обязательного — отказ, а не догадка", async () => {
    const t = writeOp();
    const api = createUniversalTaskflow([t], context);
    const r = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        request_id: "r3",
        arguments: { id: "T3", body: "x" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_ARGUMENTS");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("чужая подпись значения в ошибке не течёт", async () => {
    const t = {
      name: "taskflow_task_summary",
      description: "summary",
      parameters: Type.Object({ token: Type.Number() }),
      execute: vi.fn(async () => ({ content: [] })),
    };
    const api = createUniversalTaskflow([t], context);
    const r = decode(
      await api.execute("1", {
        action: "invoke",
        operation: t.name,
        version: 1,
        arguments: { token: "private-secret-token" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("private-secret-token");
  });
});
