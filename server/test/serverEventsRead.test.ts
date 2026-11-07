// Юнит-тесты чтения и выгрузки серверного журнала (карточка e87cd93f,
// шаг «Разработка API чтения и выгрузки диагностики»). Без поднятия
// Fastify: используем голую БД и публичные функции. Интеграционные
// сценарии с правами доступа и форматом экспорта — в отдельном файле.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  buildExportPayload,
  getOperationChain,
  getServerEventById,
  getServerEventStats,
  listServerEvents,
  serializeNdjson,
} from "../src/lib/serverEventsRead.js";
import {
  logServerEvent,
  recordServerOperation,
} from "../src/lib/serverEvents.js";

migrate();
runMigrations();

beforeAll(() => {
  // Изолируем тестовые записи префиксом сообщения — прошлой чисткой
  // удалим только их, чужие строки не трогаем.
  db.exec("DELETE FROM server_events WHERE message LIKE 'srt-%'");
});

afterAll(() => {
  db.exec("DELETE FROM server_events WHERE message LIKE 'srt-%'");
});

/** Хелпер: добавить одну запись с предсказуемыми полями. */
function writeTestEvent(opts: {
  scope?: "lifecycle" | "queue" | "role_run" | "mcp" | "enricher" | "http_error" | "system";
  kind?: string;
  taskId?: string;
  operationId?: string;
  message?: string;
  outcome?: "ok" | "err" | "timeout" | "skipped" | "cancelled" | null;
  durationMs?: number;
  data?: Record<string, unknown>;
}) {
  return logServerEvent({
    scope: opts.scope ?? "role_run",
    kind: opts.kind ?? "role_run_started",
    message: opts.message ?? "srt-default",
    taskId: opts.taskId ?? null,
    operationId: opts.operationId ?? null,
    outcome: opts.outcome ?? null,
    durationMs: opts.durationMs ?? null,
    data: opts.data ?? null,
  });
}

describe("listServerEvents", () => {
  it("возвращает события и фильтрует по message", () => {
    writeTestEvent({ message: "srt-list-A" });
    writeTestEvent({ message: "srt-list-B" });
    writeTestEvent({ message: "srt-list-C" });

    const result = listServerEvents({
      messageContains: "srt-list-",
      limit: 10,
    });
    const messages = result.events.map((e) => e.message).filter((m) => m?.startsWith("srt-list-"));
    // Все три сообщения присутствуют. SQLite хранит `created_at` с
    // секундной точностью, поэтому три записи в одну секунду могут
    // иметь одинаковый created_at и порядок при DESC-сортировке
    // определяется по id (UUIDv4). Проверяем состав, а не позиции.
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages).toContain("srt-list-A");
    expect(messages).toContain("srt-list-B");
    expect(messages).toContain("srt-list-C");
  });

  it("asc-сортировка тоже возвращает все сообщения", () => {
    const tag = "srt-asc-" + Date.now();
    writeTestEvent({ message: `${tag}-x` });
    writeTestEvent({ message: `${tag}-y` });

    const result = listServerEvents({
      messageContains: tag,
      limit: 10,
      order: "asc",
    });
    const messages = result.events.map((e) => e.message);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("фильтр по scope отдаёт только нужный scope", () => {
    writeTestEvent({ scope: "http_error", message: "srt-scope-http" });
    writeTestEvent({ scope: "queue", message: "srt-scope-queue" });

    const result = listServerEvents({
      scopes: ["http_error"],
      messageContains: "srt-scope-",
    });
    const messages = result.events.map((e) => e.message);
    expect(messages).toContain("srt-scope-http");
    expect(messages).not.toContain("srt-scope-queue");
  });

  it("фильтр по operationId собирает всю цепочку одной операции", () => {
    const op = "op_test_chain_" + Date.now();
    writeTestEvent({ message: "srt-chain-1", operationId: op });
    writeTestEvent({ message: "srt-chain-2", operationId: op });
    writeTestEvent({ message: "srt-chain-other", operationId: "op_other" });

    const result = listServerEvents({ operationId: op, messageContains: "srt-chain-" });
    expect(result.events.length).toBe(2);
    expect(result.events.every((e) => e.operationId === op)).toBe(true);
  });

  it("фильтр по task_id отдаёт только эту задачу", () => {
    const taskA = "task_test_A_" + Date.now();
    writeTestEvent({ message: "srt-task-A", taskId: taskA });
    writeTestEvent({ message: "srt-task-B", taskId: "task_test_B" });

    const result = listServerEvents({
      taskId: taskA,
      messageContains: "srt-task-",
    });
    expect(result.events.length).toBe(1);
    expect(result.events[0].message).toBe("srt-task-A");
  });

  it("курсорная пагинация: limit=2 и cursor продолжают выборку", () => {
    const tag = "srt-page-" + Date.now();
    for (let i = 0; i < 5; i += 1) writeTestEvent({ message: `${tag}-${i}` });

    const first = listServerEvents({ messageContains: tag, limit: 2 });
    expect(first.events.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = listServerEvents({
      messageContains: tag,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.events.length).toBe(2);
    // Курсор должен сдвинуть позицию — ни одна запись не повторяется.
    const ids = new Set([...first.events.map((e) => e.id), ...second.events.map((e) => e.id)]);
    expect(ids.size).toBe(4);
  });

  it("неизвестный scope в фильтре отсекается без падения", () => {
    expect(() =>
      // @ts-expect-error — намеренно кривой scope, чтобы проверить защиту.
      listServerEvents({ scopes: ["lifecycle", "garbage_scope"], messageContains: "srt-" }),
    ).not.toThrow();
  });
});

describe("getServerEventById", () => {
  it("возвращает null для несуществующего id", () => {
    expect(getServerEventById("sev_does_not_exist")).toBeNull();
  });

  it("парсит data_json в объект", () => {
    const ev = writeTestEvent({
      message: "srt-byid",
      data: { foo: 1, bar: ["a", "b"] },
    });
    const fetched = getServerEventById(ev!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.data).toEqual({ foo: 1, bar: ["a", "b"] });
  });
});

describe("getOperationChain", () => {
  it("возвращает все события одной операции", async () => {
    const op = recordServerOperation({
      scope: "role_run",
      kind: "role_run",
      actorId: null,
      message: "srt-op-1",
    });
    logServerEvent({
      scope: "mcp",
      kind: "mcp_call_ok",
      operationId: op.operationId,
      message: "srt-op-2",
      data: { tool: "web_search" },
    });
    op.ok({ message: "srt-op-3" });

    const chain = getOperationChain(op.operationId);
    const messages = chain.events.map((e) => e.message);
    // Все три записи присутствуют в цепочке. created_at у SQLite — секундная
    // точность, поэтому три записи в одну секунду могут идти в произвольном
    // порядке относительно друг друга (id-сортимент как тай-брейкер).
    expect(messages.length).toBe(3);
    expect(messages).toContain("srt-op-1");
    expect(messages).toContain("srt-op-2");
    expect(messages).toContain("srt-op-3");
    expect(chain.truncated).toBe(false);
  });

  it("возвращает пустой массив для неизвестной operation_id", () => {
    const chain = getOperationChain("op_does_not_exist");
    expect(chain.events).toEqual([]);
    expect(chain.truncated).toBe(false);
  });
});

describe("getServerEventStats", () => {
  it("считает total и byScope по фильтру", () => {
    const tag = "srt-stats-" + Date.now();
    writeTestEvent({ scope: "queue", message: `${tag}-1` });
    writeTestEvent({ scope: "queue", message: `${tag}-2` });
    writeTestEvent({ scope: "system", message: `${tag}-3` });

    const stats = getServerEventStats({ messageContains: tag });
    expect(stats.total).toBe(3);
    const queue = stats.byScope.find((s) => s.scope === "queue");
    const system = stats.byScope.find((s) => s.scope === "system");
    expect(queue?.count).toBe(2);
    expect(system?.count).toBe(1);
  });
});

describe("buildExportPayload + serializeNdjson", () => {
  it("содержит снимок настроек, фильтры, события и серверный контекст", () => {
    const tag = "srt-exp-" + Date.now();
    writeTestEvent({ message: `${tag}-payload` });

    const events = listServerEvents({ messageContains: tag }).events;
    const stats = getServerEventStats({ messageContains: tag });
    const payload = buildExportPayload(
      { messageContains: tag },
      events,
      { total: stats.total, byScope: stats.byScope, byOutcome: stats.byOutcome },
      { node: "v.unit", commit: null },
    );
    expect(payload.format_version).toBe(1);
    expect(payload.events.length).toBe(1);
    expect(payload.settings).toBeTypeOf("object");
    expect(payload.server.commit).toBeNull();
    expect(payload.server.node).toBe("v.unit");
  });

  it("NDJSON: по одной записи на строку, последняя тоже с переводом", () => {
    const tag = "srt-ndjson-" + Date.now();
    writeTestEvent({ message: `${tag}-a` });
    writeTestEvent({ message: `${tag}-b` });
    const events = listServerEvents({ messageContains: tag }).events;
    const text = serializeNdjson(events);
    const lines = text.split("\n");
    // Последний элемент пустой (из-за завершающего \n), остальное — JSON.
    expect(lines[lines.length - 1]).toBe("");
    expect(lines.length - 1).toBe(events.length);
    for (let i = 0; i < events.length; i += 1) {
      expect(JSON.parse(lines[i]).id).toBe(events[i].id);
    }
  });
});

describe("секреты не утекают при чтении", () => {
  it("Bearer и api_key уже заменены на *** в data_json, как при записи", () => {
    const op = recordServerOperation({
      scope: "mcp",
      kind: "mcp_call",
      message: "srt-redact-1",
      data: { token: "Bearer abcdefghijklmnop", api_key: "secret-key-12345678" },
    });
    op.ok();

    const rows = listServerEvents({ operationId: op.operationId });
    expect(rows.events.length).toBeGreaterThanOrEqual(1);
    // Из всех событий цепочки — то, у которого data не null, должно
    // содержать '***' (token/api_key переименованы) и НЕ должно содержать
    // исходный секрет. Терминальное событие ok() без data нас не
    // интересует: у него data_json === null.
    const withData = rows.events.filter((e) => e.data !== null);
    expect(withData.length).toBeGreaterThanOrEqual(1);
    for (const e of withData) {
      const asString = JSON.stringify(e.data);
      expect(asString).not.toContain("secret-key-12345678");
      expect(asString).toContain("***");
    }
  });
});