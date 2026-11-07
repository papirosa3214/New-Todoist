// Тесты и UI-проверки ролям — запрещены (владелец 02.11.2026).
//
// Было: бюджет полных прогонов (2 на задачу, 1 не-проверяющей роли), точечные
// тесты не ограничивались — и, главное, обёртка бюджета была написана, но НЕ
// подключена: инструмент `bash` роли никогда не оборачивался, поэтому правило
// не действовало вовсе. Стало: в обычной работе роль не гоняет НИКАКИЕ
// тесты — ни полный набор, ни точечный файл, ни UI-прогон, ни съёмку кадра.
// «Если нужно будет тесты делать — отдельную задачу и дам разрешение на
// тестирование».
//
// Разрешение — на конкретную карточку: `tasks.tests_allowed` (миграция 193).
// Даёт владелец: POST /api/tasks/:id/allow-tests.
//
// Запрет стоит в самом сервере: встроенный инструмент `bash` роли
// оборачивается в `withTestCommandGuard`, и запрещённый запуск не
// выполняется, а возвращается моделью как ошибка инструмента с пояснением.
import db from "../db.js";
import { logEvent } from "../agentState.js";

/** Раннер тестов: бинарник или пакет, которым запускают тесты. */
const RUNNER = /(^|\/)(vitest|jest|mocha|ava|karma|jasmine|playwright|cypress|detox|maestro|appium)$/i;

/** Менеджер пакетов: тесты гоняются через него. */
const PKG = /^(npm|pnpm|yarn|bun)$/i;

/** Обёртки команды: после них идёт команда (`npx vitest`, `timeout 300 vitest`). */
const PREFIXES = new Set([
  "npx", "bunx", "pnpx", "timeout", "env", "sudo", "nohup", "nice", "stdbuf",
  "time", "xargs", "watch", "command", "exec", "dlx",
]);

function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/**
 * Тестовый запуск в любом виде: полный набор, точечный файл, UI-прогон,
 * съёмка кадра экрана.
 *
 * Разбираем каждую простую команду в цепочке (`&&`, `;`, `|`, перевод
 * строки). Слово «vitest» в grep или в имени файла — не запуск: ловим
 * только раннер в позиции команды.
 */
export function isTestCommand(command: string): boolean {
  for (const segment of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    const t = tokens(segment);
    let expectingCommand = true;
    for (let i = 0; i < t.length; i++) {
      const word = t[i];
      if (!expectingCommand) continue;
      // Присваивание переменной окружения — не команда.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      const bare = word.replace(/^.*\//, "").toLowerCase();
      // Обёртки команды: следующее слово — тоже команда.
      if (PREFIXES.has(bare)) continue;
      expectingCommand = false;
      const rest = t.slice(i + 1);
      if (RUNNER.test(word)) return true;
      if (PKG.test(bare)) {
        if (rest[0] === "test") return true;
        if (rest[0] === "run" && (rest[1] === "test" || String(rest[1] ?? "").startsWith("test:"))) return true;
        continue;
      }
      if (bare === "swift" && rest[0] === "test") return true;
      if (bare === "xcodebuild" && rest.some((w) => w === "test" || w === "test-without-building")) return true;
      if (bare === "xcrun" && rest.includes("simctl") && rest.includes("screenshot")) return true;
    }
  }
  return false;
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/** Разрешены ли ролям тесты на этой карточке. */
export function testsAllowedForTask(taskId: string): boolean {
  try {
    const row = db.prepare("SELECT tests_allowed FROM tasks WHERE id = ?").get(taskId) as
      { tests_allowed?: number } | undefined;
    return !!row?.tests_allowed;
  } catch {
    return false;
  }
}

/** Проверяет разрешение на тесты для роли. */
export function checkTestPermission(taskId: string, role: string): BudgetDecision {
  if (testsAllowedForTask(taskId)) return { allowed: true };
  return {
    allowed: false,
    reason:
      `Тесты на этой карточке запрещены (правило владельца от 02.11.2026): роль «${role}» в обычной работе ` +
      "не гоняет ни полный набор, ни точечные тесты, ни UI-прогоны, ни съёмку кадров. " +
      "Нужны тесты — попроси владельца: он поставит отдельную задачу и даст разрешение на тестирование этой карточки. " +
      "Пока разрешения нет — проверяй иначе: читай код, смотри живое поведение, опирайся на проверки других ролей в ленте карточки.",
  };
}

type ToolLike = { name: string; execute: (...args: any[]) => Promise<any> };

/**
 * Оборачивает встроенный `bash` роли. Остальные инструменты возвращаются как
 * есть. Заблокированный запуск не выполняется: инструмент бросает ошибку с
 * пояснением, а в ленте задачи остаётся событие `test_command_blocked`.
 */
export function withTestCommandGuard<T extends ToolLike>(tool: T, ctx: { role: string; taskId: string }): T {
  if (tool.name !== "bash") return tool;
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, ...rest: any[]) => {
      const command = String(params?.command ?? "");
      if (isTestCommand(command)) {
        const decision = checkTestPermission(ctx.taskId, ctx.role);
        if (!decision.allowed) {
          try {
            logEvent({
              taskId: ctx.taskId,
              actorId: null,
              kind: "test_command_blocked",
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
