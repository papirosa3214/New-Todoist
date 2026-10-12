// Владелец 30.09.2026: пять специальных инструментов Исследователя
// (web_search, web_get, ocr, youtube, local_model) были заведены в
// профиле researcher.json для СТАРОЙ схемы (внешний Pi-процесс говорит по
// MCP) и молча перестали работать 23.09.2026, когда роли переехали
// исполняться внутри сервера — внешние MCP там не подключаются вообще.
// Этот файл проверяет только границу: инструменты видны РОВНО researcher
// и никому больше. Сама работа процесса (запись в stdin, разбор JSON из
// stdout) — реальный, не смоделированный вызов python, проверена живым
// прогоном на .110 (не юнит-тестом: мокать node:child_process ради
// нескольких строк передачи данных менее убедительно, чем факт, что
// процесс правда стартует и правда отвечает).
import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { taskflowTools, inProcessToolNames } from "../src/runtime/inProcessRun.js";

const RESEARCH_TOOL_NAMES = ["web_search", "web_get", "ocr", "youtube", "local_model"];

/** Список канонических учёток ролей. Нужен `isOrchestrator(roleUserId(role))`
 *  в `orchestratorTools()` — без строки в `users` он валится на отсутствии
 *  таблицы или возвращает undefined, и тест хочет видеть чистый набор
 *  инструментов роли без побочных оркестраторских инструментов.
 *  Миграции 056/058 заполняют `roles` и привязку `role_key`, но
 *  канонические учётки `role_<key>` заводит отдельный шаг (та же
 *  регистрация, что и для `role_builder` в `agentRulesManifest.test.ts`). */
const ROLE_ACCOUNTS = [
  "researcher", "builder", "qa", "architect",
  "designer", "analyst", "critic_verifier",
  "secretary",
];

describe("research-инструменты — видны только Исследователю", () => {
  beforeAll(() => {
    // Базовая схема из db.ts:migrate() нужна раньше, чем inProcessRun /
    // orchestratorTools впервые полезут в db.prepare. setup.ts уже
    // задал DB_PATH на tmp-файл, так что импорт db выше открыл пустую
    // БД; здесь её наполняем.
    migrate();
    runMigrations();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, password_hash, role, role_key, type, is_system_bot)
       VALUES (?, ?, ?, '!', 'agent', ?, 'ai', 1)`,
    );
    for (const key of ROLE_ACCOUNTS) {
      ins.run(
        `role_${key}`,
        `Role ${key}`,
        `role-${key}@research-tools.test`,
        key,
      );
    }
  });

  it("researcher получает все пять, в дополнение к обычным taskflow_*", () => {
    const names = taskflowTools("researcher", null).map((t) => t.name);
    for (const tool of RESEARCH_TOOL_NAMES) expect(names).toContain(tool);
    expect(names).toContain("taskflow_task"); // обычные тоже остаются
  });

  it("ни одна другая роль их не получает", () => {
    for (const role of ["builder", "qa", "architect", "designer", "analyst", "critic_verifier"]) {
      const names = taskflowTools(role, null).map((t) => t.name);
      for (const tool of RESEARCH_TOOL_NAMES) expect(names).not.toContain(tool);
    }
  });

  it("экран «Команда» (inProcessToolNames, role='') их тоже не показывает", () => {
    const names = inProcessToolNames();
    for (const tool of RESEARCH_TOOL_NAMES) expect(names).not.toContain(tool);
  });
});
