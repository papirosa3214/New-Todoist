import { describe, it, expect, vi } from "vitest";

/**
 * Инструмент Things3 для Помощника владельца.
 *
 * Проверяем то, что серверная часть решает сама: отсев неизвестного имени
 * инструмента и внятную ошибку, когда мака нет. Сам хост — настоящий
 * (решение владельца 18.10.2026: живой Things3 не трогать), поэтому он
 * подставляется заглушкой.
 */

vi.mock("../src/host/machines.js", () => ({ listMachines: vi.fn(() => [] as any[]) }));
vi.mock("../src/host/gateway.js", () => ({
  isMachineOnline: vi.fn(() => false),
  resolveMachine: vi.fn(() => null),
  runOperation: vi.fn(async () => ({ ok: true, data: { tool: "things_today", result: "[]" } })),
}));

const { THINGS3_TOOLS } = await import("../src/runtime/secretaryThings3Tools.js");
const { runOperation, isMachineOnline } = await import("../src/host/gateway.js");
const { listMachines } = await import("../src/host/machines.js");

describe("secretaryThings3Tools", () => {
  it("объявляет инструмент и белый список непустой", () => {
    expect(THINGS3_TOOLS.length).toBeGreaterThan(0);
    expect(THINGS3_TOOLS).toContain("things_today");
    expect(THINGS3_TOOLS).toContain("things_add");
    expect(THINGS3_TOOLS).toContain("things_complete");
  });

  it("отказывает на имени вне списка, не зовя хост", async () => {
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });
    (runOperation as any).mockClear();

    await expect(
      инструмент.execute("1", { tool: "things_hack" }, undefined as any),
    ).rejects.toThrow();
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("офлайн-машина даёт внятную ошибку, а не пустой список", async () => {
    (listMachines as any).mockReturnValue([]);
    (isMachineOnline as any).mockReturnValue(false);
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });

    await expect(инструмент.execute("1", { tool: "things_today" }, undefined as any)).rejects.toThrow(
      /офлайн|offline/i,
    );
  });

  it("онлайн-машина: уходит ровно одна операция things3", async () => {
    (listMachines as any).mockReturnValue([
      { id: "mac", name: "macbook", platform: "darwin", revoked_at: null },
    ]);
    (isMachineOnline as any).mockReturnValue(true);
    (runOperation as any).mockClear();
    (runOperation as any).mockResolvedValue({
      ok: true,
      data: { tool: "things_add", result: "создано" },
    });

    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });
    const ответ = await инструмент.execute(
      "1",
      { tool: "things_add", arguments: { title: "хлеб" } },
      undefined as any,
    );

    expect(runOperation).toHaveBeenCalledTimes(1);
    expect((runOperation as any).mock.calls[0][0]).toBe("mac");
    expect((runOperation as any).mock.calls[0][1]).toBe("things3");
    expect((runOperation as any).mock.calls[0][2]).toEqual({
      tool: "things_add",
      arguments: { title: "хлеб" },
    });
    expect(JSON.stringify(ответ)).toContain("создано");
  });

  it("отказ хоста доходит до роли текстом, а не молчанием", async () => {
    (listMachines as any).mockReturnValue([{ id: "mac", name: "macbook", platform: "darwin", revoked_at: null }]);
    (isMachineOnline as any).mockReturnValue(true);
    (runOperation as any).mockResolvedValue({ ok: false, error: "Машина недоступна" });

    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });

    await expect(инструмент.execute("1", { tool: "things_today" }, undefined as any)).rejects.toThrow(
      /Машина недоступна/,
    );
  });

  it("отозванная машина не считается доступной", async () => {
    (listMachines as any).mockReturnValue([
      { id: "старый", name: "old", revoked_at: "2026-01-01" },
    ]);
    (isMachineOnline as any).mockReturnValue(true);

    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });

    await expect(инструмент.execute("1", { tool: "things_today" }, undefined as any)).rejects.toThrow(
      /офлайн|offline/i,
    );
  });
  it("не отправляет Things на онлайн Linux", async () => {
    vi.mocked(listMachines).mockReturnValue([{ id: "linux", name: "server", platform: "linux", revoked_at: null }] as any);
    vi.mocked(isMachineOnline).mockReturnValue(true);
    vi.mocked(runOperation).mockClear();
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    await expect(secretaryThings3Tools({ role: "secretary" })[0].execute("1", { tool: "things_today" }, undefined as any)).rejects.toThrow(/офлайн|offline/i);
    expect(runOperation).not.toHaveBeenCalled();
  });

  it("не превращает ошибку вложенной операции в успех", async () => {
    vi.mocked(listMachines).mockReturnValue([{ id: "mac", name: "macbook", platform: "darwin", revoked_at: null }] as any);
    vi.mocked(isMachineOnline).mockReturnValue(true);
    vi.mocked(runOperation).mockResolvedValue({ ok: true, data: { ok: false, error: "Operation not permitted" } } as any);
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    await expect(secretaryThings3Tools({ role: "secretary" })[0].execute("1", { tool: "things_today" }, undefined as any)).rejects.toThrow(/Operation not permitted/);
  });

  it("Things3 не ответил — отказ говорит: один повтор, потом сообщить владельцу", async () => {
    (listMachines as any).mockReturnValue([{ id: "mac", name: "macbook", platform: "darwin", revoked_at: null }]);
    (isMachineOnline as any).mockReturnValue(true);
    (runOperation as any).mockResolvedValue({ ok: false, error: "Things3 не ответил на вызов" });
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });
    await expect(инструмент.execute("2", { tool: "things_today", arguments: {} }, undefined as any))
      .rejects.toThrow("сообщи владельцу");
  });

  it("пустой report_markdown — отказ перечисляет обязательные разделы", async () => {
    const { validateRoleReport } = await import("../src/lib/roleReportPolicy.js");
    expect(() => validateRoleReport("")).toThrow("## Результат, ## Что сделано, ## Проверки, ## Ограничения, ## Материалы");
  });

  it("пропущенный параметр дела — образец вызова вместо «повтори»", async () => {
    (listMachines as any).mockReturnValue([{ id: "mac", name: "macbook", platform: "darwin", revoked_at: null }]);
    (isMachineOnline as any).mockReturnValue(true);
    (runOperation as any).mockResolvedValue({ ok: false, error: "arguments.id_or_title: обязательное поле" });
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const [инструмент] = secretaryThings3Tools({ role: "secretary" });
    const ошибка = await инструмент.execute("1", { tool: "things_complete" }, undefined as any).catch((e: Error) => e.message);
    expect(ошибка).toContain('"arguments":{"tool":"things_complete","arguments":{"id_or_title":"…"}}');
    expect(ошибка).not.toMatch(/повтори этот же вызов/);
  });

  it("неверная форма вызова через шлюз — тоже образец", async () => {
    const { secretaryThings3Tools } = await import("../src/runtime/secretaryThings3Tools.js");
    const { createUniversalTaskflow } = await import("../src/runtime/universalTaskflow.js");
    const шлюз = createUniversalTaskflow(secretaryThings3Tools({ role: "secretary" }) as any, { actor: "u-secretary", role: "secretary", mode: "work", runId: "r" });
    const ответ = await шлюз.execute("1", { action: "invoke", operation: "taskflow_things3", version: 1, request_id: "x", arguments: { id: "4Lx", yes: "true" } });
    const текст = JSON.stringify(ответ);
    expect(текст).toContain("INVALID_ARGUMENTS");
    expect(текст).toContain("Правильный вызов");
  });
});
