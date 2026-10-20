// Учёт вызовов инструментов ролями (карточка 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5):
// ошибочный вызов попадает в учёт с ролью, моделью, операцией и кодом;
// успешные вызовы считаются, чтобы считать долю ошибок; в записях нет
// значений аргументов; сводка и выгрузка отдаются по HTTP.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { FastifyInstance } from "fastify";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { buildApp } from "../src/index.js";
import { createUniversalTaskflow } from "../src/runtime/universalTaskflow.js";
import {
  checkToolAudit,
  toolAuditCsv,
  toolAuditRecords,
  toolAuditSummary,
} from "../src/runtime/toolAuditStore.js";

const MODEL = "claude-audit-probe";
const ROLE = "builder";

beforeAll(() => {
  migrate();
  runMigrations();
});

const decode = (result: any) => JSON.parse(result.content[0].text);

const operation = {
  name: "taskflow_task_summary",
  description: "сводка по задачам",
  parameters: Type.Object({ query: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "сводка" }] }),
};

const context = {
  actor: "role_builder",
  role: ROLE,
  mode: "work",
  runId: "run-audit",
  taskId: "task-audit",
  subtaskId: "step-audit",
  model: MODEL,
};

describe("учёт вызовов инструментов", () => {
  it("ошибочный вызов виден в учёте с ролью, моделью, операцией и кодом", async () => {
    const api = createUniversalTaskflow([operation], context);
    const out = decode(
      await api.execute("a", {
        action: "discover",
        operation: operation.name,
        query: "сводка",
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("ACTION_CONFLICT");

    const record = toolAuditRecords({ role: ROLE, model: MODEL }).find(
      (row) => row.error_code === "ACTION_CONFLICT",
    );
    expect(record, "отказ должен попасть в учёт").toBeTruthy();
    expect(record?.role).toBe(ROLE);
    expect(record?.model).toBe(MODEL);
    expect(record?.provider).toBe("anthropic");
    expect(record?.operation).toBe(operation.name);
    expect(record?.action).toBe("discover");
    expect(record?.task_id).toBe("task-audit");
    expect(record?.subtask_id).toBe("step-audit");
  });

  it("значения аргументов в учёт не попадают — только путь поля и тип", async () => {
    const secret = "sk-live-0123456789abcdef0123456789abcdef";
    const api = createUniversalTaskflow([operation], context);
    const out = decode(
      await api.execute("b", {
        action: "invoke",
        operation: operation.name,
        version: 1,
        arguments: { query: 42 },
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("INVALID_ARGUMENTS");

    const record = toolAuditRecords({ role: ROLE, model: MODEL }).find(
      (row) => row.error_code === "INVALID_ARGUMENTS",
    );
    expect(record, "ошибка проверки аргументов должна попасть в учёт").toBeTruthy();
    expect(record?.error_field).toBe("arguments.query");
    expect(record?.error_expected).toContain("строка");
    expect(record?.error_message).not.toContain("42");
    expect(record?.error_message).not.toContain(secret);
    // Всё, что записано про отказ, не содержит и полного текста аргументов.
    const stored = JSON.stringify(record);
    expect(stored).not.toContain(secret);
  });

  it("успешный вызов считается счётчиком, сводка показывает долю ошибок", async () => {
    const before = toolAuditSummary({ role: ROLE, model: MODEL }).totals;
    const api = createUniversalTaskflow([operation], context);
    const out = decode(
      await api.execute("c", {
        action: "invoke",
        operation: operation.name,
        version: 1,
        arguments: { query: "сводка" },
      }),
    );
    expect(out.ok).toBe(true);
    const after = toolAuditSummary({ role: ROLE, model: MODEL }).totals;
    expect(after.calls).toBe(before.calls + 1);
    expect(after.errors).toBe(before.errors);
    expect(after.error_rate).toBeGreaterThan(0);
    const byRole = toolAuditSummary({ role: ROLE, model: MODEL }).by_role.find(
      (row) => row.key === ROLE,
    );
    expect(byRole?.calls).toBe(after.calls);
    const byOperation = toolAuditSummary({ role: ROLE, model: MODEL }).by_operation.find(
      (row) => row.key === operation.name,
    );
    expect(byOperation?.calls).toBeGreaterThan(0);
    const codes = toolAuditSummary({ role: ROLE, model: MODEL }).by_code.map(
      (row) => row.code,
    );
    expect(codes).toContain("ACTION_CONFLICT");
  });

  it("проба учёта проходит и не оставляет мусора", () => {
    expect(checkToolAudit()).toEqual({ ok: true });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE role='tool-audit-probe'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("CSV собирается из тех же записей, что и JSON", () => {
    const records = toolAuditRecords({ role: ROLE, model: MODEL });
    const csv = toolAuditCsv(records);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("error_code");
    expect(lines[0]).toContain("created_at");
    expect(lines.length).toBe(records.length + 1);
  });
});

describe("HTTP: сводка и выгрузка", () => {
  let app: FastifyInstance;
  let token = "";

  beforeAll(async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Audit reader",
        email: `audit-reader-${process.pid}@test`,
        password: "password123",
      },
    });
    expect(res.statusCode).toBe(200);
    token = res.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("без ключа сводка не отдаётся", async () => {
    const res = await app.inject({ method: "GET", url: "/api/role-tool-audit/summary" });
    expect(res.statusCode).toBe(401);
  });

  it("сводка отдаёт числа и разрезы", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.totals.calls).toBe("number");
    expect(typeof body.totals.errors).toBe("number");
    expect(Array.isArray(body.by_role)).toBe(true);
    expect(Array.isArray(body.by_model)).toBe(true);
    expect(Array.isArray(body.by_operation)).toBe(true);
    expect(Array.isArray(body.by_code)).toBe(true);
    expect(body.by_code.some((row: any) => row.code === "ACTION_CONFLICT")).toBe(true);
  });

  it("выгрузка отдаёт JSON и CSV, неизвестный формат отвергается", async () => {
    const json = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=json",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(json.statusCode).toBe(200);
    expect(Array.isArray(json.json().records)).toBe(true);

    const csv = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=csv",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("error_code");

    const bad = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=xml",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("выгрузка не содержит значений аргументов", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=json",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.body).not.toContain("sk-live-");
    expect(res.body).not.toContain("42");
  });
});
