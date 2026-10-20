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

  it("сводка не отдаёт полуфильтр по коду: его разрез считается только выгрузкой", async () => {
    const plain = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    const narrowed = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/summary?code=ACTION_CONFLICT",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(narrowed.statusCode).toBe(200);
    // Счётчики не знают про код ошибки, поэтому сводка этот параметр не берёт:
    // иначе итоги остались бы общими, а разбивка по кодам сузилась бы —
    // ответ выглядел бы отфильтрованным, не будучи им.
    expect(narrowed.json().totals).toEqual(plain.json().totals);
    expect(narrowed.json().by_code).toEqual(plain.json().by_code);
    // А выгрузка код понимает и действительно сужает записи.
    const exported = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=json&code=ACTION_CONFLICT",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exported.statusCode).toBe(200);
    const codes = exported.json().records.map((row: any) => row.error_code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((code: string) => code === "ACTION_CONFLICT")).toBe(true);
  });

  it("выгрузка не содержит значений аргументов", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/role-tool-audit/export?format=json",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("sk-live-");
    // Проверяем сами записи, а не весь ответ: в метках времени `created_at`
    // и в границах периода случайно встречаются те же цифры, и проверка по
    // всему телу падала не из-за утечки аргументов.
    const records = res.json().records as Array<Record<string, unknown>>;
    const leaked = records.map((row) => ({
      error_message: row.error_message,
      error_field: row.error_field,
      error_expected: row.error_expected,
    }));
    expect(JSON.stringify(leaked)).not.toContain("42");
    for (const row of leaked)
      expect(Object.values(row).join(" ")).not.toContain("sk-live-");
  });
});

describe("тренер ошибок и учёт вместе: слияние ветки с main", () => {
  // У каждой проверки свой модель-маркер: записи учёта не мешают друг другу.
  const MERGE_MODEL = "claude-merge-probe";
  const mergeContext = { ...context, model: MERGE_MODEL };

  it("третья ошибка подряд приходит с тренером, и все три отказа — в журнале", async () => {
    const api = createUniversalTaskflow([operation], {
      ...mergeContext,
      runId: "run-merge-1",
    });
    // Без action шлюз сам понимает вызов с operation как invoke — в журнал
    // должно попасть именно это действие, а не пустое поле.
    const call = () =>
      api
        .execute("m", { operation: operation.name, arguments: { query: 42 } })
        .then(decode);

    expect((await call()).error.coach).toBeUndefined();
    expect((await call()).error.coach).toBeUndefined();
    const third = await call();
    expect(third.error.code).toBe("INVALID_ARGUMENTS");
    expect(third.error.coach.message).toMatch(/СТОП/);

    const rows = toolAuditRecords({ role: ROLE, model: MERGE_MODEL });
    expect(rows.length).toBe(3);
    // Учёт — внешняя обёртка: в журнал попало то, что увидела роль, вместе
    // с сообщением тренера об остановке. Записи одной секунды упорядочены по
    // id, а не по времени, поэтому тренерскую ищем по содержимому.
    const coached = rows.filter((row) =>
      String(row.error_message ?? "").includes("Тренер:"),
    );
    expect(coached.length).toBe(1);
    expect(coached[0].error_message).toContain("СТОП");
    expect(coached[0].action).toBe("invoke");
    expect(coached[0].operation).toBe(operation.name);
    expect(coached[0].error_field).toBe("arguments.query");
    expect(coached[0].error_code).toBe("INVALID_ARGUMENTS");
  });

  it("успех обнуляет счётчик тренера, разные операции считаются отдельно", async () => {
    const another = {
      name: "taskflow_task_status",
      description: "статус задачи",
      parameters: Type.Object({ id: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "ок" }] }),
    };
    const api = createUniversalTaskflow([operation, another], {
      ...mergeContext,
      runId: "run-merge-2",
    });
    const bad = () =>
      api
        .execute("m", { operation: operation.name, arguments: { query: 42 } })
        .then(decode);
    const badOther = () =>
      api
        .execute("o", { operation: another.name, arguments: { id: 5 } })
        .then(decode);

    expect((await bad()).error.coach).toBeUndefined();
    expect((await bad()).error.coach).toBeUndefined();
    // Успешный вызов той же операции обнуляет счёт.
    const ok = await api
      .execute("ok", {
        action: "invoke",
        operation: operation.name,
        version: 1,
        arguments: { query: "сводка" },
      })
      .then(decode);
    expect(ok.ok).toBe(true);
    expect((await bad()).error.coach).toBeUndefined();

    // Ошибки другой операции свой счёт не поднимают и чужой не обнуляют.
    expect((await badOther()).error.coach).toBeUndefined();
    expect((await badOther()).error.coach).toBeUndefined();
    expect((await bad()).error.coach).toBeUndefined();
    expect((await badOther()).error.coach.message).toMatch(/СТОП/);
  });

  it("счётчик ошибок не зависит от записи в журнал", async () => {
    // Запись в учёт отключена так же, как это делает сторож: триггер на вставку.
    db.exec(
      "CREATE TRIGGER merge_block_audit BEFORE INSERT ON role_tool_audit BEGIN SELECT RAISE(ABORT,'x'); END;",
    );
    try {
      const before = toolAuditRecords({ role: ROLE, model: MERGE_MODEL }).length;
      const api = createUniversalTaskflow([operation], {
        ...mergeContext,
        runId: "run-merge-3",
      });
      const call = () =>
        api
          .execute("m", { operation: operation.name, arguments: { query: 42 } })
          .then(decode);
      await call();
      await call();
      // Журнал молчит, а тренер всё равно останавливает роль на третьей ошибке.
      expect((await call()).error.coach.message).toMatch(/СТОП/);
      expect(toolAuditRecords({ role: ROLE, model: MERGE_MODEL }).length).toBe(
        before,
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS merge_block_audit");
    }
  });
});

describe("провайдер в учёте вызовов", () => {
  // Провайдер в записи об отказе — это то, по чему владелец понимает,
  // у кого истёк ключ или исчерпан лимит. Модель в ходе приходит как
  // «провайдер/модель», поэтому провайдер берётся из префикса.
  const probe = async (model: string, runId: string) => {
    const api = createUniversalTaskflow([operation], {
      ...context,
      model,
      runId,
    });
    const out = decode(
      await api.execute("p", {
        action: "discover",
        operation: operation.name,
        query: "сводка",
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("ACTION_CONFLICT");
    return toolAuditRecords({ role: ROLE, model }).find(
      (row) => row.error_code === "ACTION_CONFLICT",
    );
  };

  it("модель с префиксом: провайдер из префикса, а не из эвристики", async () => {
    const model = "opencode-go/deepseek-v4.1-flash";
    const record = await probe(model, "run-provider-1");
    expect(record, "отказ должен попасть в учёт").toBeTruthy();
    expect(record?.provider).toBe("opencode-go");
  });

  it("известный провайдер из префикса не путается с minimax", async () => {
    const model = "minimax/MiniMax-M3.1-Flash";
    const record = await probe(model, "run-provider-2");
    expect(record?.provider).toBe("minimax");
  });

  it("модель без префикса: провайдер по старой эвристике", async () => {
    const record = await probe("claude-audit-probe-2", "run-provider-3");
    expect(record?.provider).toBe("anthropic");
  });

  it("в счётчиках успешных вызовов провайдер тот же", async () => {
    const model = "opencode-go/deepseek-v4.1-flash";
    const api = createUniversalTaskflow([operation], {
      ...context,
      model,
      runId: "run-provider-4",
    });
    const out = decode(
      await api.execute("p", {
        action: "invoke",
        operation: operation.name,
        version: 1,
        arguments: { query: "сводка" },
      }),
    );
    expect(out.ok).toBe(true);
    const counters = db
      .prepare(
        "SELECT provider FROM role_tool_audit_counters WHERE role = ? AND model = ?",
      )
      .all(ROLE, model) as Array<{ provider: string }>;
    expect(counters.length).toBeGreaterThan(0);
    expect(
      counters.every((row) => row.provider === "opencode-go"),
      "в счётчике провайдер должен быть тем же, что и в журнале",
    ).toBe(true);
  });
});
