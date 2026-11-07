/**
 * Живой прогон сценария владельца по карточке e73e7314 (D3).
 *
 * Три пункта владельца, которые надо доказать не рассуждением, а прогоном:
 *   1. роль, у которой были СЛУЖЕБНЫЕ отказы, продолжает ход;
 *   2. роль с ТРЕМЯ НАСТОЯЩИМИ отказами одной операции — останавливается
 *      (шаг в blocked, попытка закрыта, владелец уведомлён);
 *   3. настоящий отказ со словами «not found» (task not found) — именно
 *      третий пункт D1: он не служебный и обязан попадать в счётчик.
 *
 * Прогон настоящий: тот же каталог инструментов роли, та же запись учёта в
 * `role_tool_audit`, тот же сторож зависших шагов и та же остановка хода.
 * Отличается от живого сервера только база: она временная и создаётся здесь
 * же (в боевую базу прогон не пишет).
 *
 * Запуск:
 *   cd server && TMPDIR=$HOME/tmp npx tsx scripts/proof-owner-error-loop-scenario.ts
 *
 * Вывод — таблица «сценарий → ожидание → факт» и JSON в конце.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dbPath = path.join(
  os.tmpdir(),
  `taskflow-proof-${crypto.randomBytes(4).toString("hex")}.db`,
);
process.env.DB_PATH = dbPath;
process.env.JWT_SECRET ??= "proof-secret";
process.env.TASKFLOW_ALLOW_REGISTRATION = "1";
process.env.TASKFLOW_KICK_IN_TESTS = "";
process.env.TASKFLOW_TEST_PROJECT_DIR = path.join(os.tmpdir(), "taskflow-proof-project");
process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "taskflow-proof-pi-agent");
for (const dir of [process.env.TASKFLOW_TEST_PROJECT_DIR, process.env.PI_CODING_AGENT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = (await import("../src/db.js")).default;
const { migrate } = await import("../src/db.js");
const { runMigrations } = await import("../src/migrations.js");
const { buildApp } = await import("../src/index.js");
const { buildRoleToolCatalog } = await import("../src/runtime/roleToolCatalog.js");
const { toolOutcomeStats } = await import("../src/runtime/errorLoopStop.js");
const { runStalledStepWatch } = await import("../src/runtime/stalledStepWatcher.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("../test/helpers/seedOwner.js");

migrate();
runMigrations();
demoteSeededOwner(db);
seedRoleAccounts(db);

const app = await buildApp();

type Fixture = { taskId: string; subtaskId: string; attemptId: string };
const auth = { authorization: "" };

async function newOwnerToken(): Promise<void> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      name: "Proof owner",
      email: `proof-${Date.now()}-${Math.random()}@test`,
      password: "password123",
    },
  });
  const userId = reg.json().user.id;
  db.prepare("UPDATE users SET role = 'owner', task_intake_mode = 'manual' WHERE id = ?").run(userId);
  auth.authorization = `Bearer ${reg.json().token}`;
}

async function newStep(title: string): Promise<Fixture> {
  const task = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: auth,
    payload: { title },
  });
  const taskId = task.json().task.id;
  const plan = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/collaboration-plans`,
    headers: auth,
    payload: {
      profile: "manual",
      rationale: "живой прогон сценария владельца",
      nodes: [
        { slot_key: "executor", role_key: "builder", required: true, expected_result: "Реализация" },
      ],
      edges: [],
    },
  });
  const planId = plan.json().id ?? plan.json().plan?.id;
  const approve = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/collaboration-plans/${planId}/approve`,
    headers: auth,
  });
  if (approve.statusCode >= 300) throw new Error(`план не утверждён: ${approve.statusCode}`);
  const row = db
    .prepare("SELECT id FROM subtasks WHERE task_id = ? AND plan_node_key = 'executor'")
    .get(taskId) as { id: string };
  const attemptId = `proof-attempt-${crypto.randomBytes(3).toString("hex")}`;
  db.prepare(
    `INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(attemptId, taskId, row.id, "role_builder");
  db.prepare(
    `UPDATE subtasks
        SET agent_state = 'in_progress', agent_id = 'role_builder',
            current_attempt_id = ?, agent_heartbeat_at = datetime('now')
      WHERE id = ?`,
  ).run(attemptId, row.id);
  return { taskId, subtaskId: row.id, attemptId };
}

/** Отказ ровно так, как его видит каталог: событие конца вызова от рантайма. */
function refusal(catalog: any, tool: string, callId: string, text: string): boolean {
  return catalog.onToolExecutionEnd({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: tool,
    isError: true,
    result: { content: [{ type: "text", text }] },
  });
}

const rows: Array<{ scenario: string; expected: string; fact: string; ok: boolean }> = [];
const note = (scenario: string, expected: string, fact: string, ok: boolean) =>
  rows.push({ scenario, expected, fact, ok });

// ── Сценарий 1: служебные отказы не роняют ход ────────────────────────────
{
  await newOwnerToken();
  const step = await newStep("Прогон: служебные отказы");
  const catalog = buildRoleToolCatalog({
    role: "builder",
    mode: "work",
    runId: `proof-service-${Date.now()}`,
    taskId: step.taskId,
    subtaskId: step.subtaskId,
  });
  const serviceTexts = [
    "Действие не начато: поступило уточнение. Сначала учти новое сообщение, затем заново выбери нужные действия.",
    "Чек-лист прошлого поручения закрыт — действие отклонено",
    "Действие устаревшего хода отклонено",
    "Действие не начато: поступило уточнение. Сначала учти новое сообщение, затем заново выбери нужные действия.",
  ];
  let stopped = false;
  serviceTexts.forEach((text, index) => {
    stopped = refusal(catalog, "taskflow_task", `svc-${index}`, text) || stopped;
  });
  // Роль всё-таки дорабатывает: одно успешное действие после служебных отказов.
  const rules = catalog.customTools.find((tool: any) => tool.name === "taskflow_rules");
  await rules.execute("svc-ok", {});

  const stats = toolOutcomeStats(step.subtaskId, 10);
  const report = await runStalledStepWatch();
  const after = db
    .prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?")
    .get(step.subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
  const finished = db
    .prepare("SELECT outcome FROM attempts WHERE id = ?")
    .get(step.attemptId) as { outcome: string | null };
  const ok =
    !stopped &&
    stats.serviceRefusals === 4 &&
    stats.errors === 0 &&
    stats.ok === 1 &&
    report.blocked === 0 &&
    after.agent_state === "in_progress" &&
    after.current_attempt_id === step.attemptId &&
    finished.outcome === null;
  note(
    "Служебные отказы (уточнение, закрытый чек-лист, устаревший ход) + успешный вызов",
    "ход жив: 4 служебных отказа видны, ошибок 0, шаг в работе, сторож не блокирует",
    `отказов ${stopped ? "ход остановлен" : "нет"}; служебных ${stats.serviceRefusals}, ` +
      `настоящих ошибок ${stats.errors}, успешных ${stats.ok}; ` +
      `заблокировано сторожем ${report.blocked}; шаг ${after.agent_state}, попытка ${finished.outcome ?? "открыта"}`,
    ok,
  );
}

// ── Сценарий 2: три настоящих отказа одной операции ──────────────────────
{
  await newOwnerToken();
  const step = await newStep("Прогон: настоящий отказ");
  const catalog = buildRoleToolCatalog({
    role: "builder",
    mode: "work",
    runId: `proof-real-${Date.now()}`,
    taskId: step.taskId,
    subtaskId: step.subtaskId,
  });
  // «task not found» — настоящая ошибка аргументов: D1 в чистом виде. До правки
  // этот текст считался служебным отказом и роль не останавливалась.
  const first = refusal(catalog, "taskflow_task", "real-1", "404: task not found");
  const second = refusal(catalog, "taskflow_task", "real-2", "404: task not found");
  const third = refusal(catalog, "taskflow_task", "real-3", "404: task not found");
  const stats = toolOutcomeStats(step.subtaskId, 10);
  // Каталог на третьем отказе запускает остановку хода; дожидаемся её и
  // проверяем итог по базе, а не по обещанию.
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Сторож после уже остановленного хода не должен ни блокировать, ни
  // уведомлять второй раз.
  const report = await runStalledStepWatch();
  const after = db
    .prepare("SELECT agent_state, current_attempt_id FROM subtasks WHERE id = ?")
    .get(step.subtaskId) as { agent_state: string | null; current_attempt_id: string | null };
  const finished = db
    .prepare("SELECT outcome FROM attempts WHERE id = ?")
    .get(step.attemptId) as { outcome: string | null };
  const notified = (
    db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE task_id = ? AND type = 'error_loop_blocked'")
      .get(step.taskId) as { n: number }
  ).n;
  const ok =
    !first &&
    !second &&
    third &&
    stats.errors === 3 &&
    stats.loopErrors === 3 &&
    stats.ok === 0 &&
    report.blocked === 0 &&
    after.agent_state === "blocked" &&
    after.current_attempt_id === null &&
    finished.outcome === "error_loop" &&
    notified === 1;
  note(
    "Три настоящих отказа taskflow_task («task not found») подряд",
    "третий отказ останавливает ход: шаг blocked, попытка error_loop, владелец уведомлён",
    `стоп на 3-м вызове ${third}; настоящих ошибок ${stats.errors}, цикл по одной операции ${stats.loopErrors}, ` +
      `успешных ${stats.ok}; повторно заблокировано сторожем ${report.blocked}; шаг ${after.agent_state}, ` +
      `попытка ${finished.outcome ?? "открыта"}, уведомлений владельцу ${notified}`,
    ok,
  );
}

// ── Сценарий 3: dup_of у повтора ─────────────────────────────────────────
{
  await newOwnerToken();
  const step = await newStep("Прогон: повтор действия");
  const catalog = buildRoleToolCatalog({
    role: "builder",
    mode: "work",
    runId: `proof-dup-${Date.now()}`,
    taskId: step.taskId,
    subtaskId: step.subtaskId,
  });
  refusal(catalog, "taskflow_task", "dup-1", "404: task not found");
  refusal(catalog, "taskflow_task", "dup-2", "404: task not found");
  const audit = db
    .prepare(
      `SELECT id, dup_of, error_code FROM role_tool_audit
        WHERE subtask_id = ? ORDER BY rowid ASC`,
    )
    .all(step.subtaskId) as Array<{ id: string; dup_of: string | null; error_code: string }>;
  const ok =
    audit.length === 2 &&
    audit[0].error_code === "INVALID_ARGUMENTS" &&
    audit[0].dup_of === null &&
    audit[1].dup_of === audit[0].id;
  note(
    "Повтор того же отказа: событие действия (A1)",
    "вторая запись ссылается на первую через dup_of",
    `записей ${audit.length}; dup_of первой ${audit[0]?.dup_of ?? "нет"}, второй ${audit[1]?.dup_of === audit[0]?.id ? "указывает на первую" : String(audit[1]?.dup_of)}`,
    ok,
  );
}

await app.close();

const report = {
  checked_at: new Date().toISOString(),
  database: dbPath,
  scenarios: rows,
  passed: rows.filter((row) => row.ok).length,
  total: rows.length,
};
console.log("\nСценарий | Ожидание | Факт | Итог");
for (const row of rows) {
  console.log(`\n• ${row.scenario}\n  ожидание: ${row.expected}\n  факт: ${row.fact}\n  итог: ${row.ok ? "OK" : "ПРОВАЛ"}`);
}
console.log(`\nИтого: ${report.passed}/${report.total}`);
console.log(JSON.stringify(report, null, 1));
process.exitCode = report.passed === report.total ? 0 : 1;
