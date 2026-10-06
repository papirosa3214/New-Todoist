// Бюджет полных прогонов серверного набора тестов (владелец 06.10.2026).
//
// Прецедент: Разработчик карточки 71651ad0 за один шаг 9 раз гонял весь набор
// (8 минут из 40) и 89 раз точечные тесты, ни разу не позвав помощь. Полный
// набор — работа QA, а не Разработчика. Поэтому сервер сам ограничивает:
//   • на ЗАДАЧУ — не больше двух полных прогонов всеми ролями вместе;
//   • Разработчику (и любой роли, кроме QA и Критика) — один полный прогон.
// Точечные тесты (`vitest run test/файл.test.ts`) не ограничиваются.
//
// Ограничение стоит в самом сервере: встроенный инструмент `bash` роли
// оборачивается в `withTestRunBudget`, и «лишний» полный прогон не запускается,
// а возвращается моделью как ошибка инструмента с пояснением, что делать.
import db from "../db.js";
import { logEvent } from "../agentState.js";

/** Сколько полных прогонов разрешено на одну задачу всем ролям вместе. */
export const FULL_RUNS_PER_TASK = 2;
/** Сколько из них доступно роли, которая не проверяет (Разработчик и др.). */
export const FULL_RUNS_PER_NON_CHECKING_ROLE = 1;
/** Роли, чья работа — проверка: им остаётся остаток общего бюджета. */
const CHECKING_ROLES = new Set(["qa", "critic_verifier"]);

// Флаги тест-раннера, у которых значение идёт отдельным словом: его нельзя
// принять за фильтр по файлу.
const FLAGS_WITH_VALUE = new Set([
  "--reporter", "--config", "-c", "--root", "-r", "--dir", "--project", "--pool",
  "--outputfile", "--testtimeout", "--environment", "--shard", "--mode", "--coverage.reporter",
]);

function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** Есть ли среди слов после раннера указание, ЧТО именно гонять (файл, папка, фильтр). */
function hasTarget(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a === "-t" || a.startsWith("--testNamePattern") || a === "--related" || a === "related" || a === "--changed" || a === "--findRelatedTests") return true;
    if (a.startsWith("-")) {
      if (!a.includes("=") && FLAGS_WITH_VALUE.has(a.toLowerCase())) i++;
      continue;
    }
    if (a === "run" || a === "watch" || a === "dev" || a === "test") continue;
    return true; // любое оставшееся слово — путь или фильтр
  }
  return false;
}

/**
 * Команда запускает ВЕСЬ набор тестов? Разбираем каждую простую команду в
 * цепочке (`&&`, `;`, `|`, перевод строки). Прогон по файлу/папке/фильтру —
 * точечный и под ограничение не попадает.
 */
export function isFullSuiteCommand(command: string): boolean {
  for (const segment of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    const t = tokens(segment);
    const idx = t.findIndex(w => /(^|\/)(vitest|jest)$/.test(w));
    if (idx >= 0) {
      if (!hasTarget(t.slice(idx + 1))) return true;
      continue;
    }
    const pm = t.findIndex(w => /^(npm|pnpm|yarn|bun)$/.test(w));
    if (pm >= 0) {
      const rest = t.slice(pm + 1);
      const testIdx = rest.findIndex(w => w === "test");
      if (testIdx >= 0 && (testIdx === 0 || rest[0] === "run" || rest[0] === "run-script")) {
        const afterTest = rest.slice(testIdx + 1);
        const dashdash = afterTest.indexOf("--");
        const tail = dashdash >= 0 ? afterTest.slice(dashdash + 1) : afterTest;
        if (!hasTarget(tail)) return true;
      }
    }
  }
  return false;
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/** Проверяет бюджет и, если полный прогон разрешён, сразу списывает его. */
export function checkAndConsumeFullRun(taskId: string, role: string): BudgetDecision {
  const rows = db
    .prepare("SELECT role, full_runs FROM test_run_budget WHERE task_id = ?")
    .all(taskId) as Array<{ role: string; full_runs: number }>;
  const total = rows.reduce((n, r) => n + r.full_runs, 0);
  const mine = rows.find(r => r.role === role)?.full_runs ?? 0;
  const checking = CHECKING_ROLES.has(role);

  if (!checking && mine >= FULL_RUNS_PER_NON_CHECKING_ROLE) {
    return {
      allowed: false,
      reason:
        `Полный прогон серверного набора тебе уже недоступен: роли «${role}» разрешён ${FULL_RUNS_PER_NON_CHECKING_ROLE} полный прогон на задачу, он использован. ` +
        "Дальше гоняй только затронутые тесты: `vitest run test/<файл>.test.ts`. Весь набор запускает QA. " +
        "Если застрял на одном и том же тесте — не повторяй запуск, а позови вышестоящую модель (`taskflow_consult`).",
    };
  }
  if (total >= FULL_RUNS_PER_TASK) {
    return {
      allowed: false,
      reason:
        `Полные прогоны серверного набора на эту задачу исчерпаны: разрешено ${FULL_RUNS_PER_TASK} на всех ролей, они использованы. ` +
        "Запускай только затронутые тесты (`vitest run test/<файл>.test.ts`) и опирайся на результаты прежних полных прогонов в ленте задачи. " +
        "Нужен ещё один полный прогон — напиши оркестратору (`taskflow_consult`).",
    };
  }
  db.prepare(
    `INSERT INTO test_run_budget(task_id, role, full_runs) VALUES (?, ?, 1)
     ON CONFLICT(task_id, role) DO UPDATE SET full_runs = full_runs + 1, updated_at = datetime('now')`,
  ).run(taskId, role);
  return { allowed: true };
}

type ToolLike = { name: string; execute: (...args: any[]) => Promise<any> };

/**
 * Оборачивает встроенный `bash` роли. Остальные инструменты возвращаются как
 * есть. Заблокированный запуск не выполняется: инструмент бросает ошибку с
 * пояснением, а в ленте задачи остаётся событие `test_budget_blocked`.
 */
export function withTestRunBudget<T extends ToolLike>(tool: T, ctx: { role: string; taskId: string }): T {
  if (tool.name !== "bash") return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, ...rest: any[]) => {
      const command = String(params?.command ?? "");
      if (isFullSuiteCommand(command)) {
        const decision = checkAndConsumeFullRun(ctx.taskId, ctx.role);
        if (!decision.allowed) {
          try {
            logEvent({
              taskId: ctx.taskId,
              actorId: null,
              kind: "test_budget_blocked",
              field: ctx.role,
              toValue: command.slice(0, 160),
            });
          } catch {
            /* журнал побочный: запрет всё равно действует */
          }
          throw new Error(decision.reason);
        }
      }
      return original(toolCallId, params, ...rest);
    },
  } as T;
}
