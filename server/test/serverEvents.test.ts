// Серверный журнал событий (карточка e87cd93f). Проверяем, что:
//   - `logServerEvent` пишет строку и читается обратно по тем же полям,
//   - `recordServerOperation` ставит стартовое и терминальное событие с
//     одним operation_id и duration_ms > 0;
//   - чувствительные данные в data_json вычищаются;
//   - при попытке вставить мусор (без scope/kind) модуль не валит сервер.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  logServerEvent,
  normalizeServerError,
  recordServerOperation,
} from "../src/lib/serverEvents.js";

migrate();
runMigrations();

beforeAll(() => {
  // Каждый запуск тестов бежит на временной БД (vitest setup), но всё равно
  // убедимся, что таблица на месте и пуста под наши записи.
  db.exec("DELETE FROM server_events WHERE message LIKE 'unit-test:%'");
});

afterAll(() => {
  db.exec("DELETE FROM server_events WHERE message LIKE 'unit-test:%'");
});

function countEvent(filter: { operationId?: string; kind?: string; message?: string }): number {
  let sql = "SELECT COUNT(*) AS n FROM server_events WHERE 1=1";
  const args: unknown[] = [];
  if (filter.operationId) {
    sql += " AND operation_id = ?";
    args.push(filter.operationId);
  }
  if (filter.kind) {
    sql += " AND kind = ?";
    args.push(filter.kind);
  }
  if (filter.message) {
    sql += " AND message LIKE ?";
    args.push(filter.message);
  }
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

describe("logServerEvent", () => {
  it("пишет строку и читается обратно по тем же полям", () => {
    const record = logServerEvent({
      scope: "lifecycle",
      kind: "process_boot",
      message: "unit-test: запись журнала",
      data: { x: 1, y: "z" },
    });
    expect(record?.id).toMatch(/^sev_/);
    expect(countEvent({ kind: "process_boot", message: "unit-test: запись журнала" })).toBeGreaterThanOrEqual(1);
  });

  it("вычищает токены и bearer из data_json", () => {
    logServerEvent({
      scope: "system",
      kind: "unhandled_error",
      message: "unit-test: redact данные",
      data: {
        api_key: "real_key_leak_1234567890",
        nested: { password: "leaked_password_value" },
        safe: { count: 5 },
        bearer_text: "Bearer abcdef0123456789xyz",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456ghi789jkl012mno345pq",
      },
    });
    const row = db
      .prepare(
        `SELECT data_json FROM server_events
          WHERE message = 'unit-test: redact данные' ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { data_json: string };
    expect(row.data_json).toContain('"api_key":"***"');
    expect(row.data_json).toContain('"password":"***"');
    expect(row.data_json).toContain('Bearer ***');
    expect(row.data_json).toContain("[redacted-jwt]");
    expect(row.data_json).toContain('"count":5');
  });

  it("проглатывает сбой вставки, не валит тест", () => {
    // Битый scope (не из списка CHECK): INSERT упадёт, но logServerEvent
    // обязан вернуть null, а не throw.
    const out = logServerEvent({
      // @ts-expect-error — намеренно мусорное значение ради проверки.
      scope: "nope",
      kind: "process_boot",
      message: "unit-test: не упадём",
    });
    expect(out).toBeNull();
  });
});

describe("recordServerOperation", () => {
  it("пишет старт + финал с одним operation_id и duration_ms > 0", async () => {
    const op = recordServerOperation({
      scope: "role_run",
      kind: "role_run",
      taskId: "task_unit_test",
      subtype: "tester",
      message: "unit-test: операция",
    });
    await new Promise((r) => setTimeout(r, 5));
    op.ok({ message: "unit-test: операция завершилась" });

    const events = db
      .prepare(
        `SELECT kind, duration_ms, outcome FROM server_events
          WHERE operation_id = ? ORDER BY rowid ASC`,
      )
      .all(op.operationId) as Array<{ kind: string; duration_ms: number | null; outcome: string | null }>;
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("role_run_started");
    expect(events[0].outcome).toBeNull();
    expect(events[1].kind).toBe("role_run_ok");
    expect(events[1].outcome).toBe("ok");
    expect(events[1].duration_ms ?? 0).toBeGreaterThan(0);
  });

  it("финальный вызов после первого — игнорируется", () => {
    const op = recordServerOperation({
      scope: "mcp",
      kind: "mcp_call",
      message: "unit-test: двойной close",
    });
    op.ok();
    op.err({ message: "second close", errorCode: "x" });
    expect(countEvent({ operationId: op.operationId, kind: "mcp_call_ok" })).toBe(1);
    expect(countEvent({ operationId: op.operationId, kind: "mcp_call_err" })).toBe(0);
  });
});

describe("normalizeServerError", () => {
  it("берёт name из Error и редактирует секреты в message", () => {
    const err = new Error("authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    err.name = "ToolError";
    const out = normalizeServerError(err, "fallback");
    expect(out.code).toBe("ToolError");
    expect(out.message).toContain("Bearer ***");
  });

  it("голый JWT в сообщении редактируется отдельно от Authorization", () => {
    const err = new Error("валидация не прошла: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmnop");
    err.name = "AuthError";
    const out = normalizeServerError(err, "fallback");
    expect(out.code).toBe("AuthError");
    expect(out.message).toContain("[redacted-jwt]");
  });

  it("срабатывает на строку как на сообщение", () => {
    const out = normalizeServerError("просто строка", "string_err");
    expect(out.code).toBe("string_err");
    expect(out.message).toBe("просто строка");
  });

  it("срабатывает на null как на пустую ошибку", () => {
    const out = normalizeServerError(null, "null_err");
    expect(out.code).toBe("null_err");
    expect(out.message).toBe("");
  });
});
