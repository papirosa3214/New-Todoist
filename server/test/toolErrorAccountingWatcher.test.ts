// Сторож учёта ошибок вызовов инструментов ролей (карточка 64af4c85-…,
// часть 2 «сторож»). Проверяем три вещи:
//  1) проба идёт настоящим шлюзом ролей, живой прибор даёт молчание, а
//     выключенная запись — тревогу;
//  2) следы пробы не остаются в учёте (статистика ошибок не искажается);
//  3) тревога в «Состояние системы» — не чаще одного раза в сутки.
//
// «Запись выключена» воспроизводится триггером на role_tool_audit: шлюз
// продолжает отвечать роли как обычно (учёт — побочный эффект), а строки
// учёта не появляются. Это ровно тот сценарий, который сторож обязан ловить.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import db from "../src/db.js";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  TOOL_ERROR_ACCOUNTING_WATCH_TYPE,
  alertToolErrorAccounting,
  checkToolErrorAccounting,
  evaluateToolAudit,
  type ToolAuditEvidence,
  type ToolAuditProbe,
} from "../src/runtime/toolErrorAccountingWatcher.js";

const PROBE_ROLE = "tool_audit_watch_probe";
const OWNER_ID = "watch-owner";

beforeAll(() => {
  // Полная настоящая схема: проба должна ходить по тому же каталогу
  // операций, что и роль, а он читает users/roles из базы.
  migrate();
  runMigrations();
  db.prepare(
    "INSERT OR REPLACE INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,'owner')",
  ).run(OWNER_ID, "Владелец для теста сторожа", "watch-owner@test.local", "x");
});

beforeEach(() => {
  db.prepare("DELETE FROM role_tool_audit").run();
  db.prepare("DELETE FROM role_tool_audit_counters").run();
  db.prepare("DELETE FROM notifications WHERE type = ?").run(
    TOOL_ERROR_ACCOUNTING_WATCH_TYPE,
  );
  db.exec("DROP TRIGGER IF EXISTS watch_block_audit");
});

afterEach(() => {
  db.exec("DROP TRIGGER IF EXISTS watch_block_audit");
});

/** «Запись выключена»: таблица на месте, строки учёта не появляются. */
function disableRecording(): void {
  db.exec(
    `CREATE TRIGGER watch_block_audit BEFORE INSERT ON role_tool_audit
     BEGIN SELECT RAISE(ABORT, 'учёт выключен'); END;`,
  );
}

/** Доказательства живого прибора: отказ записан, вызовы посчитаны. */
function liveEvidence(): ToolAuditEvidence {
  return {
    rows: [
      {
        id: "row-1",
        role: PROBE_ROLE,
        model: "tool-audit-watch-probe",
        operation: "taskflow_task",
        error_code: "INVALID_ARGUMENTS",
      },
    ],
    countersSupported: true,
    calls: 3,
    errors: 2,
    byOperation: {
      taskflow_task: { calls: 1, errors: 1 },
      taskflow_rules: { calls: 1, errors: 0 },
    },
  };
}

const rejectedProbes: ToolAuditProbe[] = [
  { kind: "rejected", operation: "taskflow_task", code: "INVALID_ARGUMENTS" },
  { kind: "rejected", operation: "taskflow_probe", code: "UNKNOWN_OPERATION" },
  { kind: "accepted", operation: "taskflow_rules", code: "OK" },
];

describe("сторож учёта ошибок вызовов инструментов", () => {
  it("живой прибор: проба через настоящий шлюз записана, сторож молчит", async () => {
    const result = await checkToolErrorAccounting();
    const rejected = result.probes.filter((probe) => probe.kind === "rejected");
    expect(rejected.map((probe) => probe.code)).toContain("INVALID_ARGUMENTS");
    expect(rejected.map((probe) => probe.code)).toContain("UNKNOWN_OPERATION");
    // Успешный вызов тоже проверяется: без счётчика успешных вызовов доля
    // ошибок в сводке неверна.
    expect(result.probes.some((probe) => probe.kind === "accepted")).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("проба не оставляет следов в учёте", async () => {
    await checkToolErrorAccounting();
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM role_tool_audit WHERE role = ?")
      .get(PROBE_ROLE) as { n: number };
    expect(rows.n).toBe(0);
    const counters = db
      .prepare(
        "SELECT COUNT(*) AS n FROM role_tool_audit_counters WHERE role = ?",
      )
      .get(PROBE_ROLE) as { n: number };
    expect(counters.n).toBe(0);
  });

  it("запись выключена: сторож ловит поломку и поднимает тревогу", async () => {
    disableRecording();
    const result = await checkToolErrorAccounting();
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("не попал в учёт");
    // Шлюз при выключенной записи продолжает отвечать роли — учёт побочный.
    expect(result.probes.some((probe) => probe.kind === "rejected")).toBe(true);
    expect(alertToolErrorAccounting(result.problems)).toBe(true);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = ?")
      .get(TOOL_ERROR_ACCOUNTING_WATCH_TYPE) as { n: number };
    expect(rows.n).toBeGreaterThan(0);
  });

  it("запись вернулась: сторож снова молчит", async () => {
    disableRecording();
    expect((await checkToolErrorAccounting()).ok).toBe(false);
    db.exec("DROP TRIGGER watch_block_audit");
    expect((await checkToolErrorAccounting()).ok).toBe(true);
  });

  it("живой прибор: суд по доказательствам не находит замечаний", () => {
    expect(evaluateToolAudit(rejectedProbes, liveEvidence())).toEqual([]);
  });

  it("отказ не записан — суд называет поломку", () => {
    const problems = evaluateToolAudit(rejectedProbes, {
      ...liveEvidence(),
      rows: [],
    });
    expect(problems.join(" ")).toContain("не попал в учёт");
  });

  it("в записи нет кода ошибки — суд называет поломку", () => {
    const problems = evaluateToolAudit(rejectedProbes, {
      ...liveEvidence(),
      rows: [{ id: "row-1", role: PROBE_ROLE, model: "m", operation: "op" }],
    });
    expect(problems.join(" ")).toContain("кода ошибки");
  });

  it("успешный вызов не посчитан — суд называет поломку", () => {
    const problems = evaluateToolAudit(rejectedProbes, {
      ...liveEvidence(),
      byOperation: { taskflow_task: { calls: 1, errors: 1 } },
    });
    expect(problems.join(" ")).toContain("доля ошибок");
  });

  it("тревога: одно уведомление в сутки, а не по одному на каждый сбой", () => {
    expect(alertToolErrorAccounting(["отказ не попал в учёт"])).toBe(true);
    expect(alertToolErrorAccounting(["отказ не попал в учёт"])).toBe(false);
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE type = ? AND user_id = ?",
      )
      .get(TOOL_ERROR_ACCOUNTING_WATCH_TYPE, OWNER_ID) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("тревога без причин не создаётся", () => {
    expect(alertToolErrorAccounting([])).toBe(false);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = ?")
      .get(TOOL_ERROR_ACCOUNTING_WATCH_TYPE) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("текст тревоги объясняет, что сломано и что делать", () => {
    alertToolErrorAccounting(["отказ пробного вызова не попал в учёт"]);
    const row = db
      .prepare("SELECT text FROM notifications WHERE type = ? LIMIT 1")
      .get(TOOL_ERROR_ACCOUNTING_WATCH_TYPE) as { text: string };
    expect(row.text).toContain("не попал в учёт");
    expect(row.text).toContain("сводка");
    expect(row.text).toContain("Проверить");
  });
});
