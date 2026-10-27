import crypto from "node:crypto";
import { BUDGET_CASE_SCHEMA } from "./runtime/chatBudgetCases.js";
import { ROLE_TOOL_REQUEST_SCHEMA } from "./routes/role-tool-requests.js";
import { OBSERVABILITY_SCHEMA } from "./lib/contextObservability.js";
import { TOOL_REQUEST_SCHEMA } from "./runtime/toolRequestStore.js";
import { TOOL_AUDIT_SCHEMA } from "./runtime/toolAuditStore.js";
import { KNOWN_MODEL_PROVIDERS } from "./lib/attemptModel.js";
import { installReviewHistory } from "./lib/reviewHistory.js";
// Версионные миграции — поверх базовой схемы из `db.ts:migrate()`.
//
// Правило разделения (одно и то же в обеих шапках — здесь и в db.ts):
//  — `db.ts:migrate()` хранит ТОЛЬКО CREATE TABLE IF NOT EXISTS и
//    идемпотентные ALTER TABLE (PRAGMA table_info → ADD COLUMN, no-op если
//    колонка уже есть). Никаких записей в schema_migrations, никаких
//    заполнений данными, никаких пересборки таблиц.
//  — здесь — всё, что должно быть пронумеровано, зафиксировано в
//    `schema_migrations` и применено ОДИН раз: новые таблицы, триггеры,
//    пересборки, заполнения, необратимые ALTER. Дублировать с migrate()
//    НЕЛЬЗЯ — на живой БД ALTER выполнится дважды и упадёт, на свежей —
//    наложится на CREATE TABLE и тоже упадёт.
// `migrate()` идемпотентна и выполняется на каждом старте (см. KB
// 2026-08-29 про tsx watch — именно поэтому дубль ловили только на живой
// базе, на свежей она упала бы ещё на первом старте). Переписывать её
// ради красоты не стали — «не переписывать существующее ради красоты»
// (см. память Максима).
//
// `001_baseline` не содержит кода — это ярлык на всё, что уже делает
// migrate(), зафиксированный как отправная точка. Каждая следующая
// миграция — новый прирост схемы.
import type { Database } from "better-sqlite3";
import db from "./db.js";
import { refreshRoles } from "./roleRouting.js";

export type Migration = {
  id: string;
  description: string;
  up: () => void;
  /**
   * Выполнить `up()` БЕЗ внешней транзакции раннера.
   *
   * Нужно ровно одному классу миграций — пересборке таблицы по 12-шаговой
   * процедуре SQLite: она требует `PRAGMA foreign_keys = OFF`, а эта
   * прагма внутри открытой транзакции молча не действует. Такая миграция
   * обязана быть идемпотентной и держать транзакцию внутри себя сама:
   * отметка в schema_migrations ставится уже после её выхода, и падение
   * между ними означает повторный прогон на следующем старте.
   */
  noTransaction?: boolean;
};

/**
 * Пересборка agent_inbox так, чтобы у неё была колонка event_type с CHECK
 * (12-шаговая процедура SQLite: новая таблица → копия → DROP → RENAME).
 * Используется 021 (чистая БД, колонки ещё нет) и 024 (живая БД, где 021
 * записана «применена», но колонку/CHECK так и не добавила). Идемпотентна:
 * если колонка и CHECK уже на месте — ничего не делает.
 */
function ensureAgentInboxEventType(): void {
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_inbox'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (!ddl) {
    throw new Error(
      "ensureAgentInboxEventType: таблица agent_inbox не найдена",
    );
  }
  const hasColumn = /event_type\s+TEXT/.test(ddl);
  const hasCheck = /CHECK\s*\(\s*event_type\s+IN/.test(ddl);
  if (hasColumn && hasCheck) return;

  // Вставляем колонку event_type после статуса (если её ещё нет) и добиваем
  // CHECK. Работаем с фактическим DDL из sqlite_master, а не с эталоном из
  // 020 — живая БД могла собрать его иначе.
  const statusDef =
    /status TEXT NOT NULL DEFAULT 'sent' CHECK \(status IN \('sent','received','acting','done','blocked'\)\)/;
  let newDdl = ddl;
  if (!hasColumn) {
    newDdl = newDdl.replace(
      statusDef,
      `status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','received','acting','done','blocked')),
          event_type TEXT NOT NULL DEFAULT 'chat' CHECK (event_type IN ('chat','assignment','review_return'))`,
    );
  } else if (!hasCheck) {
    // Колонка есть, CHECK нет — добавляем CHECK к строке event_type.
    newDdl = newDdl.replace(
      /event_type TEXT NOT NULL DEFAULT 'chat'/,
      `event_type TEXT NOT NULL DEFAULT 'chat' CHECK (event_type IN ('chat','assignment','review_return'))`,
    );
  }
  newDdl = newDdl.replace(
    /CREATE TABLE\s+"?agent_inbox"?/i,
    'CREATE TABLE "agent_inbox_new"',
  );
  db.exec(newDdl);
  db.exec(
    "INSERT INTO agent_inbox_new (id, chat_message_id, to_user_id, body_text, task_id, task_version, kind, status, created_at, received_at, acting_at, done_at, blocked_reason, event_type) " +
      "SELECT id, chat_message_id, to_user_id, body_text, task_id, task_version, kind, status, created_at, received_at, acting_at, done_at, blocked_reason" +
      (hasColumn ? ", event_type" : ", 'chat'") +
      " FROM agent_inbox",
  );
  db.exec("DROP TABLE agent_inbox");
  db.exec("ALTER TABLE agent_inbox_new RENAME TO agent_inbox");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_to_status
      ON agent_inbox(to_user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_task
      ON agent_inbox(task_id);
  `);
}

/**
 * Remove the closed users.role CHECK without losing columns added after the
 * original users table was created. SQLite cannot alter a CHECK in place, so
 * this uses the live table definition and the same no-transaction rebuild
 * pattern as the earlier orchestrator migration.
 */
function removeUsersRoleCheck(): void {
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (!ddl || !/CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i.test(ddl)) {
    return;
  }

  const newDdl = ddl
    .replace(/\s+CHECK\s*\(\s*role\s+IN\s*\([^)]*\)\s*\)/i, "")
    .replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE "users_new"');
  if (newDdl === ddl || !newDdl.includes('CREATE TABLE "users_new"')) {
    throw new Error(
      "031_role_skills: не удалось безопасно подготовить users без role CHECK",
    );
  }

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      db.exec(newDdl);
      db.exec('INSERT INTO "users_new" SELECT * FROM users');
      db.exec("DROP TABLE users");
      db.exec('ALTER TABLE "users_new" RENAME TO users');
    });
    rebuild();

    const broken = (
      db.pragma("foreign_key_check") as Array<{ parent?: string }>
    ).filter((row) => row.parent === "users");
    if (broken.length > 0) {
      throw new Error(
        `031_role_skills: после пересборки users осталось ${broken.length} битых ссылок на users`,
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Добавить 'bug_regression' в закрытый CHECK task_collaboration_plans.profile
 * (T05). Прямая копия паттерна 077 (product_feature) — повторять текст
 * функции addProductFeatureProfile здесь нельзя: rebuild делает замену
 * regex-ом по DDL, и если две миграции побегут подряд в одной транзакции,
 * они могут столкнуться на этапе `DROP TABLE task_collaboration_plans`. Здесь
 * проверка идемпотентности своя, по `'bug_regression'` в DDL.
 *
 * Зарегистрирована как 080: под 095/095 уже занято (`079_plan_node_source_subtask`,
 * задача 30.09.2026), а WIP-дифф в `docs/2026-09-30-collaboration-plan-editable/
 * t05-bug-regression-migration-wip.diff.txt` описывал её под номером 079.
 * Сдвиг номера — административный: код миграции и её эффект не меняются,
 * schema_migrations получит запись `137_collaboration_plan_bug_regression_profile`.
 */
function addBugRegressionProfile(): void {
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (!ddl || ddl.includes("'bug_regression'")) {
    return;
  }

  const newDdl = ddl
    .replace(/CHECK\s*\(\s*profile\s+IN\s*\(([^)]*)\)\s*\)/i, (_match, list: string) => `CHECK (profile IN (${list},'bug_regression'))`)
    .replace(/CREATE TABLE\s+"?task_collaboration_plans"?/i, 'CREATE TABLE "task_collaboration_plans_new"');
  if (newDdl === ddl || !newDdl.includes('CREATE TABLE "task_collaboration_plans_new"') || !newDdl.includes("'bug_regression'")) {
    throw new Error(
      "137_collaboration_plan_bug_regression_profile: не удалось безопасно подготовить task_collaboration_plans с bug_regression",
    );
  }

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      db.exec(newDdl);
      db.exec('INSERT INTO "task_collaboration_plans_new" SELECT * FROM task_collaboration_plans');
      db.exec("DROP TABLE task_collaboration_plans");
      db.exec('ALTER TABLE "task_collaboration_plans_new" RENAME TO task_collaboration_plans');
      // DROP TABLE забирает с собой отдельно объявленный (не inline UNIQUE)
      // индекс idx_task_collaboration_plans_task — пересоздаём его на новой таблице.
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC)");
    });
    rebuild();

    const broken = (
      db.pragma("foreign_key_check") as Array<{ parent?: string }>
    ).filter((row) => row.parent === "task_collaboration_plans");
    if (broken.length > 0) {
      throw new Error(
        `137_collaboration_plan_bug_regression_profile: после пересборки task_collaboration_plans осталось ${broken.length} битых ссылок`,
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Добавить 'orchestrated' в закрытый CHECK task_collaboration_plans.profile —
 * режим «Оркестратор» (владелец 13.10.2026): Оркестратор раскладывает работу
 * по ролям в живом плане и сам собирает итог. Тот же rebuild, что у 137.
 */
/** Rebuild the closed profile CHECK using the existing migration pattern.
 * Keep all columns, rows, indexes and triggers; failures roll back before commit. */
export function addTemplateProfiles(profiles: readonly string[] = ["ux_concept","api_integration","audit"]): void {
  const ddl=(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'").get() as {sql:string}|undefined)?.sql;
  if (!ddl) throw new Error("task_collaboration_plans отсутствует");
  const missing=profiles.filter(p=>!ddl.includes("'"+p+"'"));
  if (!missing.length) return;
  const next=ddl.replace(/CHECK\s*\(\s*profile\s+IN\s*\(([^)]*)\)\s*\)/i,(_m,list:string)=>`CHECK (profile IN (${list},${missing.map(p=>"'"+p+"'").join(",")}))`)
    .replace(/CREATE TABLE\s+"?task_collaboration_plans"?/i,'CREATE TABLE "task_collaboration_plans_new"');
  if (!next.includes('CREATE TABLE "task_collaboration_plans_new"') || missing.some(p=>!next.includes("'"+p+"'"))) throw new Error("Небезопасная схема шаблонов");
  const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='task_collaboration_plans' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as {sql:string}[];
  const foreignKeys=db.pragma("foreign_keys",{simple:true});
  db.pragma("foreign_keys=OFF");
  try { db.transaction(()=>{
    db.exec(next);
    db.exec('INSERT INTO task_collaboration_plans_new SELECT * FROM task_collaboration_plans');
    db.exec('DROP TABLE task_collaboration_plans');
    db.exec('ALTER TABLE task_collaboration_plans_new RENAME TO task_collaboration_plans');
    for(const object of objects) db.exec(object.sql);
    const broken=(db.pragma("foreign_key_check") as {parent:string}[]).filter(x=>x.parent==="task_collaboration_plans");
    if(broken.length) throw new Error("Нарушены ссылки на планы после миграции шаблонов");
  })(); } finally { db.pragma("foreign_keys="+(foreignKeys ? "ON" : "OFF")); }
}

function addOrchestratedProfile(): void {
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (!ddl || ddl.includes("'orchestrated'")) {
    return;
  }

  const newDdl = ddl
    .replace(/CHECK\s*\(\s*profile\s+IN\s*\(([^)]*)\)\s*\)/i, (_match, list: string) => `CHECK (profile IN (${list},'orchestrated'))`)
    .replace(/CREATE TABLE\s+"?task_collaboration_plans"?/i, 'CREATE TABLE "task_collaboration_plans_new"');
  if (newDdl === ddl || !newDdl.includes('CREATE TABLE "task_collaboration_plans_new"') || !newDdl.includes("'orchestrated'")) {
    throw new Error(
      "140_collaboration_plan_orchestrated_profile: не удалось безопасно подготовить task_collaboration_plans с orchestrated",
    );
  }

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      db.exec(newDdl);
      db.exec('INSERT INTO "task_collaboration_plans_new" SELECT * FROM task_collaboration_plans');
      db.exec("DROP TABLE task_collaboration_plans");
      db.exec('ALTER TABLE "task_collaboration_plans_new" RENAME TO task_collaboration_plans');
      // DROP TABLE забирает с собой отдельно объявленный (не inline UNIQUE)
      // индекс idx_task_collaboration_plans_task — пересоздаём его на новой таблице.
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC)");
    });
    rebuild();

    const broken = (
      db.pragma("foreign_key_check") as Array<{ parent?: string }>
    ).filter((row) => row.parent === "task_collaboration_plans");
    if (broken.length > 0) {
      throw new Error(
        `140_collaboration_plan_orchestrated_profile: после пересборки task_collaboration_plans осталось ${broken.length} битых ссылок`,
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Добавить 'product_feature' в закрытый CHECK task_collaboration_plans.profile
 * (T03). SQLite не умеет ALTER CHECK — тот же rebuild-паттерн, что и в
 * removeUsersRoleCheck: читаем живой DDL, дописываем значение в список CHECK,
 * пересобираем таблицу под foreign_keys=OFF.
 */
function addProductFeatureProfile(): void {
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_collaboration_plans'",
        )
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (!ddl || ddl.includes("'product_feature'")) {
    return;
  }

  const newDdl = ddl
    .replace(/CHECK\s*\(\s*profile\s+IN\s*\(([^)]*)\)\s*\)/i, (_match, list: string) => `CHECK (profile IN (${list},'product_feature'))`)
    .replace(/CREATE TABLE\s+"?task_collaboration_plans"?/i, 'CREATE TABLE "task_collaboration_plans_new"');
  if (newDdl === ddl || !newDdl.includes('CREATE TABLE "task_collaboration_plans_new"') || !newDdl.includes("'product_feature'")) {
    throw new Error(
      "077_collaboration_plan_product_feature_profile: не удалось безопасно подготовить task_collaboration_plans с product_feature",
    );
  }

  db.pragma("foreign_keys = OFF");
  try {
    const rebuild = db.transaction(() => {
      db.exec(newDdl);
      db.exec('INSERT INTO "task_collaboration_plans_new" SELECT * FROM task_collaboration_plans');
      db.exec("DROP TABLE task_collaboration_plans");
      db.exec('ALTER TABLE "task_collaboration_plans_new" RENAME TO task_collaboration_plans');
      // DROP TABLE забирает с собой отдельно объявленный (не inline UNIQUE)
      // индекс 071_task_collaboration_plans — пересоздаём его на новой таблице.
      db.exec("CREATE INDEX IF NOT EXISTS idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC)");
    });
    rebuild();

    const broken = (
      db.pragma("foreign_key_check") as Array<{ parent?: string }>
    ).filter((row) => row.parent === "task_collaboration_plans");
    if (broken.length > 0) {
      throw new Error(
        `077_collaboration_plan_product_feature_profile: после пересборки task_collaboration_plans осталось ${broken.length} битых ссылок`,
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Тело миграции 037_task_intake_pipeline. Экспортируется отдельно, чтобы
 * тесты могли прогнать его на отдельном свежем better-sqlite3-инстансе
 * (модульный db.ts-синглтон к этому моменту уже занят). Идемпотентна:
 * проверяет наличие колонки перед ALTER, повторный прогон не падает.
 *
 * На «свежей» БД (только users/tasks/chat_messages, без chat_task_drafts)
 * таблица черновиков заводится прямо здесь — с уже включённой колонкой
 * intake_mode и её CHECK. Так 037 остаётся самодостаточной и в тестах
 * (минимальная схема), и на свежей установке (где 028 ещё не отработала,
 * потому что 037 теперь идёт позже). На «живой» БД таблица уже есть
 * из 028 — добавляем колонку через ALTER TABLE.
 */
export function runIntakePipelineMigration(target: Database = db): void {
  const colNames = (table: string): Set<string> =>
    new Set(
      (
        target.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );

  const tableExists = (table: string): boolean => {
    const row = target
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    return !!row;
  };

  // users.task_intake_mode — текущий режим приёма задач владельцем.
  const userCols = colNames("users");
  if (!userCols.has("task_intake_mode")) {
    target.exec(
      `ALTER TABLE users ADD COLUMN task_intake_mode TEXT NOT NULL DEFAULT 'manual' ` +
        `CHECK (task_intake_mode IN ('manual', 'automatic'))`,
    );
  }

  // chat_task_drafts.intake_mode — снимок режима на момент разбора.
  if (!tableExists("chat_task_drafts")) {
    // Свежая БД (или прогон в тесте с минимальной схемой) — таблицы
    // ещё нет. Создаём её с полной формой из 028 ПЛЮС intake_mode + CHECK,
    // чтобы 037 оставалась самодостаточной и не требовала 028 раньше
    // себя для теста с урезанной схемой.
    target.exec(`
      CREATE TABLE chat_task_drafts (
        chat_message_id TEXT PRIMARY KEY
          REFERENCES chat_messages(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'done', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        intake_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (intake_mode IN ('manual', 'automatic'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_task_drafts_task
        ON chat_task_drafts(task_id);
    `);
  } else if (!colNames("chat_task_drafts").has("intake_mode")) {
    // Живая БД (028 уже отработала) — добавляем колонку через ALTER.
    // CHECK в ADD COLUMN поддержан SQLite давно (валидация значений ещё
    // дублируется хелпером snapshotIntakeMode в routes/task-intake.ts).
    target.exec(
      `ALTER TABLE chat_task_drafts ADD COLUMN intake_mode TEXT NOT NULL DEFAULT 'manual' ` +
        `CHECK (intake_mode IN ('manual', 'automatic'))`,
    );
  }

  // tasks.needs_clarification — следующие шаги конвейера попросят
  // владельца уточнить задачу; флаг поднимается, пока уточнения нет.
  const taskCols = colNames("tasks");
  if (!taskCols.has("needs_clarification")) {
    target.exec(
      `ALTER TABLE tasks ADD COLUMN needs_clarification INTEGER NOT NULL DEFAULT 0`,
    );
  }
  // tasks.clarification_question — текст вопроса к владельцу (NULL,
  // пока уточнения нет).
  if (!taskCols.has("clarification_question")) {
    target.exec(`ALTER TABLE tasks ADD COLUMN clarification_question TEXT`);
  }
}

/**
 * Отделяет полномочие учётки (users.role) от бизнес-роли исполнителя
 * (users.role_key). Экспорт нужен upgrade-тесту на отдельной старой БД.
 *
 * Backfill намеренно берёт только канонические системные AI-учётки:
 * совпадения одного лишь id `role_<key>` недостаточно. Так миграция не
 * присваивает роль произвольному существующему человеку с таким id.
 */
export function runRoleAccountSecurityMigration(target: Database = db): void {
  const columns = new Set(
    (target.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("role_key")) {
    // SQLite разрешает ADD COLUMN с FK только при определённых комбинациях
    // PRAGMA/DEFAULT. Связь ниже всё равно проверяется триггерами — одинаково
    // для старой и для свежей базы.
    target.exec("ALTER TABLE users ADD COLUMN role_key TEXT");
  }

  target.exec(`
    -- Канонический legacy account мог получить даже reserved authority
    -- (уязвимый role_owner). Сохраняем саму строку, token и все внешние
    -- ссылки на users.id, меняя только authority/business-role binding.
    UPDATE users
       SET role_key = role,
           role = 'agent'
     WHERE type = 'ai'
       AND COALESCE(is_system_bot, 0) = 1
       AND id = 'role_' || role
       AND (role_key IS NULL OR role_key = role)
       AND EXISTS (SELECT 1 FROM roles WHERE roles.key = users.role);

    -- Business keys must never remain authorization authorities. Legacy
    -- non-canonical rows are safely demoted without claiming a role_key.
    UPDATE users
       SET role = 'agent'
     WHERE role NOT IN ('owner', 'agent', 'viewer', 'orchestrator', 'service');
  `);

  const invalid = target
    .prepare(
      `SELECT id
         FROM users
        WHERE role_key IS NOT NULL
          AND (type <> 'ai'
               OR role <> 'agent'
               OR COALESCE(is_system_bot, 0) <> 1
               OR id <> 'role_' || role_key
               OR NOT EXISTS (SELECT 1 FROM roles WHERE roles.key = users.role_key))
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (invalid) {
    throw new Error(
      `058_role_account_authority: некорректная связь users.role_key у ${invalid.id}`,
    );
  }

  target.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_key_unique
      ON users(role_key) WHERE role_key IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS users_authority_insert_guard
    BEFORE INSERT ON users
    WHEN NEW.role NOT IN ('owner', 'agent', 'viewer', 'orchestrator', 'service')
    BEGIN
      SELECT RAISE(ABORT, 'invalid users.role authority');
    END;

    CREATE TRIGGER IF NOT EXISTS users_authority_update_guard
    BEFORE UPDATE OF role ON users
    WHEN NEW.role NOT IN ('owner', 'agent', 'viewer', 'orchestrator', 'service')
    BEGIN
      SELECT RAISE(ABORT, 'invalid users.role authority');
    END;

    CREATE TRIGGER IF NOT EXISTS users_role_key_insert_guard
    BEFORE INSERT ON users
    WHEN NEW.role_key IS NOT NULL AND (
      NEW.type <> 'ai'
      OR NEW.role <> 'agent'
      OR COALESCE(NEW.is_system_bot, 0) <> 1
      OR NEW.id <> 'role_' || NEW.role_key
      OR NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role_key)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid users.role_key binding');
    END;

    CREATE TRIGGER IF NOT EXISTS users_role_key_update_guard
    BEFORE UPDATE OF id, role, role_key, type, is_system_bot ON users
    WHEN NEW.role_key IS NOT NULL AND (
      NEW.type <> 'ai'
      OR NEW.role <> 'agent'
      OR COALESCE(NEW.is_system_bot, 0) <> 1
      OR NEW.id <> 'role_' || NEW.role_key
      OR NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role_key)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid users.role_key binding');
    END;

    CREATE TRIGGER IF NOT EXISTS roles_reserved_key_insert_guard
    BEFORE INSERT ON roles
    WHEN NEW.key IN ('owner', 'agent', 'viewer', 'orchestrator', 'service')
    BEGIN
      SELECT RAISE(ABORT, 'reserved role key');
    END;

    CREATE TRIGGER IF NOT EXISTS roles_reserved_key_update_guard
    BEFORE UPDATE OF key ON roles
    WHEN NEW.key IN ('owner', 'agent', 'viewer', 'orchestrator', 'service')
    BEGIN
      SELECT RAISE(ABORT, 'reserved role key');
    END;

    CREATE TRIGGER IF NOT EXISTS roles_bound_key_update_guard
    BEFORE UPDATE OF key ON roles
    WHEN EXISTS (SELECT 1 FROM users WHERE role_key = OLD.key)
    BEGIN
      SELECT RAISE(ABORT, 'role key is bound to an account');
    END;

    CREATE TRIGGER IF NOT EXISTS roles_bound_key_delete_guard
    BEFORE DELETE ON roles
    WHEN EXISTS (SELECT 1 FROM users WHERE role_key = OLD.key)
    BEGIN
      SELECT RAISE(ABORT, 'role key is bound to an account');
    END;
  `);
}

const migrations: Migration[] = [
  {
    id: "001_baseline",
    description:
      "схема на момент введения versioned migrations — уже применена через migrate() в db.ts, здесь только отметка",
    up: () => {},
  },
  {
    id: "002_indexes",
    description:
      "индексы на внешние ключи, не покрытые PRIMARY KEY — иначе каждый список задач/подзадач/меток был бы полным сканом таблицы",
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
        CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_labels_owner ON labels(owner_id);
        CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
        CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);
      `);
      // task_labels(task_id) не добавляется отдельно — это уже левый
      // столбец её собственного PRIMARY KEY (task_id, label_id), SQLite
      // строит по нему неявный индекс сам.
    },
  },
  {
    id: "003_subtask_work",
    description:
      "подзадача как единица работы: кто её ведёт, когда подал сигнал, и краткий итог — чтобы в ленте было видно, ГДЕ агент внутри задачи, а не только «взял» и «сдал»",
    up: () => {
      // Состояния намеренно те же, что у задачи (agentState.ts): NULL —
      // никто не ведёт, in_progress — ведут сейчас, blocked — упёрлись.
      // Отдельного «done» здесь нет: готовность подзадачи как была, так и
      // осталась в поле done — не заводим второй источник правды о том же.
      db.exec(`
        ALTER TABLE subtasks ADD COLUMN agent_state TEXT;
        ALTER TABLE subtasks ADD COLUMN agent_id TEXT REFERENCES users(id);
        ALTER TABLE subtasks ADD COLUMN agent_heartbeat_at TEXT;
        ALTER TABLE subtasks ADD COLUMN result TEXT;
      `);
      // Индекс под «покажи, что сейчас в работе» — выборка идёт по
      // состоянию, а не по задаче.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_subtasks_agent_state ON subtasks(agent_state)",
      );
    },
  },
  {
    id: "004_agent_session_id",
    description:
      "чей это claim физически: несколько параллельных сессий Claude Code делят один и тот же учётный аккаунт-агента (Claude_Bot) в TaskFlow, поэтому agent_state/assignee_id одни не отличают «эту сессию ведёт мой процесс» от «ведёт кто-то ещё под тем же ботом» — понадобилось после того, как taskflow-progress-gate.py (Stop-хук) начал блокировать сессии чужой незавершённой работой того же бота (18.08.2026)",
    up: () => {
      db.exec("ALTER TABLE tasks ADD COLUMN agent_session_id TEXT;");
    },
  },
  {
    id: "004b_subtask_session",
    description:
      "какая сессия ведёт КОНКРЕТНЫЙ шаг. У задачи такое поле есть с 004, у шага не было — и работа, идущая по шагам (subtask_work без claim), оставалась без хозяина: любая параллельная сессия под тем же ботом видела её как свою и на неё реагировала. Максим 20.08.2026: «система должна идентифицировать, кто создал и кто работал по этой задаче или подзадаче, и реагировать исключительно на эту сессию — а другие сессии к этой задаче отношения не имеют».",
    up: () => {
      db.exec("ALTER TABLE subtasks ADD COLUMN agent_session_id TEXT;");
    },
  },
  {
    id: "005_task_time_of_day",
    description:
      "час начала и длительность задачи — под календарную развёртку в разделе «День» (18.08.2026). Оба поля НЕОБЯЗАТЕЛЬНЫЕ и по умолчанию пустые: задача без них остаётся обычной задачей списка, поведение существующих 106 задач не меняется. Хранение намеренно симметрично due_date: там голая дата «ГГГГ-ММ-ДД» без времени и часового пояса, здесь — голое местное время «ЧЧ:ММ» тем же текстом, без даты и пояса. Держать время внутри due_date (ISO-таймстамп) было бы дороже: пришлось бы переписать все существующие сравнения дат на фронте и сервере и завести работу с поясами ради поля, которое у 90 задач из 106 пустое.",
    up: () => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN start_time TEXT;
        ALTER TABLE tasks ADD COLUMN duration_min INTEGER;
      `);
      // Выборка календаря — «что на этот день, по порядку часов»: сначала
      // отсекается дата, потом сортируется время. Индекс по паре, а не по
      // одному start_time, иначе он этой выборке не поможет.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_due_start ON tasks(due_date, start_time)",
      );
    },
  },
  {
    id: "006_attachment_kind",
    description:
      "вид вложения: 'comment' (файл в ленте, у своего комментария — единственное поведение до 19.08.2026) или 'task' (файл приложен к самой задаче, в её заметке). Понадобилось, чтобы файлы можно было прикладывать ПРИ СОЗДАНИИ задачи, а не только комментарием после (просьба Максима 19.08.2026). Отличить одним comment_id нельзя: у комментарийного вложения он тоже NULL всё время, пока комментарий не отправлен, — брошенный черновик после перезагрузки страницы выглядел бы вложением задачи. Все существующие записи получают 'comment' — это про них правда, других вложений до сих пор не было.",
    up: () => {
      // DEFAULT 'comment' в ALTER TABLE проставляет значение и уже
      // существующим строкам — отдельный UPDATE не нужен.
      db.exec(
        "ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';",
      );
    },
  },
  {
    id: "007_clear_agent_state_on_done_subtasks",
    description:
      "разовая уборка данных, а не схемы: у 114 закрытых шагов оставался agent_state («в работе» у 11, «сдан» у 103) — до 20.08.2026 закрытие шага меняло только колонку done. Чтение это скрывало (фильтр !s.done и вычисленное state='done'), но стоило владельцу снять галочку, как остаток оживал и закрытая работа снова выглядела идущей — именно так Максим поймал баг вечером 20.08.2026. Источник закрыт в routes/subtasks.ts, здесь подчищаются уже накопленные строки, иначе каждая такая галочка остаётся миной. Незакрытых шагов уборка не касается — у них состояние настоящее.",
    up: () => {
      db.exec(`
        UPDATE subtasks
           SET agent_state = NULL, agent_id = NULL, agent_heartbeat_at = NULL
         WHERE done = 1 AND agent_state IS NOT NULL;
      `);
    },
  },
  {
    id: "008_shared_dictionaries_belong_to_owner",
    description:
      "проекты и метки, заведённые агентами, переписываются на владельца. Справочник — общий инструмент: им пользуются владелец и все агенты. Записанный на агента, он для остальных не существует, потому что агент видит только своё и принадлежащее владельцам. Поймано 22.08.2026: проект «AI Control Center» завёл Claude_Bot, и Гермес, получив задание по нему, не увидел проекта в списке вовсе — решил, что задачи нет, и завёл её у себя во внутреннем кабане. Источник закрыт в access.ts (ownerForNewShared), здесь переписываются уже заведённые.",
    up: () => {
      db.exec(`
        UPDATE projects
           SET owner_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
         WHERE owner_id IN (SELECT id FROM users WHERE type = 'ai');

        UPDATE labels
           SET owner_id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
         WHERE owner_id IN (SELECT id FROM users WHERE type = 'ai');
      `);
    },
  },
  {
    id: "009_integrations",
    description:
      "таблицы для интеграций с внешними сервисами (Google Tasks, Apple Reminders/Calendar): хранение токенов, настроек и маппинга внешних идентификаторов задач",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_integrations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          account_email TEXT,
          access_token TEXT,
          refresh_token TEXT,
          token_expires_at INTEGER,
          settings TEXT DEFAULT '{}',
          last_synced_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, provider)
        );

        CREATE TABLE IF NOT EXISTS task_external_mappings (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_id TEXT NOT NULL,
          external_list_id TEXT,
          last_synced_at TEXT DEFAULT (datetime('now')),
          UNIQUE(task_id, provider)
        );

        CREATE INDEX IF NOT EXISTS idx_task_mappings_task ON task_external_mappings(task_id);
        CREATE INDEX IF NOT EXISTS idx_task_mappings_ext ON task_external_mappings(provider, external_id);
      `);
    },
  },
  {
    id: "010_notes",
    description:
      "единая страница «Заметки» (вход из «Ежедневника», 25.08.2026) — блочный редактор TipTap, контент хранится как одна строка JSON. Одна общая запись (id='main'), а не таблица по пользователю/проекту — владелец попросил именно общее пространство заметок, не отдельное на проект.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
      `);
      const existing = db
        .prepare("SELECT id FROM notes WHERE id = 'main'")
        .get();
      if (!existing) {
        db.prepare("INSERT INTO notes (id, content) VALUES ('main', '')").run();
      }
    },
  },
  {
    id: "011_journal_entries",
    description:
      "«Дневник» (25.08.2026) заменяет единую страницу «Заметки» — владелец попросил, чтобы каждый день был своей записью, а не одним общим листом. id = сама дата 'YYYY-MM-DD' (не uuid — дата и так уникальный естественный ключ, отдельный столбец под неё избыточен). Таблица `notes` из 010_notes НЕ трогаем и не дропаем (не переписывать применённые миграции) — она просто больше ничем не используется. Если в старой общей заметке уже что-то написано, переносим этот текст в запись за сегодня одной строкой, чтобы владелец не потерял написанное при переходе на новую модель.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal_entries (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
      `);
      const oldNote = db
        .prepare("SELECT content FROM notes WHERE id = 'main'")
        .get() as { content?: string } | undefined;
      if (oldNote?.content) {
        const today = new Date().toISOString().slice(0, 10);
        db.prepare(
          "INSERT OR IGNORE INTO journal_entries (id, content) VALUES (?, ?)",
        ).run(today, oldNote.content);
      }
    },
  },

  {
    id: "012_journal_folders",
    description:
      "Древовидные папки для заметок Дневника (26.08.2026, после согласования с владельцем — см. .hermes/plans/journal-folders.md). Заметка лежит ровно в одной папке (folder_id, ON DELETE SET NULL → заметка «выпадает» в корень «Без папки» при удалении папки — это намеренно: удалять заметки по ошибке при чистке папок нельзя). Сортировка папок между братьями — по position, при равенстве — по id. Папки живут в одном общем дереве на аккаунт, как и сами записи (заметки владельца и агентов в одной ленте — тот же дневник).",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER REFERENCES journal_folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_journal_folders_parent
          ON journal_folders(parent_id, position);
      `);
      // folder_id в journal_entries. SQLite ALTER TABLE ADD COLUMN поддержан;
      // default NULL = заметка без папки (корень «Без папки» в UI).
      // ON DELETE SET NULL — потому что заметка не должна пропадать при чистке
      // папки; владелец прямо сказал «заметки терять нельзя».
      const cols = db
        .prepare("PRAGMA table_info(journal_entries)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "folder_id")) {
        db.exec(
          `ALTER TABLE journal_entries ADD COLUMN folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL;`,
        );
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_journal_entries_folder ON journal_entries(folder_id);`,
      );
    },
  },
  {
    id: "013_user_notes",
    description:
      "Заметки становятся самостоятельными (26.08.2026, решение владельца: «обычные заметки: сколько угодно в день, у каждой своё название, дата — просто когда создана»). Прежняя модель journal_entries — «один день = одна запись, id = дата» — не давала ни второй заметки за день, ни собственного имени, из-за чего «создать заметку в папке» означало «переложить сюда сегодняшний день». Новая таблица user_notes (имя notes занято заброшенной таблицей из 010_notes — там одна строка 'main' от единой страницы «Заметки»; применённые миграции не переписываем): uuid, title, content, folder_id, created_at/updated_at. Папки переиспользуются те же (journal_folders из 012). Существующие записи дневника переносятся строками notes с названием по дате — Дневник по дням при этом продолжает жить на journal_entries, это отдельная сущность и трогать её не нужно.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_notes (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          updated_by TEXT REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_notes_folder ON user_notes(folder_id, updated_at DESC);
      `);
      // Переносим существующие записи дневника, чтобы ничего не пропало
      // из виду: название — дата записи, папка сохраняется. Сам
      // journal_entries НЕ трогаем (не переписывать применённые
      // миграции, плюс Дневник по дням остаётся рабочим экраном).
      const rows = db
        .prepare(
          "SELECT id, content, folder_id, updated_at FROM journal_entries WHERE trim(content) != ''",
        )
        .all() as Array<{
        id: string;
        content: string;
        folder_id: number | null;
        updated_at: string | null;
      }>;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO user_notes (id, title, content, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(
          `journal-${r.id}`,
          r.id,
          r.content,
          r.folder_id,
          r.updated_at ?? null,
          r.updated_at ?? null,
        );
      }
    },
  },
  {
    id: "014_project_notes_folder",
    description:
      "Папка заметок у проекта (26.08.2026, выбор владельца из четырёх вариантов связи заметок с задачами: «если есть какой-то проект, я бы мог прям прикрепить папку заметки и туда по этому проекту всю документацию скидывать»). Колонка notes_folder_id в projects указывает на существующую папку в journal_folders — НЕ отдельная иерархия: папка остаётся видна в Дневнике, работает перетаскивание, ничего не дублируется. ON DELETE SET NULL — удалили папку, проект просто теряет привязку, сам не страдает.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "notes_folder_id")) {
        db.exec(
          `ALTER TABLE projects ADD COLUMN notes_folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL;`,
        );
      }
    },
  },
  {
    id: "015_chat",
    description:
      "Чат агентов (27.08.2026, решение владельца): постоянно живущая сессия-резидент читает канал, доступный на запись любой сессии через taskflow_chat_send — координация Клода, Гермеса и остальных исполнителей, Максим читает и участвует. to_user_id NULL = сообщение всем; task_id NULL = висит в общей ленте, никого не будит (правило «ПОВОД, а не счётчик» — будит только сообщение, привязанное к задаче). kind — тип сообщения (совещание/делегирование/находка), нужен сразу для правила закрытия разговора, чтобы не писать 016 тем же днём. chat_reads(user_id, last_read_at) — по одной строке на пользователя, апсертится при каждом прочтении.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          from_user_id TEXT NOT NULL REFERENCES users(id),
          to_user_id TEXT REFERENCES users(id),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          kind TEXT CHECK (kind IS NULL OR kind IN ('совещание', 'делегирование', 'находка')),
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_to ON chat_messages(to_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id);

        CREATE TABLE IF NOT EXISTS chat_reads (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          last_read_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: "016_orchestrator_role",
    description:
      "Роль 'orchestrator' (задача af2107b2, 28.08.2026): оркестратор ведёт работу ботов — читает и правит любые проекты и задачи, назначает исполнителей, заводит подзадачи, но ничего не удаляет (запрет в authOrApiToken, auth.ts). Роль хранится в users.role, поэтому расширяется CHECK — в SQLite это только пересборкой таблицы. Заодно роль получает уже заведённая учётка «Оркестратор Claude», ради которой всё и делается.",
    noTransaction: true,
    up: () => {
      const current = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
        )
        .get() as { sql?: string } | undefined;
      const ddl = current?.sql ?? "";

      // Свежая база уже создана с новым CHECK (db.ts) — пересобирать нечего.
      if (ddl && !ddl.includes("'orchestrator'")) {
        const oldCheck = "CHECK(role IN ('owner','agent','viewer'))";
        const newCheck =
          "CHECK(role IN ('owner','agent','viewer','orchestrator'))";
        if (!ddl.includes(oldCheck)) {
          throw new Error(
            "016_orchestrator_role: не нашёл ожидаемый CHECK у users, схема разошлась с ожиданием — миграция остановлена, чтобы не пересобрать таблицу вслепую",
          );
        }

        // 12-шаговая процедура SQLite (ALTER TABLE, «Making Other Kinds Of
        // Table Schema Changes»). Порядок именно такой: новая таблица →
        // копия → DROP старой → RENAME. Наоборот (сначала переименовать
        // старую) нельзя: с версии 3.25 SQLite переписывает REFERENCES в
        // дочерних таблицах вслед за переименованием, и все ссылки на
        // users уехали бы на users_old.
        //
        // Новая схема строится ИЗ ЖИВОЙ, заменой одной строки CHECK, а не
        // из определения в db.ts: в базе у users есть колонки, которых там
        // нет (is_system_bot, created_by, avatar_url*), и сборка «по
        // образцу из кода» их бы потеряла.
        const newDdl = ddl
          .replace(oldCheck, newCheck)
          .replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE "users_new"');

        db.pragma("foreign_keys = OFF");
        try {
          const rebuild = db.transaction(() => {
            db.exec(newDdl);
            db.exec('INSERT INTO "users_new" SELECT * FROM users');
            db.exec("DROP TABLE users");
            db.exec('ALTER TABLE "users_new" RENAME TO users');
          });
          rebuild();

          // Считаем ТОЛЬКО ссылки на users: в живой базе 28.08.2026 уже
          // лежат осиротевшие subtasks и task_events от давно удалённых
          // задач (parent='tasks'), к пересборке они отношения не имеют, а
          // проверка «весь foreign_key_check пуст» уронила бы старт сервера
          // на ровном месте.
          const broken = (
            db.pragma("foreign_key_check") as Array<{ parent?: string }>
          ).filter((row) => row.parent === "users");
          if (broken.length > 0) {
            throw new Error(
              `016_orchestrator_role: после пересборки users осталось ${broken.length} битых ссылок на users`,
            );
          }
        } finally {
          db.pragma("foreign_keys = ON");
        }
      }

      // Учётка оркестратора заведена раньше (28.08.2026) обычным агентом —
      // теперь у неё своя роль. На чистой базе строки нет, и это не ошибка:
      // роль существует сама по себе, пользователей ей раздаёт владелец.
      db.prepare(
        "UPDATE users SET role = 'orchestrator' WHERE email = ? AND role <> 'owner'",
      ).run("оркестратор-claude@taskflow.local");
    },
  },
  {
    id: "017_chat_attachments",
    description:
      "Файлы в сообщениях чата (28.08.2026, владелец: «нужно в окне ввода также добавить возможность прикреплять какие-то файлы»). Отдельной таблицы не заводим: у attachments уже есть всё нужное — байты на диске, mime, размер, автор — и task_id там с самого начала NULL-евый, так что вложение вне задачи схема допускает. Добавляется одна колонка chat_message_id: NULL, пока файл залит, но сообщение ещё не отправлено (тот же приём «ничьего вложения», что у комментариев), и проставляется, когда сообщение уходит.",
    up: () => {
      db.exec(`
        ALTER TABLE attachments ADD COLUMN chat_message_id TEXT
          REFERENCES chat_messages(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_attachments_chat
          ON attachments(chat_message_id);
      `);
    },
  },
  {
    id: "018_chat_channels",
    description:
      "Два канала чата (28.08.2026, владелец: «должно быть тут 2 канала: у нас с тобой, оркестратор, и другой канал между вами, чтобы я только для контроля туда смотрел»). Канал — свойство САМОГО сообщения, а не отдельная таблица: разделяются потоки одной ленты, а не заводится второй чат со своими вложениями, прочтениями и «печатает…». channel='owner' — разговор владельца с оркестратором, channel='agents' — рабочая переписка исполнителей. Значение выводит сервер из ролей отправителя и адресата (routes/chat.ts), клиент его не присылает. Старую переписку раскладываем по тому же правилу: владелец↔оркестратор в обе стороны — в его канал, всё остальное (включая прежние броадкасты владельца «всем») — в служебный.",
    up: () => {
      db.exec(`
        ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'agents'
          CHECK (channel IN ('owner', 'agents'));
        CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
          ON chat_messages(channel, created_at);
      `);

      // Роли, а не зашитые id: учётка оркестратора уже однажды переезжала
      // (см. chat_resident_watch.py), роль переезд переживает. Нет одной из
      // них — раскладывать нечего, вся история остаётся служебной.
      const roleId = (role: string) =>
        (
          db
            .prepare(
              "SELECT id FROM users WHERE role = ? ORDER BY created_at LIMIT 1",
            )
            .get(role) as { id: string } | undefined
        )?.id ?? null;
      const owner = roleId("owner");
      const orchestrator = roleId("orchestrator");
      if (owner && orchestrator) {
        db.prepare(
          `UPDATE chat_messages SET channel = 'owner'
             WHERE (from_user_id = ? AND to_user_id = ?)
                OR (from_user_id = ? AND to_user_id = ?)`,
        ).run(owner, orchestrator, orchestrator, owner);
      }
    },
  },
  {
    id: "019_user_integrations_limits",
    description:
      "Остаток лимитов исполнителя (29.08.2026, владелец: «нужно, чтобы каждый агент начал видеть остаток своих лимитов», а оркестратор — все, и раздавал работу с оглядкой на них). Колонка хранит ответ провайдера как есть, JSON-строкой: у разных провайдеров разные единицы (запросы, токены, окно сброса), и приводить их к одному виду на уровне базы значило бы терять подробности. Заводится ОТДЕЛЬНОЙ миграцией, а не правкой 013: та таблица давно создана на живой базе, и дописанная в её CREATE TABLE колонка не появляется — 29.08.2026 на этом /api/agents отвечал 500 «no such column: limits», а владелец из-за этого не мог сменить исполнителя у задачи.",
    up: () => {
      const cols = db
        .prepare("PRAGMA table_info(user_integrations)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "limits")) {
        db.exec(
          "ALTER TABLE user_integrations ADD COLUMN limits TEXT DEFAULT '{}'",
        );
      }
    },
  },
  {
    id: "020_agent_inbox",
    description:
      "Карточка 5f292e87 (MVP надёжной доставки поручений). Agent inbox — единый механизм доставки поручений из чата агенту: message_id (uuid), task_id (FK на tasks), адресат (to_user_id), kind (text/voice/...), версия карточки на момент доставки, статусы sent/received/acting/done/blocked с таймстемпами, ключ дедупликации (chat_message_id UNIQUE). Без inbox'а повторное сообщение в чат создавало второе поручение; с inbox'ом — UNIQUE constraint на chat_message_id гарантирует один-to-один. Тесты: text, voice (тот же text), дедупликация, явный адресат, неясный запрос без запуска, обычный чат цел.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_inbox (
          id TEXT PRIMARY KEY,
          chat_message_id TEXT NOT NULL UNIQUE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          to_user_id TEXT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice')),
          task_version INTEGER,
          status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','received','acting','done','blocked')),
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          received_at TEXT,
          acting_at TEXT,
          done_at TEXT,
          body_text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_to_status
          ON agent_inbox(to_user_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_task
          ON agent_inbox(task_id);
      `);
    },
  },
  {
    id: "021_agent_inbox_event_type",
    description:
      "Карточка 5f292e87 (Reviewer 21:23): kind='text'/'voice' — это формат тела, а не источник события. Нужен event_type для различения chat/assignment/review-return, чтобы маршрутизация и журнал понимали, откуда пришёл inbox-элемент. Добавляется отдельной миграцией 021 (не правкой 020), потому что 020 уже применена на живой БД. Пересборка по 12-шаговой процедуре SQLite: колонка event_type добавляется вместе с CHECK (в прежней редакции CHECK вставлялся без колонки — фантомный CHECK, который не выживал и ломал чистую БД). Тип по умолчанию — 'chat' (обратная совместимость).",
    noTransaction: true,
    up: ensureAgentInboxEventType,
  },
  {
    id: "022_agent_inbox_event_type_col",
    description:
      "Карточка 5f292e87: миграция 021 записана в schema_migrations как применённая, но таблицу так и не расширила — колонка event_type в agent_inbox отсутствует, а chat.ts вставляет её. Вдобавок tasks не имеет current_revision, на который опирается защита от устаревших событий (review→in_progress). 022 делает то, что 021 обещала: добавляет event_type в agent_inbox и current_revision в tasks. Идемпотентна — проверяет наличие колонки перед ALTER (ADD COLUMN в SQLite нельзя с CHECK, валидацию значения делает приложение).",
    up: () => {
      const inboxCols = (
        db
          .prepare("SELECT name FROM pragma_table_info('agent_inbox')")
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!inboxCols.includes("event_type")) {
        db.exec(
          "ALTER TABLE agent_inbox ADD COLUMN event_type TEXT NOT NULL DEFAULT 'chat'",
        );
      }
      const taskCols = (
        db
          .prepare("SELECT name FROM pragma_table_info('tasks')")
          .all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!taskCols.includes("current_revision")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN current_revision INTEGER NOT NULL DEFAULT 1",
        );
      }
    },
  },
  {
    id: "024_agent_inbox_event_type_check",
    description:
      "Карточка 5f292e87: на живой БД 021 записана в schema_migrations как применённая, но колонку/CHECK так и не добавила, а 022 добавила колонку без CHECK. 024 самолечится: пересобирает agent_inbox, если колонки event_type или CHECK(event_type IN ...) нет. Идемпотентна.",
    noTransaction: true,
    up: ensureAgentInboxEventType,
  },
  {
    id: "023_dispatch_registry",
    description:
      "Карточка 5f292e87 (шаг «прозрачный журнал и реестр будильника»). Читаемый реестр диспетчеризации в режиме наблюдения: источник, условие/команда (trigger), адресат, переданные данные, исход и ошибка. Ничего в trigger.py/systemd/раннерах не меняет — только фиксирует события доставки поручений, чтобы владелец видел, какие сигналы ходят по каналу agent_inbox, без чтения кода.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_registry (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          trigger TEXT NOT NULL,
          to_user_id TEXT,
          data TEXT,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_dispatch_registry_created
          ON dispatch_registry(created_at);
      `);
    },
  },
  {
    id: "025_project_knowledge_dataset",
    description:
      "Датасет базы знаний у проекта (08.09.2026, просьба владельца: «мало ли будет специфический бизнесовый проект — не хотелось бы замешивать документацию не туда, куда надо»). knowledge_dataset_id — идентификатор датасета RAGFlow, куда синк складывает документы ИМЕННО этого проекта. NULL = общий датасет TaskFlow (RAGFLOW_TASKFLOW_DATASET в server/.env), как было до появления выбора. Внешним ключом чужая система здесь намеренно не проверяется: датасет заводится и удаляется вне TaskFlow, и жёсткая связь ломала бы проект на ровном месте.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "knowledge_dataset_id")) {
        db.exec(`ALTER TABLE projects ADD COLUMN knowledge_dataset_id TEXT;`);
      }
    },
  },
  {
    id: "026_ready_flag",
    description:
      "Признак готовности задачи к самозахвату (10.09.2026, карточка d598de9f). Карточка, собранная машиной из чата, лежит без флага, пока владелец её не откроет и не поставит — никто её взять не может. ready_for_pickup=1 значит «можно брать», ready_set_at и ready_set_by фиксируют, кто и когда поднял, чтобы это было видно в истории. Дефолт 0: новая задача без флага недоступна для claim. Снимать флаг (false) тоже владелец — на случай, если передумал и хочет править дальше.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "ready_for_pickup")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN ready_for_pickup INTEGER NOT NULL DEFAULT 0",
        );
        // Дефолт 0 — про БУДУЩИЕ карточки, которые машина соберёт из надиктовки:
        // такая лежит без флага, пока владелец её не откроет. Но задачи, уже
        // существовавшие на момент миграции, владелец завёл сам — они через
        // его руки прошли, и запирать их нечего. Без этой строки ALTER TABLE
        // проставляет 0 всем подряд и разом делает невзятой всю доску, а
        // поднять флаг нечем: кнопки в интерфейсах — отдельные карточки.
        db.exec("UPDATE tasks SET ready_for_pickup = 1");
      }
      if (!cols.some((c) => c.name === "ready_set_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN ready_set_at TEXT");
      }
      if (!cols.some((c) => c.name === "ready_set_by")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN ready_set_by TEXT REFERENCES users(id)",
        );
      }
    },
  },
  {
    id: "027_ready_flag_backfill",
    description:
      "Разблокировать доску после 026 (10.09.2026). Миграция 026 добавила ready_for_pickup с дефолтом 0 и тем самым разом сделала невзятыми все задачи, которые уже лежали на доске, — а поднять флаг было нечем: кнопки в вебе и на iOS ещё не сделаны, это отдельные карточки. Здесь признак проставляется всем, кто существовал до его введения: эти задачи владелец завёл сам, через его руки они уже прошли. Правка внутри 026 закрывает то же самое для чистой установки, а эта миграция нужна базам, где 026 успела примениться. Механики, создающей карточки без флага, на момент написания не существует — она делается в карточке про приём задачи из чата, поэтому проставить единицу всем текущим строкам безопасно.",
    up: () => {
      db.exec(
        "UPDATE tasks SET ready_for_pickup = 1 WHERE ready_for_pickup = 0",
      );
    },
  },
  {
    id: "028_owner_dictation",
    description:
      "Окно постановки задач: надиктовка владельца в чат → карточка-черновик (10.09.2026, карточка 4396f8c9). chat_task_drafts — по строке на разобранное сообщение, ключ chat_message_id: он же и защита от повторной доставки (второй заход по тому же сообщению вторую карточку не заведёт), он же место, где видно, чем разбор кончился — task_id при удаче, error при отказе модели. Плюс участник «Секретарь»: у сообщения чата автор обязателен (from_user_id NOT NULL), а ответ про собранную карточку пишет скрипт, не агент. Роль viewer и отсутствие api_token выбраны намеренно — это лицо в переписке, а не исполнитель: задачу на него не назначить и в API под ним не войти.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_task_drafts (
          chat_message_id TEXT PRIMARY KEY
            REFERENCES chat_messages(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'done', 'failed')),
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chat_task_drafts_task
          ON chat_task_drafts(task_id);
      `);

      // Пароль — заведомо не bcrypt-хэш: bcrypt.compare на такой строке
      // всегда false, то есть войти под этой учёткой нельзя ничем. Это
      // надёжнее случайного пароля, который где-то да всплывёт.
      db.prepare(
        `INSERT OR IGNORE INTO users
           (id, name, email, password_hash, role, type, avatar_color,
            initials, status, is_system_bot)
         VALUES (?, ?, ?, ?, 'viewer', 'ai', '#8E8E93', 'СК', 'offline', 1)`,
      ).run(
        "u-secretary",
        "Секретарь",
        "secretary@taskflow.local",
        "нет входа: это не учётка для входа",
      );
    },
  },
  {
    id: "029_result_versions_reviews",
    description:
      "Версии результата и вердикты ревью (карточка 6623ec55): каждое сдаваемое состояние привязано к artifact version, а одобрение старой версии не принимает новую.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifact_versions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL,
          task_revision INTEGER NOT NULL,
          result TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          artifact_hash TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(task_id, version_no)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_task
          ON artifact_versions(task_id, version_no);
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
          task_revision INTEGER NOT NULL,
          reviewer_id TEXT NOT NULL REFERENCES users(id),
          artifact_hash TEXT NOT NULL,
          criteria_version TEXT NOT NULL,
          verdict TEXT NOT NULL
            CHECK (verdict IN ('approved', 'changes_requested', 'blocked')),
          findings TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_reviews_task_created
          ON reviews(task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_reviews_version_created
          ON reviews(version_id, created_at);
      `);
    },
  },
  {
    id: "030_stop_reasons_and_retry_metrics",
    description:
      "Структурированные причины остановки, отдельный журнал технических повторов и метрики контура (карточка 7e615669).",
    up: () => {
      const attemptColumns = db
        .prepare("PRAGMA table_info(attempts)")
        .all() as Array<{ name: string }>;
      if (!attemptColumns.some((column) => column.name === "reason_code")) {
        db.exec("ALTER TABLE attempts ADD COLUMN reason_code TEXT");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS attempt_retries (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
          reason_code TEXT NOT NULL,
          retry_no INTEGER NOT NULL,
          delay_seconds INTEGER NOT NULL,
          scheduled_at TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(attempt_id, retry_no)
        );
        CREATE INDEX IF NOT EXISTS idx_attempt_retries_attempt
          ON attempt_retries(attempt_id, retry_no);
        CREATE INDEX IF NOT EXISTS idx_attempt_retries_reason
          ON attempt_retries(reason_code, created_at);
      `);
    },
  },
  {
    id: "031_role_skills",
    description:
      "Семь ролей спека 1.1: users.role больше не заперт закрытым CHECK, а role_skills хранит компетенции роли и поддерживает поиск по роли и навыку.",
    noTransaction: true,
    up: () => {
      removeUsersRoleCheck();
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_skills (
          role TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (role, skill_name)
        );
        CREATE INDEX IF NOT EXISTS idx_role_skills_skill
          ON role_skills(skill_name);
      `);
    },
  },
  {
    id: "032_attempt_policies_consultation_embeddings",
    description:
      "Спек 1.2 (1.2.1): лесенка модели attempt_policies, журнал консультаций consultation_log, расширение attempts.consultation_count, эмбеддинги ролей/задач для семантического матчинга.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attempt_policies (
          id TEXT PRIMARY KEY,
          reason_code TEXT NOT NULL,
          from_model TEXT NOT NULL,
          to_model TEXT,
          max_attempts INTEGER DEFAULT 3,
          cooldown_seconds INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_attempt_policies_reason
          ON attempt_policies(reason_code);

        INSERT OR IGNORE INTO attempt_policies (id, reason_code, from_model, to_model, max_attempts) VALUES
          ('ap_insuff_haiku_sonnet', 'insufficient_capability', 'haiku', 'sonnet', 3),
          ('ap_insuff_sonnet_opus', 'insufficient_capability', 'sonnet', 'opus', 3),
          ('ap_insuff_opus_null', 'insufficient_capability', 'opus', NULL, 3);

        CREATE TABLE IF NOT EXISTS consultation_log (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL REFERENCES attempts(id),
          task_id TEXT NOT NULL REFERENCES tasks(id),
          consultant_model TEXT NOT NULL,
          question TEXT NOT NULL,
          context_json TEXT,
          answer TEXT,
          duration_ms INTEGER,
          triggered_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_consultation_log_attempt
          ON consultation_log(attempt_id);
        CREATE INDEX IF NOT EXISTS idx_consultation_log_task
          ON consultation_log(task_id);

        ALTER TABLE attempts ADD COLUMN consultation_count INTEGER DEFAULT 0;

        CREATE TABLE IF NOT EXISTS role_embeddings (
          role TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          tags TEXT,
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_embeddings (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id),
          query_embedding BLOB NOT NULL,
          query_tags TEXT,
          computed_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    // LOCK-146, серверная половина: под раздел «Команда» в iOS-карточке
    // нужны модель агента, MCP-серверы (Composio), скиллы и per-action права.
    // Сервер их раньше не отдавал и не принимал — добавляем миграцию и
    // эндпоинты под это. Все таблицы идемпотентны (CREATE IF NOT EXISTS +
    // проверка колонок перед ALTER TABLE), старые агенты появятся в iOS с
    // пустыми значениями («не настроено» в каркасе клиента).
    id: "033_agent_model_mcp_skills_permissions",
    description:
      "LOCK-146 серверная половина: model/permissions на users + mcp_server_catalog/agent_mcp_servers + skill_catalog/agent_skills.",
    up: () => {
      // users.model — строка-идентификатор модели (например 'claude-sonnet-4-5').
      // NULL = «не настроено», клиент покажет заглушку. Идемпотентно:
      // проверяем наличие колонки перед ALTER.
      const usersCols = (
        db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!usersCols.includes("model")) {
        db.exec("ALTER TABLE users ADD COLUMN model TEXT");
      }
      // users.permissions — JSON-строка per-action bool, ключи
      // фиксированные: can_create_tasks / can_delete_tasks /
      // can_manage_projects / can_invite_agents / can_change_settings.
      // NULL = дефолт по роли (owner=всё, orchestrator=всё кроме удаления,
      // agent=своё, viewer=только чтение); пустая '{}' = явно пусто.
      if (!usersCols.includes("permissions")) {
        db.exec("ALTER TABLE users ADD COLUMN permissions TEXT");
      }

      // Каталог доступных MCP-серверов (Composio/Smithery и т. п.) —
      // общий для всех агентов, пополняется вручную или сидом ниже.
      // id — стабильный строковый ключ ('composio/github', 'composio/slack'…).
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_server_catalog (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          description TEXT,
          url         TEXT,
          default_config_json TEXT,
          created_at  TEXT DEFAULT (datetime('now'))
        );

        -- Подключённые к конкретному агенту MCP-серверы.
        -- PRIMARY KEY (agent_id, server_id) — один и тот же сервер нельзя
        -- подключить дважды. config_json — пользовательские правки поверх
        -- дефолта каталога (токены, ветки, фильтры и т. п.).
        CREATE TABLE IF NOT EXISTS agent_mcp_servers (
          agent_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          server_id    TEXT NOT NULL REFERENCES mcp_server_catalog(id) ON DELETE CASCADE,
          enabled      INTEGER NOT NULL DEFAULT 1,
          config_json  TEXT,
          added_at     TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (agent_id, server_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_mcp_agent
          ON agent_mcp_servers(agent_id);

        -- Каталог скиллов — установочные пакеты под конкретного агента
        -- (например, 'composio/email_summarizer', 'taskflow/daily_digest').
        -- id стабильный, install_url — где брать пакет, default_config_json —
        -- дефолтные параметры.
        CREATE TABLE IF NOT EXISTS skill_catalog (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          install_url TEXT,
          default_config_json TEXT,
          created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_skills (
          agent_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          skill_id   TEXT NOT NULL REFERENCES skill_catalog(id) ON DELETE CASCADE,
          config_json TEXT,
          added_at   TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (agent_id, skill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_skills_agent
          ON agent_skills(agent_id);

        -- Seed каталога MCP: минимальный набор Composio-коннекторов,
        -- чтобы в iOS карточке был непустой список выбора. Сервер сам по
        -- себе к этим серверам не подключается — это просто справочник,
        -- что агент может себе подключить (конфиг хранится на стороне
        -- агента при работе).
        INSERT OR IGNORE INTO mcp_server_catalog
          (id, name, provider, description, url, default_config_json) VALUES
          ('composio/github',  'GitHub',           'composio',
           'Репозитории, issues, pull requests', 'https://composio.dev',
           '{"scopes":["repo","read:user"]}'),
          ('composio/slack',   'Slack',            'composio',
           'Каналы, сообщения, треды', 'https://composio.dev',
           '{"scopes":["chat:write","channels:read"]}'),
          ('composio/gmail',   'Gmail',            'composio',
           'Письма, ярлыки, черновики', 'https://composio.dev',
           '{"scopes":["gmail.modify","gmail.readonly"]}'),
          ('composio/google_calendar', 'Google Calendar', 'composio',
           'События и календари', 'https://composio.dev',
           '{"scopes":["https://www.googleapis.com/auth/calendar"]}'),
          ('composio/notion',  'Notion',           'composio',
           'Страницы и базы Notion', 'https://composio.dev',
           '{"scopes":["read_content","update_content"]}'),
          ('composio/jira',    'Jira',             'composio',
           'Задачи и проекты Jira', 'https://composio.dev',
           '{"scopes":["read:jira-work","write:jira-work"]}'),
          ('composio/linear',  'Linear',           'composio',
           'Issues и проекты Linear', 'https://composio.dev',
           '{"scopes":["read","write"]}'),
          ('smithery/filesystem','Filesystem',     'smithery',
           'Чтение/запись локальных файлов агента', 'https://smithery.ai',
           '{"root":"/tmp"}'),
          ('smithery/brave_search','Brave Search', 'smithery',
           'Поиск через Brave API', 'https://smithery.ai',
           '{"max_results":10}');

        INSERT OR IGNORE INTO skill_catalog
          (id, name, description, install_url, default_config_json) VALUES
          ('composio/email_summarizer','Email Summarizer','Сжимает цепочку писем в один абзац',
           'https://composio.dev/skills/email_summarizer',
           '{"max_words":120}'),
          ('composio/code_reviewer','Code Reviewer','Делает ревью PR по описанию и диффу',
           'https://composio.dev/skills/code_reviewer',
           '{"langs":["swift","typescript"]}'),
          ('taskflow/daily_digest','Daily Digest','Утренняя сводка по задачам на сегодня',
           NULL,
           '{"include_overdue":true}'),
          ('taskflow/quick_recap','Quick Recap','Краткий пересказ последних событий по задаче',
           NULL,
           '{"max_events":5}'),
          ('composio/meeting_notes','Meeting Notes','Структурирует заметки встречи в действия',
           'https://composio.dev/skills/meeting_notes',
           '{"format":"bullets"}');
      `);
    },
  },
  {
    // 033 уже завела колонку для хеша токена `api_token` (она же использовалась
    // и раньше под legacy-формат). Для UI «когда последний раз меняли ключ»
    // добавляем отдельный timestamp — рядом с api_token, чтобы роуты могли
    // показать «обновлён N дней назад» без перерасчёта хеша.
    id: "034_api_token_set_at",
    description:
      "LOCK-146, довесок к 033: users.api_token_set_at — когда последний раз меняли токен (rotate или ручной PUT).",
    up: () => {
      const cols = (
        db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!cols.includes("api_token_set_at")) {
        db.exec("ALTER TABLE users ADD COLUMN api_token_set_at TEXT");
      }
    },
  },
  {
    id: "035_agent_prompt",
    description:
      "LOCK-146: users.prompt — индивидуальный системный промпт агента из карточки Команда.",
    up: () => {
      const cols = (
        db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      if (!cols.includes("prompt")) {
        db.exec("ALTER TABLE users ADD COLUMN prompt TEXT");
      }
    },
  },
  {
    id: "036_agent_execution_connection",
    description:
      "LOCK-146: режим исполнения агента — внешний runtime или прямой API; provider/base URL/credential ref.",
    up: () => {
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(users)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (!cols.has("execution_mode")) {
        db.exec(
          "ALTER TABLE users ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'agent_runtime'",
        );
      }
      if (!cols.has("model_provider")) {
        db.exec("ALTER TABLE users ADD COLUMN model_provider TEXT");
      }
      if (!cols.has("model_base_url")) {
        db.exec("ALTER TABLE users ADD COLUMN model_base_url TEXT");
      }
      if (!cols.has("model_credential_ref")) {
        db.exec("ALTER TABLE users ADD COLUMN model_credential_ref TEXT");
      }
    },
  },
  {
    id: "037_task_intake_pipeline",
    description:
      "Owner intake mode и снимок режима на сообщение (карточка 5f292e87, " +
      "серверная половина, шаг 1). users.task_intake_mode — текущий режим " +
      "приёма задач ('manual'|'automatic'), это источник правды (НЕ " +
      "user_defaults). chat_task_drafts.intake_mode — снимок на момент " +
      "разбора надиктовки: фиксируется ДО обращения к модели и больше не " +
      "перечитывается, даже если владелец переключит режим в процессе " +
      "(карточка из старого режима не должна неожиданно стать «автоматической»). " +
      "tasks.needs_clarification/tasks.clarification_question — следующие шаги " +
      "конвейера будут уточнять у владельца через эти колонки.",
    up: () => runIntakePipelineMigration(db),
  },
  {
    // Карточка 5ceda583: мост «owner поднял ready_for_pickup на задаче без
    // исполнителя» → «канонический 8-ролевой выбор → запуск через Pi».
    //
    // Колонки четыре, все nullable, без CHECK (валидация значений живёт
    // в коде маршрута — отдельная ось от владельца, отдельный гейт).
    //   owner_selected_role — выбор владельца; побеждает над дефолтом
    //     диспетчера. Ставится тем же PATCH /api/tasks/:id, что и
    //     ready_for_pickup, но это независимая ось: можно поднять роль
    //     заранее, а готовность — позже (или наоборот).
    //   dispatched_role — зафиксированный диспетчером выбор. Хранится
    //     отдельно от owner_selected_role, потому что после dispatch
    //     owner_selected_role может быть снят без потери уже сделанного
    //     запуска; logical role остаётся видимой именно через
    //     dispatched_role. Так Pi runtime и будильник читают одну и ту же
    //     колонку, а не разбираются, кто из двух её заполнил.
    //   dispatched_at / dispatched_by — момент и автор фиксации. Нужны
    //     ленте задачи и для повторного запуска (повторный dispatch
    //     запрещён, пока assignee_id != NULL — а на карточке должно быть
    //     видно, когда именно её отдали Pi).
    //
    // Плюс — строка учётки «Pi Agent» (1fa09a0a-...) в users. Без неё
    // маршрут диспетчера упрётся во FOREIGN KEY при попытке поставить
    // её assignee_id и записать notifications/agent_inbox. Живая база
    // заводит её через vault-run (tasks/credentials.py), но в тестах
    // (свежая БД через миграции) и в минимальной боевой раскрутке этого
    // шага нет — диспетчер обязан работать на любой чистой раскрутке.
    // Строка идемпотентна: если учётка с таким id уже есть, ничего не
    // делаем; password_hash ставим пустой (заход всё равно через API
    // token), email — локальный, чтобы не пересечься с чужими.
    id: "038_ready_dispatch_bridge",
    description:
      "Мост ready→роль→Pi для задач без исполнителя (карточка 5ceda583): " +
      "owner_selected_role, dispatched_role, dispatched_at, dispatched_by; " +
      "плюс системная учётка Pi Agent, чтобы диспетчеру было кого назначать.",
    up: () => {
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(tasks)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (!cols.has("owner_selected_role")) {
        db.exec("ALTER TABLE tasks ADD COLUMN owner_selected_role TEXT");
      }
      if (!cols.has("dispatched_role")) {
        db.exec("ALTER TABLE tasks ADD COLUMN dispatched_role TEXT");
      }
      if (!cols.has("dispatched_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN dispatched_at TEXT");
      }
      if (!cols.has("dispatched_by")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN dispatched_by TEXT REFERENCES users(id)",
        );
      }
      const PI_ID = "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2";
      const exists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(PI_ID);
      if (!exists) {
        db.prepare(
          `INSERT INTO users (id, name, email, password_hash, role, type,
             avatar_color, initials, status, is_system_bot)
           VALUES (?, 'Pi Agent', 'pi-agent@taskflow.local', '',
                   'agent', 'ai', '#10B981', 'P', 'offline', 1)`,
        ).run(PI_ID);
      }
    },
  },
  {
    id: "039_parent_id_and_last_seen_at",
    description:
      "Догоняющая миграция: tasks.parent_id и users.last_seen_at. Обе " +
      "колонки годами живут в рабочей базе на .110, но ни одна миграция " +
      "их не создавала — их когда-то добавили руками. На любой свежей " +
      "раскрутке (тесты, новая машина, восстановление из схемы) их не " +
      "было, и дерево задач с присутствием агентов там просто не " +
      "работали. Аудит 13.09.2026, пункт про parent_id и last_seen_at.",
    up: () => {
      const taskCols = new Set(
        (
          db.prepare("PRAGMA table_info(tasks)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (!taskCols.has("parent_id")) {
        // REFERENCES tasks(id) — дерево задач: родитель и дочерние карточки.
        // ON DELETE SET NULL, а не CASCADE: удаление родителя не должно
        // тихо уносить с собой дочернюю работу, которая может быть уже
        // выполнена. Осиротевшая карточка видна на доске, удалённая — нет.
        db.exec(
          "ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL",
        );
      }

      const userCols = new Set(
        (
          db.prepare("PRAGMA table_info(users)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (!userCols.has("last_seen_at")) {
        // Момент последней активности: по нему доска показывает, кто из
        // исполнителей на связи. NULL значит «не видели ни разу» — это
        // честнее, чем поставить дату раскрутки базы и показать всех
        // только что активными.
        db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
      }
    },
  },
  {
    id: "039_seed_owner",
    description:
      "18.09.2026: владелец системы ('u1', Максим) — owner-аккаунт, от " +
      "имени которого идут первые задачи и проекты. В живой БД он уже " +
      "есть (заведён до миграций), но миграция 040_archive_old_agents " +
      "создаёт проект «Архив» с owner_id='u1' без проверки, что u1 " +
      "существует — на свежей тестовой БД миграция падает на FOREIGN KEY. " +
      "Эта миграция идемпотентно создаёт u1 (INSERT OR IGNORE), чтобы " +
      "040 могла отработать в любой среде. В живой БД она no-op.",
    up: () => {
      db.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
         VALUES ('u1', 'Максим', 'owner@test.local', 'x', 'owner', 'human')`,
      ).run();
    },
  },
  {
    id: "040_archive_old_agents",
    description:
      "Подчистка исторических учёток агентов по решению владельца 15.09.2026. " +
      "В БД остаются шесть legacy-аккаунтов (Antigravity, Claude_Bot, " +
      "DeepSeek-Agent, Hermes, Pi Agent, Reviewer) — но в текущей матрице ролей " +
      "(паспорт восьми ролей Pi-агента от 12.09.2026) они не участвуют. " +
      "Ставим им archived=1 и переводим все 332 их задачи в проект «Архив» " +
      "с обнулением активного состояния (аренда, попытка, диспетчер). " +
      "assignee_id сохраняем, чтобы не рвать ссылки в комментариях и ленте. " +
      "Проект «Архив» создаётся при отсутствии; в живую базу он уже внесён " +
      "через API как d529ccf2-cf5a-4c40-954b-44e62571d944.",
    up: () => {
      // Проект «Архив»: создаём, если его ещё нет.
      const archProject = (
        db
          .prepare("SELECT id FROM projects WHERE name = ?")
          .get("Архив") as { id: string } | undefined
      )?.id;
      let archiveId = archProject;
      if (!archiveId) {
        archiveId = "archive-" + Date.now().toString(36);
        db.prepare(
          "INSERT INTO projects (id, name, color, owner_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        ).run(archiveId, "Архив", "#6B6B6B", "u1");
      }

      // Колонка archived в users: идемпотентно.
      const userCols = new Set(
        (
          db.prepare("PRAGMA table_info(users)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (!userCols.has("archived")) {
        db.exec(
          "ALTER TABLE users ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        );
      }

      // Шесть исторических учёток.
      const legacyIds = [
        "5b9d47c1-25c7-4a7c-a276-70e21f7d7816", // Antigravity
        "u2", // Claude_Bot
        "b85212d6-abab-4afb-a4c6-0d379b6537a4", // DeepSeek-Agent
        "u3", // Hermes
        "1fa09a0a-0c41-4e7e-982a-a1c46570e5d2", // Pi Agent
        "c2a5b269-dc15-400a-92bc-7988c97426eb", // Reviewer
      ];
      const placeholders = legacyIds.map(() => "?").join(",");

      // archived=1 на самих учётках.
      db
        .prepare(
          `UPDATE users SET archived = 1 WHERE id IN (${placeholders})`,
        )
        .run(...legacyIds);

      // Задачи этих учёток → проект «Архив», активное состояние снято.
      db.prepare(
        `UPDATE tasks
         SET project_id = ?,
             agent_state = NULL,
             agent_heartbeat_at = NULL,
             current_attempt_id = NULL,
             dispatched_role = NULL,
             dispatched_at = NULL,
             dispatched_by = NULL
         WHERE assignee_id IN (${placeholders})`,
      ).run(archiveId, ...legacyIds);
    },
  },
  {
    id: "041_archive_remaining_projects",
    description:
      "Решение владельца 15.09.2026: оставить в живых только два проекта — " +
      "«TaskFlow - NewTodoist» (c2fcbcdb-951f-449f-a1bd-123ea2a46a58) и " +
      "«Архив» (d529ccf2-cf5a-4c40-954b-44e62571d944). Остальные одиннадцать " +
      "(AI Control Center, CRM, TaskFlow Native Build, TaskFlow Native iOS, " +
      "Домашний сервер, Личные дела, Переговорка, Прогон автомата, Работа, " +
      "Работа после аудита, Спецификации архитектуры TaskFlow) — удалить. " +
      "Все их задачи (61 штука) → в проект «Архив». Корневые папки " +
      "документации (id 4, 6, 14, 17, 18, 19) переезжают под корневой " +
      "каталог проекта TaskFlow (id 3), чтобы заметки не пропали. Сами " +
      "проекты удаляются; их notes_folder_id больше не на что ссылаться.",
    up: () => {
      // 11 удаляемых проектов
      const deletingProjects = [
        "568a6fa0-027a-4c88-b193-cb7a0bc24db4", // AI Control Center
        "51637d67-6312-4682-90f9-21651a8739d9", // CRM — Бизнес Опора
        "35f0eb02-66cb-401c-8aa7-2e5d11a31e90", // TaskFlow Native Build
        "d678fc7b-0cb2-4e99-9aa1-22b3170660fc", // TaskFlow Native iOS
        "561868e7-02a8-40d2-8691-a117024d9b38", // Домашний сервер
        "p1", // Личные дела
        "d4b32d69-28f7-4089-957f-0b810fbca238", // Переговорка
        "2053b6e2-60ca-49dd-ad4e-4fa7945e1909", // Прогон автомата
        "c76bb47b-1d22-426e-bb7b-7d6177d0f23e", // Работа
        "1a03c127-9f68-40ff-81a9-103dcecde646", // Работа после аудита
        "b07e45d4-18c7-48a5-b8b0-b986f459afac", // Спецификации архитектуры TaskFlow
      ];
      const placeholders = deletingProjects.map(() => "?").join(",");

      // Задачи удаляемых проектов → Архив
      const archiveRow = (
        db
          .prepare("SELECT id FROM projects WHERE name = ?")
          .get("Архив") as { id: string } | undefined
      );
      if (!archiveRow) {
        throw new Error(
          "041: проект «Архив» не найден — должен быть создан 040",
        );
      }
      db.prepare(
        `UPDATE tasks SET project_id = ? WHERE project_id IN (${placeholders})`,
      ).run(archiveRow.id, ...deletingProjects);

      // Корневые папки документации → под корнем TaskFlow (id=3).
      // Делается ДО удаления проектов, чтобы потерянная папка не схлопнулась.
      const orphanFolders = [4, 6, 14, 17, 18, 19];
      db.prepare(
        `UPDATE journal_folders SET parent_id = 3 WHERE id IN (${orphanFolders.map(() => "?").join(",")})`,
      ).run(...orphanFolders);

      // Удалить проекты.
      db.prepare(
        `DELETE FROM projects WHERE id IN (${placeholders})`,
      ).run(...deletingProjects);
    },
  },
  {
    id: "042_pipeline_head",
    description:
      "Шапка конвейера (см. taskflow-pipeline-head-plan.md, шаг 0). " +
      "Разделить ручной и машинный выбор роли: добавить machine_selected_role, " +
      "role_exclusions (JSON-массив строк в TEXT-поле — SQLite массивов " +
      "не имеет), пометки blocked-задач (blocked_reason, block_type) и " +
      "счётчик ретраев (retry_count). Бэкфилл owner_selected_role → " +
      "machine_selected_role: для задач с непустым owner_selected_role " +
      "проверяем task_events — есть запись с field='owner_selected_role'? " +
      "Если да — оставляем как ручное назначение владельца. Если нет " +
      "(значение попало туда машинным путём) — переносим в " +
      "machine_selected_role и обнуляем owner_selected_role. Если у задачи " +
      "вообще нет событий — owner_selected_role обнуляется без переноса, " +
      "роутер переподберёт.",
    up: () => {
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(tasks)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );

      if (!cols.has("machine_selected_role")) {
        db.exec("ALTER TABLE tasks ADD COLUMN machine_selected_role text");
      }
      if (!cols.has("role_exclusions")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN role_exclusions text NOT NULL DEFAULT '[]'",
        );
      }
      if (!cols.has("blocked_reason")) {
        db.exec("ALTER TABLE tasks ADD COLUMN blocked_reason text");
      }
      if (!cols.has("block_type")) {
        db.exec("ALTER TABLE tasks ADD COLUMN block_type text");
      }
      if (!cols.has("retry_count")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN retry_count integer NOT NULL DEFAULT 0",
        );
      }

      // Бэкфилл owner_selected_role → machine_selected_role.
      const rows = db
        .prepare(
          `SELECT id, owner_selected_role
             FROM tasks
            WHERE owner_selected_role IS NOT NULL`,
        )
        .all() as Array<{ id: string; owner_selected_role: string }>;

      const hasManual = db.prepare(
        `SELECT 1 FROM task_events
           WHERE task_id = ? AND field = 'owner_selected_role'
           LIMIT 1`,
      );
      const hasAnyEvent = db.prepare(
        `SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1`,
      );
      const moveStmt = db.prepare(
        `UPDATE tasks
            SET machine_selected_role = ?, owner_selected_role = NULL
          WHERE id = ?`,
      );
      const clearStmt = db.prepare(
        `UPDATE tasks SET owner_selected_role = NULL WHERE id = ?`,
      );

      let kept = 0,
        moved = 0,
        cleared = 0;
      for (const row of rows) {
        if (hasManual.get(row.id)) {
          kept++;
          continue;
        }
        if (hasAnyEvent.get(row.id)) {
          moveStmt.run(row.owner_selected_role, row.id);
          moved++;
        } else {
          clearStmt.run(row.id);
          cleared++;
        }
      }

      console.log(
        `[042_pipeline_head] backfill: kept=${kept} moved=${moved} cleared=${cleared}`,
      );
    },
  },
  {
    id: "043_block_metadata",
    description:
      "Pipeline head plan step 0: add blocked_at timestamptz, " +
      "block_notified boolean NOT NULL DEFAULT false, and partial index " +
      "on tasks(block_type) WHERE state='blocked' for the scheduler.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((c) => c.name),
      );
      if (!cols.has("blocked_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN blocked_at timestamptz");
      }
      if (!cols.has("block_notified")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN block_notified boolean NOT NULL DEFAULT false",
        );
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_block_type_blocked " +
          "ON tasks (block_type) WHERE agent_state = 'blocked'",
      );
    },
  },
  {
    id: "044_tasks_role_and_agent_started_at",
    description:
      "18.09.2026: PiRuntimeAdapter.startRun и getRun читают tasks.role, " +
      "tasks.agent_started_at и tasks.agent_finished_at. routes/agent-state.ts " +
      "использует tasks.current_attempt_id (ссылка на текущий attempt). " +
      "В миграциях эти колонки не оформлены — есть только в живой БД. " +
      "Без них тестовая БД падает на SqliteError: no such column. " +
      "Эта миграция идемпотентно добавляет все четыре колонки: " +
      "role (legacy-поле роли, fallback для dispatched_role), " +
      "agent_started_at / agent_finished_at (когда Pi поднял/закрыл " +
      "сессию), current_attempt_id (id активного attempt). В живой БД " +
      "все колонки уже есть — ALTER через SQLite вернёт ошибку, поэтому " +
      "миграция проверяет PRAGMA и добавляет только если колонки нет.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((c) => c.name),
      );
      if (!cols.has("role")) {
        db.exec("ALTER TABLE tasks ADD COLUMN role TEXT");
      }
      if (!cols.has("agent_started_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN agent_started_at TEXT");
      }
      if (!cols.has("agent_finished_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN agent_finished_at TEXT");
      }
      if (!cols.has("current_attempt_id")) {
        db.exec("ALTER TABLE tasks ADD COLUMN current_attempt_id TEXT");
      }
      if (!cols.has("stop_reason")) {
        db.exec("ALTER TABLE tasks ADD COLUMN stop_reason TEXT");
      }
    },
  },
  {
    id: "045_attempts_provider_session_stop_reason",
    description:
      "18.09.2026 (доработка Pi runtime): AgentRun/attempt должен хранить " +
      "фактического провайдера, sessionId Pi и stop_reason, а история " +
      "попыток не должна перетираться при fallback. Добавляет в attempts " +
      "колонки provider, session_id, stop_reason. Идемпотентна (PRAGMA).",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(attempts)").all() as Array<{
          name: string;
        }>).map((c) => c.name),
      );
      if (!cols.has("provider")) {
        db.exec("ALTER TABLE attempts ADD COLUMN provider TEXT");
      }
      if (!cols.has("session_id")) {
        db.exec("ALTER TABLE attempts ADD COLUMN session_id TEXT");
      }
      if (!cols.has("stop_reason")) {
        db.exec("ALTER TABLE attempts ADD COLUMN stop_reason TEXT");
      }
    },
  },
  {
    id: "046_reviewer_first_review",
    description:
      "Reviewer-first review: старые карточки сохраняют прямую приёмку " +
      "владельцем, а новые по умолчанию проходят через Reviewer.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("requires_reviewer_review")) {
        db.exec("ALTER TABLE tasks ADD COLUMN requires_reviewer_review INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    id: "047_reviewer_first_default",
    description:
      "Общая настройка владельца: новые карточки по умолчанию проходят " +
      "Reviewer (Обзор → Система). Раньше это был флаг на каждой карточке.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(users)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("reviewer_first_default")) {
        db.exec("ALTER TABLE users ADD COLUMN reviewer_first_default INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    id: "048_model_ladder",
    description:
      "Ступени эскалации моделей (5 ступеней, по две учётки на ступень) и " +
      "состояние лимитов по УЧЁТКЕ (provider_limits). Проект владельца " +
      "16.09.2026: не потянул — вверх по ступени; лимит — вбок, в другую " +
      "учётку той же ступени.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_ladder (
          step INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (step, model)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_limits (
          provider TEXT PRIMARY KEY,
          unavailable_until TEXT,
          window_kind TEXT,
          reason TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const seed: Array<[number, string, string, number]> = [
        [0, "minimax", "MiniMax-M3", 0],
        [1, "anthropic", "claude-haiku-4-5", 0],
        [1, "openai-codex", "gpt-5.6-luna", 1],
        [2, "anthropic", "claude-sonnet-5", 0],
        [2, "openai-codex", "gpt-5.6-terra", 1],
        [3, "anthropic", "claude-opus-5", 0],
        [3, "openai-codex", "gpt-5.6-sol", 1],
        [4, "anthropic", "claude-fable-5-1", 0],
        [4, "openai-codex", "gpt-6-astra", 1],
      ];
      const ins = db.prepare(
        "INSERT OR IGNORE INTO model_ladder (step, provider, model, priority) VALUES (?, ?, ?, ?)",
      );
      for (const row of seed) ins.run(row[0], row[1], row[2], row[3]);
    },
  },
  {
    id: "049_run_schedule",
    description:
      "Расписание запуска карточки: run_at (когда поднимать исполнителя; " +
      "собирается из даты+времени, по умолчанию 09:00), run_repeat " +
      "(none|daily|weekdays|weekly|monthly) и repeat_until (до когда, " +
      "пусто — постоянно). Одна карточка за раз: следующая создаётся, " +
      "когда текущая закрыта.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("run_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN run_at TEXT");
      }
      if (!cols.has("run_repeat")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN run_repeat TEXT NOT NULL DEFAULT 'none'",
        );
      }
      if (!cols.has("repeat_until")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeat_until TEXT");
      }
    },
  },
  {
    id: "050_recurrence_spawned",
    description:
      "Повтор «одна за раз»: признак, что по завершённой карточке уже " +
      "создано следующее вхождение (иначе воркер плодил бы дубли).",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("recurrence_spawned")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN recurrence_spawned INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    id: "051_attempt_retries_fired_at",
    description:
      "Отложенный технический повтор: отметка, что воркер уже поднял " +
      "заход по attempt_retries.scheduled_at (иначе один и тот же повтор " +
      "поднимался бы на каждом обходе планировщика).",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(attempt_retries)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("fired_at")) {
        db.exec("ALTER TABLE attempt_retries ADD COLUMN fired_at TEXT");
      }
    },
  },
  {
    id: "052_needs_research",
    description:
      "Флаг «нужно глубокое исследование» на карточке (владелец 21.09.2026): " +
      "серверный конвейер исследования запускается вручную только по этой " +
      "отметке, чтобы не гоняться за источниками по рабочим пустякам. " +
      "Идемпотентна (PRAGMA): в уже прогретой БД колонки может не быть.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (!cols.has("needs_research")) {
        db.exec(
          "ALTER TABLE tasks ADD COLUMN needs_research INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    id: "053_chats",
    description:
      "Чаты с ролями-агентами (владелец 21.09.2026): персональные (одна роль) и " +
      "групповые (несколько). Таблицы chats/chat_members + chat_messages.chat_id; " +
      "канал сообщения теперь допускает 'chat'. chat_messages ПЕРЕСОБИРАЕТСЯ — " +
      "CHECK канала расширяется, а SQLite не умеет менять CHECK на месте. Поэтому " +
      "миграция без общей транзакции: своей транзакцией подменяет таблицу при " +
      "foreign_keys=OFF. FK-нарушения сравниваются до/после — в живой базе есть " +
      "давняя сирота agent_inbox→tasks, из-за неё падать нельзя.",
    noTransaction: true,
    up: () => {
      // Справочники чатов — обычные аддитивные таблицы, их можно создавать
      // всегда (idempotent), и ДО пересборки: chat_messages_new ссылается на chats.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          title TEXT,
          kind TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('direct', 'group')),
          created_by TEXT REFERENCES users(id),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS chat_members (
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          added_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, member_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_members_member
          ON chat_members(member_id);
      `);

      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{
          name: string;
        }>).map((column) => column.name),
      );
      if (cols.has("chat_id")) return; // уже пересобрана

      const fkBefore = (db.prepare("PRAGMA foreign_key_check").all() as unknown[])
        .length;
      // B2 (проверка Гермеса 21.09.2026): сверяем и ЧИСЛО строк. FK-чек ловит
      // только сироты, а ошибка в INSERT ... SELECT могла бы тихо потерять
      // строки. Считаем до и после и падаем, если разошлось.
      const rowsBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as {
          n: number;
        }
      ).n;
      db.pragma("foreign_keys = OFF");
      db.exec(`
        BEGIN;
        CREATE TABLE chat_messages_new (
          id TEXT PRIMARY KEY,
          from_user_id TEXT NOT NULL REFERENCES users(id),
          to_user_id TEXT REFERENCES users(id),
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          kind TEXT CHECK (kind IS NULL OR kind IN ('совещание', 'делегирование', 'находка')),
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          channel TEXT NOT NULL DEFAULT 'agents'
            CHECK (channel IN ('owner', 'agents', 'chat')),
          chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE
        );
        INSERT INTO chat_messages_new
          (id, from_user_id, to_user_id, task_id, kind, text, created_at, channel)
          SELECT id, from_user_id, to_user_id, task_id, kind, text, created_at, channel
            FROM chat_messages;
        DROP TABLE chat_messages;
        ALTER TABLE chat_messages_new RENAME TO chat_messages;
        CREATE INDEX IF NOT EXISTS idx_chat_messages_to
          ON chat_messages(to_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_task
          ON chat_messages(task_id);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
          ON chat_messages(channel, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
          ON chat_messages(chat_id, created_at);
        COMMIT;
      `);
      db.pragma("foreign_keys = ON");

      const rowsAfter = (
        db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as {
          n: number;
        }
      ).n;
      if (rowsAfter !== rowsBefore) {
        throw new Error(
          `053: пересборка chat_messages потеряла строки (было ${rowsBefore}, стало ${rowsAfter})`,
        );
      }
      const fkAfter = (db.prepare("PRAGMA foreign_key_check").all() as unknown[])
        .length;
      if (fkAfter > fkBefore) {
        throw new Error(
          `053: после пересборки chat_messages появились FK-нарушения (было ${fkBefore}, стало ${fkAfter})`,
        );
      }
    },
  },
  {
    // 21.09.2026 (этап 2 плана по чатам с ролями-агентами,
    // docs/superpowers/plans/2026-09-21-chat-online-pi-runtime.md).
    //
    // На каждый чат и каждую роль-участницу держим ровно одну строку: под
    // какой именно pi_session_id сейчас «живёт» агент в этом чате. Онлайн-
    // сессии Пи поднимаются без задачи (startChatRun), и единственное, что
    // у них есть устойчивого — sessionId, который Pi отдаёт через
    // client.getState() и который мы передаём обратно, чтобы следующее
    // сообщение продолжало тот же контекст, а не начинало разговор заново.
    //
    // PK(chat_id, role_id) — естественное ограничение «на пару один сеанс»;
    // апсёрт по составному ключу делается INSERT … ON CONFLICT DO UPDATE.
    //
    // Никаких FK на tasks здесь быть не может: чат живёт без задачи и без
    // прецедента связи с attempt/agent_state. Это и есть «изоляция» —
    // аддитивная таблица, в которую карточки не пишут и которая на них не
    // ссылается. FK на chats держим, чтобы удаление чата автоматически
    // убирало и его сессии (как и messages в миграции 053).
    id: "054_chat_sessions",
    description:
      "Живая онлайн-сессия Пи на (чат, роль): chat_sessions(chat_id, role_id, " +
      "pi_session_id, updated_at) — одна строка на пару, FK на chats, без " +
      "привязки к задаче или попытке. Аддитивно; на tasks/attempts/agent_state " +
      "не влияет.",
    up: () => {
      // Идемпотентно: пересборка стартует миграцию с уже возможной
      // таблицей, и CREATE IF NOT EXISTS проходит как no-op.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          pi_session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, role_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_chat
          ON chat_sessions(chat_id);
      `);
    },
  },
  {
    // 21.09.2026 (список чатов по образцу Teams, LOCK-195).
    //
    // Бейдж непрочитанных в списке чатов. У старых каналов отметка прочтения
    // одна на пользователя (chat_reads.last_read_at), но чаты — отдельная ось,
    // и у каждого чата свой счётчик. Поэтому отметка живёт на УЧАСТНИКЕ чата,
    // а не на пользователе: один и тот же человек в разных чатах прочитал
    // разное.
    //
    // Аддитивно: новая колонка в существующей chat_members. Старые каналы
    // owner/agents, автоматика и карточки о ней не знают.
    //
    // Дефолт — КОНСТАНТА, а не datetime('now'): SQLite не принимает
    // неконстантный DEFAULT в ALTER TABLE ADD COLUMN. Поэтому существующим
    // участникам отметка сразу выставляется в «сейчас»: на момент появления
    // колонки вся прежняя переписка считается прочитанной, иначе владелец
    // получил бы бейджи на чаты, которые уже читал.
    id: "055_chat_members_last_read_at",
    description:
      "chat_members.last_read_at — отметка прочтения на участнике чата (бейдж " +
      "непрочитанных в списке чатов). Аддитивно, старые каналы не затронуты.",
    up: () => {
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(chat_members)").all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      if (cols.has("last_read_at")) return; // уже добавлена
      db.exec(`
        ALTER TABLE chat_members
          ADD COLUMN last_read_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
        UPDATE chat_members SET last_read_at = datetime('now');
      `);
    },
  },
  {
    // Роли — данные, а не код (владелец 23.09.2026). Посев — нынешние семь
    // ролей (Синтезатор убран 23.09.2026). Модели ролей остаются в
    // scripts/role-routing.yaml: с ним работают экран моделей и скрипты.
    id: "056_roles",
    description:
      "roles — справочник ролей исполнителей: ключ, название, «чем занимается» " +
      "(строка для Секретаря), включена ли, порядок. Заменяет список в коде.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
          key TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES
          ('researcher', 'Исследователь', 'узнать, найти, сравнить варианты вне нашего кода и свести найденное в выводы или документ.', 1, 0),
          ('analyst', 'Аналитик', 'посчитать цифры, метрики, деньги.', 1, 1),
          ('critic_verifier', 'Критик-проверяющий', 'проверить готовую работу и вынести вердикт.', 1, 2),
          ('architect', 'Архитектор', 'продумать устройство системы до кода, когда решений несколько.', 1, 3),
          ('builder', 'Разработчик', 'пишет и чинит код: сервер, приложение, веб. «Сделать, чтобы работало».', 1, 4),
          ('qa', 'QA', 'прогнать сценарии и найти баги.', 1, 5),
          ('designer', 'Дизайнер', 'как выглядит: макет, экран, отступы, цвета. Не пишет серверную логику.', 1, 6);
      `);
    },
  },
  {
    // Экран «Команда» (23.09.2026): инструкция новой роли — данные, а не
    // файл в scripts/role-prompts. Пустая колонка — читается прежний файл.
    id: "057_roles_prompt",
    description: "roles.prompt — инструкция роли; NULL — файл scripts/role-prompts/<ключ>.md.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "prompt")) {
        db.exec("ALTER TABLE roles ADD COLUMN prompt TEXT");
      }
    },
  },
  {
    id: "058_role_account_authority",
    description:
      "users.role_key связывает каноническую AI-учётку с бизнес-ролью; " +
      "users.role остаётся authority agent, reserved keys и небезопасные связи блокируются БД.",
    up: () => runRoleAccountSecurityMigration(),
  },
  {
    id: "059_role_run_jobs",
    description:
      "Durable-очередь автоматических запусков ролей: idempotency key, " +
      "атомарный claim, lease, retry/dead и recovery после рестарта.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS role_run_jobs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          reason TEXT NOT NULL
            CHECK (reason IN ('assigned', 'commented', 'review', 'after_run')),
          actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN (
              'queued', 'running', 'retry_wait', 'succeeded',
              'skipped', 'dead', 'cancelled'
            )),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
          available_at TEXT NOT NULL DEFAULT (datetime('now')),
          lease_owner TEXT,
          lease_expires_at TEXT,
          last_error TEXT,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (
            status <> 'running'
            OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS idx_role_run_jobs_ready
          ON role_run_jobs(status, available_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_role_run_jobs_task_status
          ON role_run_jobs(task_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_role_run_jobs_lease
          ON role_run_jobs(status, lease_expires_at)
          WHERE status = 'running';
      `);
    },
  },
  {
    id: "060_role_run_job_chain",
    description:
      "Durable-глубина C3 continuation и уникальный active lease на задачу.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(role_run_jobs)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      if (!cols.has("chain_depth")) {
        db.exec(
          "ALTER TABLE role_run_jobs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 3)",
        );
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_role_run_jobs_running_task
          ON role_run_jobs(task_id)
          WHERE status = 'running';
      `);
    },
  },
  {
    // «Супер Секретарь» (владелец 25.09.2026, план в
    // docs/ПЛАН Супер Секретарь/): строка roles ещё выключена — включим
    // вместе с переносом iOS-экрана (docs/ПЛАН Супер Секретарь/..., этап
    // 2.1), чтобы Секретарь не задвоился в списке чатов раньше времени.
    // u-secretary получает authority agent — как у остальных ролей,
    // нужно для app.inject/JWT-пропуска в startChatRun.
    id: "061_secretary_role",
    description:
      "roles: строка secretary (enabled=0 до переноса iOS-экрана); " +
      "u-secretary получает authority agent для app.inject-вызовов.",
    up: () => {
      db.exec(`
        INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES
          ('secretary', 'Секретарь', 'личный помощник владельца: разговор, вопросы, разбор надиктовки задач.', 0, 7);
      `);
      db.prepare("UPDATE users SET role = 'agent' WHERE id = 'u-secretary' AND role != 'agent'").run();
    },
  },
  {
    // Продолжение LOCK 061 — вынесено в отдельную миграцию (владелец
    // 25.09.2026): 061 уже применена на живой БД, дописывать в её тело
    // бессмысленно, раннер её больше не тронет. Якорный ряд в chats —
    // только для chat_sessions (продолжение разговора Пи между
    // сообщениями), НЕ для видимости в /api/chats: без строки в
    // chat_members он не попадёт в список чатов владельца (GET /api/chats
    // джойнит chat_members), пока не включим этап 2.1.
    id: "062_secretary_chat_session_anchor",
    description:
      "chats: якорный ряд chat-secretary для chat_sessions; " +
      "roles.prompt для secretary.",
    up: () => {
      const owner = (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
      if (owner) {
        db.prepare(
          `INSERT OR IGNORE INTO chats (id, title, kind, created_by, task_id) VALUES (?, ?, ?, ?, NULL)`,
        ).run("chat-secretary", "Секретарь", "direct", owner);
      }
      db.prepare("UPDATE roles SET prompt = ? WHERE key = 'secretary' AND prompt IS NULL").run(
        [
          "Ты — Секретарь, личный помощник владельца в TaskFlow. Общайся живо,",
          "по-русски, кратко и по-человечески — как собеседник, а не как отчёт.",
          "",
          "Про постановку задач: НЕ создавай карточку на каждое сообщение.",
          "Создавай задачу (taskflow_structure_dictation, затем taskflow_create_task)",
          "только когда владелец явно просит («создай карточку», «запиши задачу»",
          "и т.п.) ИЛИ когда сам уверен, что сообщение — постановка задачи. Если",
          "не уверен — переспроси коротко, не создавай вслепую.",
        ].join("\n"),
      );
    },
  },
  {
    // Владелец 25.09.2026 (docs/ПЛАН Супер Секретарь/): историю старого
    // канала owner не жалко, переносим Секретаря на настоящую комнату
    // /api/chats целиком — экран iOS переиспользует RoleChatRoomScreen без
    // изменений. chat_members делает комнату chat-secretary видимой в
    // GET /api/chats (раньше нарочно её не было — см. миграцию 062);
    // roles.enabled включаем в этом же шаге, так как iOS-переключение
    // делается вместе.
    id: "063_secretary_room_go_live",
    description:
      "chat_members для chat-secretary (владелец + u-secretary); roles.enabled=1 для secretary.",
    up: () => {
      const owner = (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
      if (owner) {
        db.prepare(
          "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)",
        ).run("chat-secretary", owner);
      }
      db.prepare(
        "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES (?, ?)",
      ).run("chat-secretary", "u-secretary");
      db.prepare("UPDATE roles SET enabled = 1 WHERE key = 'secretary'").run();
    },
  },
  {
    // Быстрые ответы (владелец 25.09.2026, docs/ПЛАН Супер Секретарь/):
    // 2-4 коротких варианта под последним сообщением роли, чтобы не
    // печатать каждый раз руками. Храним JSON-строкой — своего типа
    // массива у SQLite нет, разворачивается в withAttachments().
    id: "064_chat_quick_replies",
    description: "chat_messages.quick_replies — JSON-массив коротких вариантов ответа.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has("quick_replies")) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN quick_replies TEXT");
      }
    },
  },
  {
    // Новая сессия без удаления истории (владелец 25.09.2026, docs/ПЛАН
    // Супер Секретарь/): «очистить чат мне не надо... надо по сессиям
    // потом полистать». Сброс памяти агента — DELETE из chat_sessions
    // (нового пропуска pi_session_id не будет, startChatRun поднимет
    // сессию с нуля); сообщения не трогаются, в ленту кладётся видимая
    // метка-разделитель.
    id: "065_chat_session_marker",
    description: "chat_messages.is_session_marker — разделитель «новая сессия» в ленте.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has("is_session_marker")) {
        db.exec(
          "ALTER TABLE chat_messages ADD COLUMN is_session_marker INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
  {
    // Живой ход роли как в Claude Code (владелец 27.09.2026): шаги хода
    // (что читала, что выполняла) остаются в истории вместе с ответом —
    // JSON {duration_ms, items[]}, см. runtime/chatLiveTurn.ts.
    id: "066_chat_message_steps",
    description: "chat_messages.steps — шаги хода роли, свёрнутые под ответом.",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has("steps")) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN steps TEXT");
      }
    },
  },
  {
    id: "067_manual_role_run_start",
    description: "role_run_jobs.manual_start — явный запуск владельца при выключенной Системе.",
    up: () => {
      const cols = new Set((db.prepare("PRAGMA table_info(role_run_jobs)").all() as Array<{name:string}>).map(c => c.name));
      if (!cols.has("manual_start")) db.exec("ALTER TABLE role_run_jobs ADD COLUMN manual_start INTEGER NOT NULL DEFAULT 0 CHECK (manual_start IN (0,1))");
    },
  },
  {
    id: "068_owner_notification_no_activity",
    description: "Владелец: действия задач остаются в ленте, не дублируются в уведомления.",
    up: () => db.exec(`CREATE TRIGGER IF NOT EXISTS notifications_owner_no_activity BEFORE INSERT ON notifications WHEN NEW.type IN ('assigned','commented','reviewed','agent_state','completed') AND EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND role='owner') BEGIN SELECT RAISE(IGNORE); END;`),
  },
  {
    id: "069_keep_owner_completion_notifications",
    description: "Сохранить уведомления о завершении согласно ранее подтверждённой границе владельца.",
    up: () => db.exec(`DROP TRIGGER IF EXISTS notifications_owner_no_activity; CREATE TRIGGER notifications_owner_no_activity BEFORE INSERT ON notifications WHEN NEW.type IN ('assigned','commented','reviewed','agent_state') AND EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND role='owner') BEGIN SELECT RAISE(IGNORE); END;`),
  },
  {
    id: "070_task_role_slots",
    description: "Изолированные персональные slots специалистов для одной задачи.",
    up: () => db.exec(`
      CREATE TABLE IF NOT EXISTS task_role_slots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        role_key TEXT NOT NULL REFERENCES roles(key),
        participant_id TEXT NOT NULL REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','ready','active','submitted','accepted')),
        required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
        result TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, slot_key)
      );
      CREATE INDEX IF NOT EXISTS idx_task_role_slots_task ON task_role_slots(task_id, state);
      CREATE INDEX IF NOT EXISTS idx_task_role_slots_participant ON task_role_slots(participant_id, state);
    `),
  },
  {
    id: "071_task_collaboration_plans",
    description: "Версии графа совместной работы: роли, зависимости и решение владельца.",
    up: () => db.exec(`
      CREATE TABLE IF NOT EXISTS task_collaboration_plans (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
        profile TEXT NOT NULL CHECK (profile IN ('single_executor','research','delivery','full_cycle','manual')),
        rationale TEXT NOT NULL DEFAULT '',
        context_version INTEGER,
        created_by TEXT NOT NULL REFERENCES users(id),
        approved_by TEXT REFERENCES users(id),
        approved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, revision)
      );
      CREATE TABLE IF NOT EXISTS task_collaboration_plan_nodes (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        role_key TEXT NOT NULL REFERENCES roles(key),
        required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
        expected_result TEXT NOT NULL DEFAULT '',
        UNIQUE(plan_id, slot_key)
      );
      CREATE TABLE IF NOT EXISTS task_collaboration_plan_edges (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
        from_slot_key TEXT NOT NULL,
        to_slot_key TEXT NOT NULL,
        start_condition TEXT NOT NULL CHECK (start_condition IN ('submitted','accepted','artifact_ready')),
        UNIQUE(plan_id, from_slot_key, to_slot_key)
      );
      CREATE INDEX IF NOT EXISTS idx_task_collaboration_plans_task ON task_collaboration_plans(task_id, revision DESC);
      CREATE INDEX IF NOT EXISTS idx_task_collaboration_plan_nodes_plan ON task_collaboration_plan_nodes(plan_id);
      CREATE INDEX IF NOT EXISTS idx_task_collaboration_plan_edges_plan ON task_collaboration_plan_edges(plan_id);
    `),
  },
  {
    id: "072_collaboration_plan_slot_admission",
    description: "Связать slots с revision плана и допускать их только по edges.",
    up: () => db.exec(`
      ALTER TABLE task_role_slots ADD COLUMN collaboration_plan_id TEXT REFERENCES task_collaboration_plans(id);
      ALTER TABLE task_role_slots ADD COLUMN plan_node_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_role_slots_plan_node
        ON task_role_slots(collaboration_plan_id, plan_node_key)
        WHERE collaboration_plan_id IS NOT NULL;
    `),
  },
  {
    id: "073_task_dependency_policy",
    description: "Policy допуска на dependency edge: review (по умолчанию) либо completed.",
    up: () => {
      const cols = new Set((db.prepare("PRAGMA table_info(task_dependencies)").all() as Array<{name:string}>).map(c => c.name));
      if (!cols.has("policy")) db.exec("ALTER TABLE task_dependencies ADD COLUMN policy TEXT NOT NULL DEFAULT 'review' CHECK (policy IN ('review','completed'))");
    },
  },
  {
    id: "074_task_context_version",
    description: "Монотонная версия контекста ветки на каждой задаче (растёт на корне при review/completed).",
    up: () => {
      const cols = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Array<{name:string}>).map(c => c.name));
      if (!cols.has("context_version")) db.exec("ALTER TABLE tasks ADD COLUMN context_version INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    id: "075_collaboration_plan_artifact_contract",
    description: "Контракты выходных артефактов collaboration plan и ключ артефакта на edge.",
    up: () => {
      const nodeCols = new Set((db.prepare("PRAGMA table_info(task_collaboration_plan_nodes)").all() as Array<{name:string}>).map(c => c.name));
      if (!nodeCols.has("output_artifact_json")) db.exec("ALTER TABLE task_collaboration_plan_nodes ADD COLUMN output_artifact_json TEXT");
      const edgeCols = new Set((db.prepare("PRAGMA table_info(task_collaboration_plan_edges)").all() as Array<{name:string}>).map(c => c.name));
      if (!edgeCols.has("artifact_key")) db.exec("ALTER TABLE task_collaboration_plan_edges ADD COLUMN artifact_key TEXT");
    },
  },

  {
    id: "076_role_slot_artifact_versions",
    description: "Immutable role slot artifact versions.",
    up: () => db.exec("CREATE TABLE IF NOT EXISTS role_slot_artifact_versions (id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES task_role_slots(id) ON DELETE CASCADE, version_no INTEGER NOT NULL, artifact_key TEXT NOT NULL, artifact_type TEXT NOT NULL, artifact_format TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK (status IN ('submitted','accepted','revision_requested','rejected')), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(slot_id, version_no)); CREATE INDEX IF NOT EXISTS idx_role_slot_artifact_versions_slot ON role_slot_artifact_versions(slot_id, version_no DESC);"),
  },
  {
    id: "077_collaboration_plan_product_feature_profile",
    description: "Разрешить profile='product_feature' (T03) в task_collaboration_plans.profile.",
    noTransaction: true,
    up: () => addProductFeatureProfile(),
  },
  {
    id: "078_role_slot_to_subtask",
    description: "Узлы collaboration plan — обычные subtasks (collaboration_plan_id/plan_node_key), а не отдельная сущность task_role_slots. Решение владельца 29.09.2026 (docs/2026-09-29-role-slot-execution-integration/DESIGN.md): выводим task_role_slots/role_slot_artifact_versions из употребления сразу, без переходного периода — ничего в проде на них не завязано долгосрочно.",
    up: () => db.exec(`
      ALTER TABLE subtasks ADD COLUMN collaboration_plan_id TEXT REFERENCES task_collaboration_plans(id);
      ALTER TABLE subtasks ADD COLUMN plan_node_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subtasks_plan_node
        ON subtasks(collaboration_plan_id, plan_node_key)
        WHERE collaboration_plan_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS subtask_artifact_versions (
        id TEXT PRIMARY KEY,
        subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        artifact_key TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        artifact_format TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('submitted','accepted','revision_requested','rejected')),
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(subtask_id, version_no)
      );
      CREATE INDEX IF NOT EXISTS idx_subtask_artifact_versions_subtask
        ON subtask_artifact_versions(subtask_id, version_no DESC);

      DROP TABLE IF EXISTS role_slot_artifact_versions;
      DROP TABLE IF EXISTS task_role_slots;
    `),
  },

  {
    id: "079_plan_node_source_subtask",
    description:
      "task_collaboration_plan_nodes.source_subtask_id — узел плана может занять уже существующую обычную подзадачу вместо создания дубля при approve. Владелец 30.09.2026: «у нас всё завязано на подзадачах» — умная параллелизация (subtaskRoleFanout.ts) предлагает план ИЗ уже написанных подзадач, и approve должен не плодить рядом новые строки, а превратить те же самые.",
    up: () => {
      const cols = new Set((db.prepare("PRAGMA table_info(task_collaboration_plan_nodes)").all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has("source_subtask_id")) db.exec("ALTER TABLE task_collaboration_plan_nodes ADD COLUMN source_subtask_id TEXT REFERENCES subtasks(id)");
    },
  },
  {
    // 30.09.2026 (карточка 15c2db1f, узел плана «Реализация» — Builder).
    // Каталог инструкций запуска роли: владельческие переопределения
    // поверх исходного текста (roles.prompt / scripts/role-prompts/*.md,
    // agentState.AGENT_RULES, inProcessRun.LOCAL_EXECUTION_POLICY).
    //
    // scope='role' — переопределение для конкретной роли (ролевая
    // инструкция, AGENT_RULES для роли и т.п.);
    // scope='command' — общесистемное переопределение (например,
    // AGENT_RULES на все роли: role_key='*'). В этой миграции только
    // таблицы; правило «AGENT_RULES правятся владельцем с историей и
    // восстановлением» включается отдельным шагом 4 (подключение к
    // in-process runtime), в этой миграции только хранение.
    //
    // is_active=1 — частичный уникальный индекс: ровно одна активная
    // запись на (scope, role_key, layer). Правка = транзакция «погасить
    // старую + вставить новую с version=MAX+1». История — append-only
    // role_context_overrides_history, без UNIQUE — намеренно, чтобы
    // restore не конфликтовал с уже существующей версией.
    id: "080_role_context_overrides",
    description:
      "Переопределения текстов инструкций запуска ролей и их история (scope=role/command, layer, version, активная через partial unique). Карточка 15c2db1f «Прозрачность и управление всем контекстом запуска ролей», дизайн заметки 54ff50a1-37ed-45ac-badd-9cbfab02a5d5, §6.",
    up: () => db.exec(`
      CREATE TABLE IF NOT EXISTS role_context_overrides (
        scope TEXT NOT NULL CHECK (scope IN ('role', 'command')),
        role_key TEXT NOT NULL,
        layer TEXT NOT NULL,
        version INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        PRIMARY KEY (scope, role_key, layer, version)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_role_context_active
        ON role_context_overrides(scope, role_key, layer)
        WHERE is_active = 1;

      CREATE INDEX IF NOT EXISTS idx_role_context_overrides_role
        ON role_context_overrides(scope, role_key, layer, version DESC);

      CREATE TABLE IF NOT EXISTS role_context_overrides_history (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        role_key TEXT NOT NULL,
        layer TEXT NOT NULL,
        version INTEGER NOT NULL,
        prev_version INTEGER,
        text TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('set', 'reset', 'restore')),
        by_user_id TEXT NOT NULL REFERENCES users(id),
        at TEXT NOT NULL DEFAULT (datetime('now')),
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_role_context_history_lookup
        ON role_context_overrides_history(scope, role_key, layer, version DESC);
    `),
  },
  {
    // Снимок effective system prompt, который УВИДЕЛА модель при старте
    // попытки. Карточка 15c2db1f, дизайн §8: «активные сессии видят свою
    // прежнюю версию», а владелец и iOS могут показать, что именно
    // получила модель в этом запуске. Два места записи:
    //   • tasks.composed_prompt_snapshot — для in-process хода
    //     (runRoleInProcess), один снимок на последний старт карточки;
    //   • attempts.system_prompt_snapshot — для RpcClient-пути
    //     (PiRuntimeAdapter.startRun), на каждую попытку.
    // Текст длинный (5–50 КБ), TEXT без лимита ок.
    id: "081_prompt_snapshot",
    description:
      "composed_prompt_snapshot на tasks + attempts — что модель реально получила. Карточка 15c2db1f, дизайн §8.",
    up: () => {
      const taskCols = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!taskCols.has("composed_prompt_snapshot")) {
        db.exec("ALTER TABLE tasks ADD COLUMN composed_prompt_snapshot TEXT");
      }
      const attemptCols = new Set(
        (db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!attemptCols.has("system_prompt_snapshot")) {
        db.exec("ALTER TABLE attempts ADD COLUMN system_prompt_snapshot TEXT");
      }
    },
  },
  {
    // Живой план совместной работы (владелец 01.10.2026): план правится и
    // после утверждения — владелец меняет неначатые шаги, роли сами
    // достраивают граф в пределах лимитов, QA/критик отправляют на
    // доработку. Правки — на месте (узлы остаются подзадачами того же
    // плана), история — в журнале task_collaboration_plan_ops, version —
    // для проверки конкурентных правок.
    id: "082_live_collaboration_plan",
    description:
      "Живой план: version плана, происхождение/пропуск/итерация узла, журнал правок task_collaboration_plan_ops.",
    up: () => {
      const cols = (table: string) =>
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
        );
      const plans = cols("task_collaboration_plans");
      if (!plans.has("version")) {
        db.exec("ALTER TABLE task_collaboration_plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
      }
      const nodes = cols("task_collaboration_plan_nodes");
      const add = (name: string, ddl: string) => {
        if (!nodes.has(name)) db.exec(`ALTER TABLE task_collaboration_plan_nodes ADD COLUMN ${name} ${ddl}`);
      };
      add("instructions", "TEXT");
      add("origin", "TEXT NOT NULL DEFAULT 'template'");
      add("added_by", "TEXT");
      add("added_reason", "TEXT");
      add("iteration", "INTEGER NOT NULL DEFAULT 0");
      add("rework_of_key", "TEXT");
      add("skipped_at", "TEXT");
      add("skip_reason", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_collaboration_plan_ops (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
          base_version INTEGER,
          applied_version INTEGER,
          actor_id TEXT,
          actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner','role','system')),
          ops_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected')),
          reason TEXT,
          decided_by TEXT,
          decided_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_plan_ops_plan ON task_collaboration_plan_ops(plan_id, created_at);
      `);
    },
  },
  {
    id: "083_chat_work_mode",
    description: "Режим сообщения чата: работа, планирование, глубокое исследование.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{name: string}>;
      if (!cols.some(c => c.name === "work_mode")) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'work' CHECK(work_mode IN ('work','plan','deep_research'))");
      }
    },
  },

  {
    id: "084_role_composio",
    description: "Composio: подключение и наборы инструментов по ролям, без секретов в БД.",
    up: () => db.exec(`CREATE TABLE IF NOT EXISTS role_composio (
      role TEXT PRIMARY KEY REFERENCES roles(key) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      toolkits TEXT
    )`),
  },
  {
    id: "085_linear_import",
    description: "Linear: mappings, reviewed snapshots and source history without changing task semantics.",
    up: () => db.exec(`
      CREATE TABLE IF NOT EXISTS linear_import_tasks (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        applied_fields TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(owner_id,workspace_id,source_id)
      );
      CREATE TABLE IF NOT EXISTS linear_import_objects (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        source_issue_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        local_id TEXT,
        applied_text TEXT,
        snapshot TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,source_issue_id,kind,source_id)
      );
      CREATE TABLE IF NOT EXISTS linear_import_relations (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_issue_id TEXT NOT NULL,
        target_issue_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        managed_edge INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        snapshot TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,source_id)
      );
      CREATE TABLE IF NOT EXISTS linear_import_previews (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        result TEXT
      );
    `),
  },

  {
    // Память ролей внутри приложения (владелец 02.10.2026): «с чистого
    // листа; пусть сами пишут, а я вижу и редактирую; и файлы закидывать».
    // Запись — короткий факт/урок/предпочтение или загруженный файл
    // (его текст режется на куски в memory_chunks). Область видимости:
    // team — всем ролям, role — одной роли, project — ролям в проекте.
    // Эмбеддинг — Float32 BLOB для смыслового поиска; без него ищем по словам.
    id: "086_role_memory",
    description: "Память ролей: memories (факты, уроки, файлы) и memory_chunks (куски текста файлов) с эмбеддингами.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('team','role','project')),
          role_key TEXT,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('fact','lesson','preference','file')),
          title TEXT,
          text TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('owner','role')),
          source_ref TEXT,
          created_by TEXT,
          updated_by TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          attachment_id TEXT,
          embedding BLOB,
          use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, role_key, project_id);
        CREATE TABLE IF NOT EXISTS memory_chunks (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          text TEXT NOT NULL,
          embedding BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory ON memory_chunks(memory_id, idx);
      `);
    },
  },
  {
    // Намеренно НЕ переименовано в 087_* / 088_* — id этой миграции уже
    // лежит в `schema_migrations` живой БД (`084_task_hierarchy_one_level`),
    // смена id заставит миграцию выполниться повторно на живой базе
    // (CREATE TRIGGER IF NOT EXISTS здесь безопасен, но общий принцип —
    // id иммутабильный после записи). Соседняя `084_role_composio` тоже
    // под префиксом 084 — нумерация тут не строго монотонная, это
    // осознанное решение (аудит MAK-60, решение оркестратора 05.10.2026:
    // «не переименовывать, зафиксировать комментарием»).
    //
    // Вложенность задач — ровно один уровень (владелец 02.10.2026: «чтобы
    // сломаться не могло никак»). Проверки в API дают понятный отказ, а эти
    // триггеры — последняя линия: любой код, пишущий в tasks (маршрут,
    // импорт, агент, будущая правка), получит отказ от самой базы.
    //   • родитель не может быть сам дочерним;
    //   • задача не может быть родителем самой себе;
    //   • задача с дочерними не может стать дочерней.
    // Уже существующие нарушения (если были) не трогаем — сервер пишет их
    // в журнал при старте (lib/taskHierarchy.ts → hierarchyViolations).
    id: "084_task_hierarchy_one_level",
    description: "Триггеры: вложенность задач — один уровень (родитель не дочерний, задача с дочерними не становится дочерней).",
    up: () => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_hierarchy_insert
        BEFORE INSERT ON tasks
        WHEN NEW.parent_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'task_hierarchy: задача не может быть родительской сама себе')
            WHERE NEW.parent_id = NEW.id;
          SELECT RAISE(ABORT, 'task_hierarchy: родительская задача сама дочерняя — вложенность одна')
            WHERE (SELECT parent_id FROM tasks WHERE id = NEW.parent_id) IS NOT NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS tasks_hierarchy_update
        BEFORE UPDATE OF parent_id ON tasks
        WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id IS NOT OLD.parent_id
        BEGIN
          SELECT RAISE(ABORT, 'task_hierarchy: задача не может быть родительской сама себе')
            WHERE NEW.parent_id = NEW.id;
          SELECT RAISE(ABORT, 'task_hierarchy: родительская задача сама дочерняя — вложенность одна')
            WHERE (SELECT parent_id FROM tasks WHERE id = NEW.parent_id) IS NOT NULL;
          SELECT RAISE(ABORT, 'task_hierarchy: у задачи есть свои дочерние — дочерней она стать не может')
            WHERE EXISTS (SELECT 1 FROM tasks WHERE parent_id = NEW.id);
        END;
      `);
    },
  },
  {
    id: "087_task_hierarchy_recursive",
    description: "Произвольная глубина задач с защитой от циклов в БД",
    up: () => db.exec(`
      DROP TRIGGER IF EXISTS tasks_hierarchy_insert;
      DROP TRIGGER IF EXISTS tasks_hierarchy_update;
      CREATE TRIGGER tasks_hierarchy_insert BEFORE INSERT ON tasks
      WHEN NEW.parent_id IS NOT NULL BEGIN
        SELECT RAISE(ABORT, 'task_hierarchy: вложенность задач не может содержать цикл')
        WHERE NEW.parent_id=NEW.id OR EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id UNION
            SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        );
      END;
      CREATE TRIGGER tasks_hierarchy_update BEFORE UPDATE OF parent_id ON tasks
      WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id IS NOT OLD.parent_id BEGIN
        SELECT RAISE(ABORT, 'task_hierarchy: вложенность задач не может содержать цикл')
        WHERE EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id UNION
            SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL
          ) SELECT 1 FROM ancestors WHERE id=NEW.id
        );
      END;
    `),
  },
  {
    id: "088_project_chat_topics",
    description: "Группа проекта и темы задач",
    up() {
      db.exec(`
        ALTER TABLE chats ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
        ALTER TABLE chats ADD COLUMN parent_chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE;
        CREATE UNIQUE INDEX idx_project_chat ON chats(project_id) WHERE project_id IS NOT NULL AND parent_chat_id IS NULL;
        CREATE UNIQUE INDEX idx_task_topic ON chats(task_id) WHERE parent_chat_id IS NOT NULL;
        CREATE INDEX idx_chat_topics ON chats(parent_chat_id);
        CREATE TRIGGER project_topic_insert BEFORE INSERT ON chats WHEN NEW.parent_chat_id IS NOT NULL BEGIN
          SELECT RAISE(ABORT, 'invalid project topic') WHERE NEW.task_id IS NULL OR NEW.project_id IS NULL OR NEW.kind != 'group'
            OR NOT EXISTS (SELECT 1 FROM chats g JOIN tasks t ON t.id=NEW.task_id WHERE g.id=NEW.parent_chat_id AND g.parent_chat_id IS NULL AND g.project_id=NEW.project_id AND t.project_id=NEW.project_id);
        END;
      `);
    },
  },
  {
    id: "089_auto_preparation_queue",
    description: "Версионная очередь подготовки задач",
    up() {
      db.exec(`
        CREATE TABLE task_preparation_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          input_version INTEGER NOT NULL,
          snapshot TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','needs_clarification','structure_review','skipped','superseded','failed')),
          worker_id TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL DEFAULT (datetime('now')),
          result_json TEXT, plan_id TEXT REFERENCES task_collaboration_plans(id) ON DELETE SET NULL,
          error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(task_id,input_version)
        );
        CREATE INDEX idx_preparation_queue ON task_preparation_jobs(status,available_at);
        CREATE TRIGGER enqueue_new_task_preparation AFTER INSERT ON tasks
        WHEN NEW.project_id IS NOT NULL AND NEW.status='active' BEGIN
          INSERT INTO task_preparation_jobs(task_id,input_version,snapshot) VALUES (NEW.id,1,json_object('title',NEW.title,'description',NEW.description,'project_id',NEW.project_id));
        END;
        CREATE TRIGGER enqueue_changed_task_preparation AFTER UPDATE OF title,description,project_id ON tasks
        WHEN NEW.project_id IS NOT NULL AND NEW.status='active' AND (NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.project_id IS NOT OLD.project_id) BEGIN
          INSERT INTO task_preparation_jobs(task_id,input_version,snapshot) VALUES (NEW.id,COALESCE((SELECT MAX(input_version) FROM task_preparation_jobs WHERE task_id=NEW.id),0)+1,json_object('title',NEW.title,'description',NEW.description,'project_id',NEW.project_id));
        END;
      `);
    },
  },
  {
    id: "090_plan_topic_events",
    description: "Идемпотентные события версий живого графа в теме",
    up() { db.exec(`CREATE TABLE plan_topic_events (
      plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL,
      broadcast_at TEXT,
      PRIMARY KEY(plan_id,version)
    );`); },
  },
  {
    id: "091_branch_plan",
    description: "Единое согласование планов ветки и ответственные карточек",
    up() { db.exec(`CREATE TABLE branch_plan_members (
      root_plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
      responsible_role TEXT NOT NULL,
      approved_snapshot TEXT NOT NULL,
      PRIMARY KEY(root_plan_id,task_id)
    ); CREATE INDEX idx_branch_member_plan ON branch_plan_members(plan_id);
    CREATE TABLE branch_rework_links (
      root_plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
      from_slot TEXT NOT NULL,
      to_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      to_slot TEXT NOT NULL,
      PRIMARY KEY(root_plan_id,from_slot,to_task_id,to_slot)
    );`); },
  },
  {
    id: "092_chat_message_reactions",
    description: "Реакции участников на сообщения чата",
    up() { db.exec(`CREATE TABLE chat_message_reactions (
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY(message_id,user_id)
    );`); },
  },
  {
    id: "093_agent_visible_text_limits",
    description: "Краткие видимые ответы агентов; подробности остаются в артефактах",
    up: () => {
      for(const [table,field,actor,max] of [["comments","text","user_id","800"],["chat_messages","text","from_user_id","800"],["subtasks","result","agent_id","CASE WHEN NEW.agent_state='blocked' THEN 400 ELSE 800 END"]]) {
        for(const event of ["INSERT","UPDATE"]) db.exec(`CREATE TRIGGER agent_short_${table}_${event.toLowerCase()} BEFORE ${event === "UPDATE" ? `UPDATE OF ${field}` : event} ON ${table}
          WHEN (SELECT type FROM users WHERE id=NEW.${actor})='ai' AND length(NEW.${field}) > (${max})
          BEGIN SELECT RAISE(ABORT,'Ответ агента слишком длинный: суть кратко, подробности в артефакт'); END;`);
      }
    },
  },

  { id: "094_plan_work_selection", description: "Выбор исходной или плановой работы", up: () => {
    db.exec("ALTER TABLE task_collaboration_plan_nodes ADD COLUMN work_choice TEXT CHECK(work_choice IN ('original','planned'))");
    db.exec("ALTER TABLE task_collaboration_plan_nodes ADD COLUMN original_title TEXT");
    db.exec("UPDATE task_collaboration_plan_nodes SET work_choice='original' WHERE source_subtask_id IS NOT NULL AND plan_id IN (SELECT id FROM task_collaboration_plans WHERE status='approved')");
  } },

  { id: "095_chat_entities_task_documents", description: "Система, ссылки задач и папки артефактов", up: () => {
    db.exec(`
      INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,is_system_bot,initials)
      VALUES('taskflow_system','Система','taskflow-system@invalid.local','!','service','human',1,'С');
      ALTER TABLE chat_messages ADD COLUMN message_type TEXT CHECK(message_type IS NULL OR message_type IN ('system','task_proposal'));
      UPDATE chat_messages SET from_user_id='taskflow_system',message_type='system'
      WHERE id IN (SELECT message_id FROM plan_topic_events);
      ALTER TABLE chat_messages ADD COLUMN reply_to_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL;
      ALTER TABLE tasks ADD COLUMN artifact_folder_id INTEGER REFERENCES journal_folders(id) ON DELETE SET NULL;
      ALTER TABLE subtask_artifact_versions ADD COLUMN note_id TEXT REFERENCES user_notes(id) ON DELETE SET NULL;
      CREATE TRIGGER task_artifact_folder_create AFTER INSERT ON tasks BEGIN
        INSERT INTO journal_folders(parent_id,name,position)
          VALUES((SELECT notes_folder_id FROM projects WHERE id=NEW.project_id),substr(NEW.title,1,100),0);
        UPDATE tasks SET artifact_folder_id=last_insert_rowid() WHERE id=NEW.id;
      END;
      UPDATE chat_messages SET message_type='task_proposal'
      WHERE from_user_id='u-secretary' AND task_id IS NOT NULL AND message_type IS NULL
        AND task_id IN (SELECT id FROM tasks WHERE creator_id='u-secretary');
    `);
  } },

  { id: "096_plan_events_outside_chat", description: "События плана в журнале, без сообщений в чате", up: () => {
    db.exec(`CREATE TABLE plan_event_journal(
      plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(plan_id,version)
    );
    INSERT INTO plan_event_journal(plan_id,version,snapshot,created_at)
      SELECT e.plan_id,e.version,e.snapshot,COALESCE(m.created_at,datetime('now'))
      FROM plan_topic_events e LEFT JOIN chat_messages m ON m.id=e.message_id;
    DELETE FROM chat_messages WHERE id IN (SELECT message_id FROM plan_topic_events);
    `);
  } },

  { id: "097_shared_slot_conversation", description: "Общая сессия работы и обсуждения слота", up: () => {
    db.exec(`CREATE TABLE slot_sessions(
      subtask_id TEXT PRIMARY KEY REFERENCES subtasks(id) ON DELETE CASCADE,
      session_file TEXT NOT NULL, cwd TEXT NOT NULL,
      session_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE chat_messages ADD COLUMN subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL;
    ALTER TABLE chat_messages ADD COLUMN recipient_subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL;
    CREATE TABLE slot_topic_inbox(
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      delivered_at TEXT, PRIMARY KEY(message_id,subtask_id)
    );`);
  } },

  // Снимок рабочего состояния слота — «на чём остановился» (владелец
  // 04.10.2026). Слот = подзадача-узел плана (`collaboration_plan_id` +
  // `plan_node_key`), его работа живёт в попытке (`attempts`), а ход роли
  // умирает вместе с процессом сервера: без отдельной записи следующий
  // вызов той же роли начинает с нуля и не понимает, где работа остановилась.
  //
  // Версии, а не одна строка: снимок дополняет историю и документы, ничего не
  // затирает. Привязка к (subtask_id, attempt_id) — снимок принадлежит своей
  // попытке; «последним» считается снимок самой свежей попытки, поэтому
  // запоздалая запись старого запуска физически не может стать актуальной.
  // Время последней рабочей активности сюда НЕ кладём — оно уже живёт в
  // `subtasks.agent_heartbeat_at`/`attempts.heartbeat_at` и не должно
  // подменяться моментом записи снимка.
  { id: "098_slot_work_snapshots", description: "Снимки рабочего состояния слотов", up: () => {
    db.exec(`CREATE TABLE slot_work_snapshots(
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      role_key TEXT,
      plan_node_key TEXT,
      reason TEXT NOT NULL,
      is_complete INTEGER NOT NULL DEFAULT 1,
      done_summary TEXT,
      left_summary TEXT,
      blocker TEXT,
      next_step TEXT,
      last_action TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      author_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_slot_snapshots_slot ON slot_work_snapshots(subtask_id, created_at);
    CREATE INDEX idx_slot_snapshots_attempt ON slot_work_snapshots(attempt_id, created_at);`);
  } },

  // Снять запрет на длинные тексты ролей (владелец 04.10.2026).
  //
  // Миграция 093 повесила на три таблицы по два триггера: INSERT и UPDATE
  // текста от учётки с `type='ai'` длиннее лимита прерывался RAISE(ABORT) —
  // `comments.text` и `chat_messages.text` больше 800 символов,
  // `subtasks.result` больше 400/800. Замысел был «пусть пишут короче», а
  // вышло наоборот: длинный ответ роли не сохранялся ВООБЩЕ. В чате не
  // появлялось ничего, в ленте карточки — тоже, и владелец видел тишину
  // вместо работы. Переписывать короче агент при этом не переписывает: он
  // про отказ не знает.
  //
  // Правило убрано целиком, вместе с кодом, который его обслуживал
  // (файл обрезки и пять мест применения в lib/ тоже удалены). Сервер
  // доставляет то, что роль написала; длину держит сама роль. Заодно это снимает и запрет
  // на UPDATE — правка длинного сообщения больше не пропадает.
  { id: "099_drop_agent_message_length_triggers", description: "Снять запрет на длинные тексты ролей — они больше не пропадают", up: () => {
    db.exec(`DROP TRIGGER IF EXISTS agent_short_comments_insert;
      DROP TRIGGER IF EXISTS agent_short_comments_update;
      DROP TRIGGER IF EXISTS agent_short_chat_messages_insert;
      DROP TRIGGER IF EXISTS agent_short_chat_messages_update;
      DROP TRIGGER IF EXISTS agent_short_subtasks_insert;
      DROP TRIGGER IF EXISTS agent_short_subtasks_update;`);
  } },

  // MAK-70 (04.10.2026): признак «влито» у задачи + уборка ветки/копии.
  //
  // merged_at — момент, когда ветка `roles/<id>` влита владельцем в main
  // (или в нужную базовую). До этого момента в карточке и в плане видно
  // «не влито»: иначе непонятно, можно ли закрывать карточку (ветка ещё
  // живая). merged_into_commit — SHA, на который влили; merged_branch —
  // имя целевой ветки (обычно main, но инициатива владельца 01.10.2026
  // допускает cherry-pick в рабочую ветку).
  //
  // workspace_cleared_at — момент, когда владелец удалил рабочую копию
  // (`~/.local/state/taskflow-runs/worktrees/<id>`). Без отметки сервер
  // не знает, осталась ли она на диске, и при следующем входе роли снова
  // поднимет копию поверх влитой ветки — а это лишний шум.
  //
  // Идемпотентно через PRAGMA: после прогретой БД колонки могут быть,
  // и тогда пропускаем.
  { id: "100_task_merge_marker", description: "MAK-70: признак «влито» и метки уборки ветки/копии", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("merged_at")) {
      db.exec("ALTER TABLE tasks ADD COLUMN merged_at TEXT");
    }
    if (!cols.has("merged_into_commit")) {
      db.exec("ALTER TABLE tasks ADD COLUMN merged_into_commit TEXT");
    }
    if (!cols.has("merged_into_branch")) {
      db.exec("ALTER TABLE tasks ADD COLUMN merged_into_branch TEXT");
    }
    if (!cols.has("merged_by")) {
      db.exec("ALTER TABLE tasks ADD COLUMN merged_by TEXT REFERENCES users(id) ON DELETE SET NULL");
    }
    if (!cols.has("branch_cleared_at")) {
      db.exec("ALTER TABLE tasks ADD COLUMN branch_cleared_at TEXT");
    }
    if (!cols.has("workspace_cleared_at")) {
      db.exec("ALTER TABLE tasks ADD COLUMN workspace_cleared_at TEXT");
    }
  } },

  // MAK-77 (06.10.2026): модель конкретного шага плана («провайдер/модель»).
  // NULL — как раньше, по настройкам роли. Основа роутера: одна и та же роль
  // может работать на разных моделях.
  { id: "101_subtask_model", description: "MAK-77: модель конкретного шага плана", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("model")) {
      db.exec("ALTER TABLE subtasks ADD COLUMN model TEXT");
    }
  } },

  // Приватные проекты (задача 9d583c58…). Колонка `is_private` уже
  // добавлена в `db.ts:migrate()` (аддитивно через PRAGMA table_info +
  // ALTER TABLE — тот же приём, что и для projects.position/pinned), и
  // свежая база получает её прямо в CREATE TABLE. Этой миграции здесь
  // нечего делать: она нужна, только чтобы зафиксировать факт в
  // schema_migrations, и для прогонов, в которых ALTER уже выполнен, но
  // запись в schema_migrations ещё не сделана. Поэтому `up()` идемпотентен
  // и просто проверяет наличие колонки.
  { id: "102_private_projects", description: "Приватные проекты: projects.is_private, скрытие в API", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("is_private")) {
      db.exec("ALTER TABLE projects ADD COLUMN is_private INTEGER DEFAULT 0");
    }
  } },
  { id: "111_role_prompts_laconism", description: "Блок «Лаконичность» в начало промпта secretary (роль в БД перекрывает файл); c19c9460 (D2).", up: () => {
    // roles.prompt для secretary задан миграцией 062 и перекрывает
    // server/scripts/role-prompts/secretary.md. Без этой правки блок
    // «Лаконичность» в файле для работающей системы не действует.
    // Идемпотентно: если блок уже вставлен (маркер) — выходим; иначе
    // дописываем его в начало существующего текста, не затирая правил 062.
    const LACONISM_MARKER = "## Лаконичность\n";
    const laconismBlock = [
      "## Лаконичность",
      "",
      "Пиши коротко. Подробности оформляй документом (`taskflow_doc_write`) и давай ссылку.",
      "",
      "- Сообщение другой роли или в чат — **до 3 предложений**.",
      "- Поле `result` шага — **1–2 предложения**.",
      "- Комментарий в ленте — **статус + ссылка** на документ/артефакт.",
      "- Не пересказывай задачу и свои прошлые шаги.",
      "- Не вставляй в сообщения код и логи — указывай путь к файлу и коммит.",
      "- Не рассуждай вслух в чате — итог и решение, без разбора хода мыслей.",
      "",
    ].join("\n");
    const row = db.prepare("SELECT prompt FROM roles WHERE key = 'secretary'").get() as { prompt: string | null } | undefined;
    if (!row || row.prompt == null) {
      // Миграция 062 ещё не отработала (свежая БД): промпт проставит она,
      // здесь ничего не пишем — иначе затрём её текст.
      return;
    }
    if (row.prompt.includes(LACONISM_MARKER)) return;
    db.prepare("UPDATE roles SET prompt = ? WHERE key = 'secretary'").run(
      laconismBlock + row.prompt,
    );
  } },

  // Автоимпорт из Linear (карточка cc7caa43…). Ручной импорт (085) уже умеет
  // читать задачу, вести трёхсторонний merge по полям и хранить соответствия
  // source_id → task_id. Автоимпорту нужны ещё две вещи:
  //   • соответствие «проект Linear → родительская карточка», потому что
  //     фоновая служба заводит проект как родителя, а задачи — его детьми;
  //   • состояние службы: когда был последний успешный/неуспешный проход,
  //     какая ошибка, когда владельцу последний раз говорили о простое, и
  //     выключатель (по умолчанию включён).
  // Состояние — отдельной таблицей, а не колонкой users: служба одна на
  // владельца, но её служебные поля к учётке отношения не имеют.
  { id: "103_linear_autoimport", description: "Автоимпорт Linear: проекты «Сейчас», состояние службы и выключатель", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linear_autoimport_projects (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(owner_id, workspace_id, project_id)
      );
      CREATE TABLE IF NOT EXISTS linear_autoimport_state (
        owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        notified_at TEXT,
        created_total INTEGER NOT NULL DEFAULT 0,
        updated_total INTEGER NOT NULL DEFAULT 0
      );
    `);
  } },
  // Чаты (карточка ca816271, документ проектирования d748e4f4-f502-4002-b622-f070be0d8438).
  // Пункты владельца: Секретарь — обычный личный чат, общий групповой чат
  // ролей, чат задачи закрывается с задачей, только `@` будит.
  //
  // 1) Секретарь получает `role_key='secretary'`, оставаясь на фиксированной
  //    учётке `u-secretary` (на неё ссылаются chat_messages, клиенты и
  //    `roleUserId('secretary')`). Триггеры `users_role_key_*_guard` требуют
  //    `id = 'role_' || role_key`; ослабляем их ровно одним исключением
  //    `id='u-secretary' AND role_key='secretary'` — после этого Секретарь
  //    проходит общий путь ролей без спецкода.
  // 2) `chats.closed_at` — тема задачи закрывается вместе с задачей.
  // 3) `chats.pinned_message_id` — закреплённый регламент общего чата.
  // 4) `chat-common` — общий групповой чат: все активные роли, Секретарь,
  //    владелец, оркестратор. Регламент строится из паспортов ролей.
  // 5) Бэкфил: уже завершённые задачи получают закрытую тему.
  { id: "104_chats_common_secretary_lifecycle", description: "Секретарь как роль, closed_at/pinned_message_id, общий чат", up: () => {
    const chatCols = new Set(
      (db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!chatCols.has("closed_at")) {
      db.exec("ALTER TABLE chats ADD COLUMN closed_at TEXT");
    }
    if (!chatCols.has("pinned_message_id")) {
      db.exec("ALTER TABLE chats ADD COLUMN pinned_message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL");
    }

    // Ослабляем guard'ы только для пары u-secretary/secretary. Во всём
    // остальном правило прежнее: role_key без канонической учётки запрещён.
    db.exec(`
      DROP TRIGGER IF EXISTS users_role_key_insert_guard;
      DROP TRIGGER IF EXISTS users_role_key_update_guard;
      CREATE TRIGGER users_role_key_insert_guard
      BEFORE INSERT ON users
      WHEN NEW.role_key IS NOT NULL AND (
        NEW.type <> 'ai'
        OR NEW.role <> 'agent'
        OR COALESCE(NEW.is_system_bot, 0) <> 1
        OR NOT (NEW.id = 'role_' || NEW.role_key OR (NEW.id = 'u-secretary' AND NEW.role_key = 'secretary'))
        OR NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role_key)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid users.role_key binding');
      END;
      CREATE TRIGGER users_role_key_update_guard
      BEFORE UPDATE OF id, role, role_key, type, is_system_bot ON users
      WHEN NEW.role_key IS NOT NULL AND (
        NEW.type <> 'ai'
        OR NEW.role <> 'agent'
        OR COALESCE(NEW.is_system_bot, 0) <> 1
        OR NOT (NEW.id = 'role_' || NEW.role_key OR (NEW.id = 'u-secretary' AND NEW.role_key = 'secretary'))
        OR NOT EXISTS (SELECT 1 FROM roles WHERE key = NEW.role_key)
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid users.role_key binding');
      END;
    `);
    db.prepare(
      `UPDATE users SET role_key = 'secretary'
        WHERE id = 'u-secretary' AND role = 'agent' AND type = 'ai'
          AND COALESCE(is_system_bot, 0) = 1
          AND (role_key IS NULL OR role_key <> 'secretary')`,
    ).run();
    // Сводка задач больше не перехватывается сервером «до модели» —
    // Секретарь собирает её инструментом как обычная роль. Подсказываем
    // ему инструмент прямо в промпте, чтобы просьба «пришли сводку»
    // не осталась без ответа.
    db.prepare(
      `UPDATE roles SET prompt = COALESCE(prompt, '') || ?
        WHERE key = 'secretary' AND COALESCE(prompt, '') NOT LIKE '%taskflow_task_summary%'`,
    ).run(
      "\n\nСводку задач по просьбе владельца собирай инструментом taskflow_task_summary — цифры не выдумывай.",
    );

    // Общий чат. Владелец — самый ранний владелец трекера.
    const owner = (
      db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as
        | { id: string }
        | undefined
    )?.id;
    if (owner) {
      db.prepare(
        `INSERT OR IGNORE INTO chats (id, title, kind, created_by, project_id, parent_chat_id, task_id)
         VALUES ('chat-common', 'Общий чат', 'group', ?, NULL, NULL, NULL)`,
      ).run(owner);
      db.prepare(
        "INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES ('chat-common', ?)",
      ).run(owner);
    }
    // Участники — все активные роли (включая Секретаря) и оркестратор.
    // Учётка роли = role_<key>, у Секретаря — u-secretary; включаем только
    // роли с roles.enabled=1, чтобы состав совпадал с рабочим.
    db.exec(`
      INSERT OR IGNORE INTO chat_members (chat_id, member_id)
      SELECT 'chat-common', u.id FROM users u
       WHERE COALESCE(u.archived, 0) = 0 AND (
         (u.type = 'ai' AND u.role = 'agent' AND u.role_key IN (SELECT key FROM roles WHERE enabled = 1))
         OR (u.id = 'u-secretary')
         OR u.role = 'orchestrator'
       );
    `);

    // Закреплённый регламент — одно сообщение от системной учётки,
    // собираемое из паспортов ролей. Обновляется только явным действием,
    // поэтому здесь только первичный посев (если его ещё нет).
    if (owner) {
      const systemId = (
        db.prepare("SELECT id FROM users WHERE id = 'taskflow_system'").get() as
          | { id: string }
          | undefined
      )?.id;
      if (systemId) {
        const existing = db
          .prepare("SELECT pinned_message_id FROM chats WHERE id = 'chat-common'")
          .get() as { pinned_message_id: string | null } | undefined;
        if (existing && !existing.pinned_message_id) {
          const roles = db
            .prepare("SELECT key, title, summary FROM roles WHERE enabled = 1 ORDER BY position, key")
            .all() as Array<{ key: string; title: string; summary: string | null }>;
          const text = [
            "Регламент общего чата TaskFlow.",
            "Здесь все роли, Секретарь и владелец. Сервер сюда не пишет — только человек и роль по своей команде.",
            "Обращение к участнику — только через @; упоминание имени без @ никого не будит.",
            "Кто за что отвечает:",
            ...roles.map((r) => `@${r.key} — ${r.title}: ${r.summary ?? ""}`.trimEnd()),
            "Секретарь — личный помощник владельца: разговор, вопросы, разбор надиктовки.",
          ].join("\n");
          const msgId = 'chat-common-regulator';
          db.prepare(
            `INSERT OR IGNORE INTO chat_messages (id, from_user_id, text, channel, chat_id, message_type)
             VALUES (?, ?, ?, 'chat', 'chat-common', 'system')`,
          ).run(msgId, systemId, text);
          db.prepare("UPDATE chats SET pinned_message_id = ? WHERE id = 'chat-common'").run(msgId);
        }
      }
    }

    // Бэкфил закрытых тем: задача уже завершена — тема закрыта её временем.
    db.exec(`
      UPDATE chats SET closed_at = COALESCE(
        (SELECT t.completed_at FROM tasks t WHERE t.id = chats.task_id), datetime('now'))
       WHERE task_id IS NOT NULL AND parent_chat_id IS NOT NULL AND closed_at IS NULL
         AND task_id IN (SELECT id FROM tasks WHERE status = 'completed');
    `);
  } },
  { id: "105_secretary_room_ensure", description: "Комната чата Секретаря: личный чат владельца с u-secretary, если её нет (iOS открывает chat-secretary)", up: () => {
    const owner = (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
    if (!owner) return;
    db.prepare("INSERT OR IGNORE INTO chats (id, title, kind, created_by, task_id) VALUES ('chat-secretary', 'Секретарь', 'direct', ?, NULL)").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES ('chat-secretary', ?)").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, member_id) VALUES ('chat-secretary', 'u-secretary')").run();
  } },
  // Обратная синхронизация TaskFlow → Linear (карточка 20e30338, техрешение
  // 532e39a2). Отдельный узкий путь записи: очередь фиксированных операций
  // («state» и «comment»), запись выполняется только для задач, привязанных
  // по линейной таблице соответствий. Здесь же — состояние службы с
  // выключателем и кэш id статусов workflow команды Linear, чтобы не
  // дёргать Linear на каждый проход.
  { id: "106_linear_sync", description: "Обратная синхронизация Linear: очередь записи, выключатель и кэш статусов", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linear_sync_queue (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('state','comment')),
        payload TEXT,
        desired_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, workspace_id, task_id, desired_key)
      );
      CREATE TABLE IF NOT EXISTS linear_sync_tasks (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        last_state TEXT,
        last_comment_key TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(owner_id, workspace_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS linear_sync_state (
        owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_pass_at TEXT,
        last_success_at TEXT,
        last_sent_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        notified_at TEXT,
        sent_total INTEGER NOT NULL DEFAULT 0,
        failed_total INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS linear_sync_states_cache (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state_id TEXT NOT NULL,
        type TEXT NOT NULL,
        cached_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(owner_id, workspace_id, team_id, name)
      );
    `);
  } },

  // Архив проектов (карточка a1be7d63…). Удаление проекта больше не
  // уничтожает данные, а проставляет `archived_at`/`archived_by`.
  // Колонки уже добавлены в `db.ts:migrate()` (аддитивно, как position/
  // pinned/is_private), свежая база получает их прямо из CREATE TABLE.
  // Эта миграция идемпотентна и нужна, чтобы зафиксировать факт в
  // schema_migrations и дотянуть уже существующие базы.
  { id: "107_project_archive", description: "Архив проектов: projects.archived_at/archived_by", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("archived_at")) {
      db.exec("ALTER TABLE projects ADD COLUMN archived_at TEXT");
    }
    if (!cols.has("archived_by")) {
      db.exec("ALTER TABLE projects ADD COLUMN archived_by TEXT");
    }
    // Журнал окончательных удалений из архива: фиксирует факт и числа до
    // того, как данные будут стЁрты. Хранится вечно — единственный след
    // проекта после purge, потому что `project_id` здесь без внешнего
    // ключа (сам проект удаляется).
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_purge_log (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        actor_id TEXT REFERENCES users(id),
        tasks INTEGER NOT NULL DEFAULT 0,
        documents INTEGER NOT NULL DEFAULT 0,
        chats INTEGER NOT NULL DEFAULT 0,
        memories INTEGER NOT NULL DEFAULT 0,
        with_docs INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_purge_log_project
        ON project_purge_log(project_id, created_at DESC);
    `);
  } },
  { id: "108_remove_pi_agent_account", description:
      "MAK-72: учётка «Pi Agent» (1fa09a0a-…) удалена. С 06.10.2026 планировщик " +
      "и системная автоматика ходят учёткой «Система» (taskflow_system), а не " +
      "исторической Pi Agent. Ссылки на удаляемую учётку переводятся на «Систему» " +
      "(nullable-колонки — в NULL), затем строка users удаляется.", up: () => {
    const LEGACY_IDS = ["1fa09a0a-0c41-4e7e-982a-a1c46570e5d2"]; // Pi Agent
    const SYSTEM_ID = "taskflow_system";
    const ph = LEGACY_IDS.map(() => "?").join(",");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of tables) {
      let fks: Array<{ table: string; from: string }> = [];
      try {
        fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Array<{ table: string; from: string }>;
      } catch {
        continue;
      }
      for (const fk of fks) {
        if (fk.table !== "users") continue;
        let notnull = false;
        try {
          const info = db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{
            name: string;
            notnull: number;
            pk: number;
          }>;
          const col = info.find((c) => c.name === fk.from);
          notnull = Boolean(col?.notnull) || (col?.pk ?? 0) > 0;
        } catch {
          // нет сведений о колонке — считаем nullable
        }
        if (notnull && fk.from === "id") continue; // PK не переписать
        try {
          db.prepare(
            `UPDATE "${t}" SET "${fk.from}" = ? WHERE "${fk.from}" IN (${ph})`,
          ).run(notnull ? SYSTEM_ID : null, ...LEGACY_IDS);
        } catch {
          // колонку не перевести — падение на DELETE покажет остаток
        }
      }
    }
    for (const id of LEGACY_IDS) {
      try {
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
      } catch {
        // остались ссылки из непокрытой таблицы — хотя бы не пускаем в работу
        db.prepare("UPDATE users SET archived = 1 WHERE id = ?").run(id);
      }
    }
  } },

  { id: "109_typed_blocked_role_messages", description:
      "MAK-98: типизированный blocked и срок жизни сообщения роли. " +
      "subtasks получают собственный block_type/blocked_at (повторный блок того же вида " +
      "по шагу виден серверу); таблица role_message_waiting помнит вопрос роли, его адресата " +
      "и deadline_at, чтобы вернуть отправителю исход «срок истёк». Идемпотентно: колонки " +
      "добавляются через pragma, таблица — CREATE IF NOT EXISTS.", up: () => {
    const subCols = new Set(
      (db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!subCols.has("block_type")) db.exec("ALTER TABLE subtasks ADD COLUMN block_type TEXT");
    if (!subCols.has("blocked_at")) db.exec("ALTER TABLE subtasks ADD COLUMN blocked_at TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS role_message_waiting (
        message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        from_user_id TEXT NOT NULL REFERENCES users(id),
        to_user_id TEXT NOT NULL REFERENCES users(id),
        subtask_id TEXT,
        recipient_subtask_id TEXT,
        question_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deadline_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','expired')),
        answered_at TEXT,
        expired_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_role_message_waiting_open
        ON role_message_waiting(status, deadline_at);
      CREATE INDEX IF NOT EXISTS idx_role_message_waiting_chat
        ON role_message_waiting(chat_id, to_user_id, status);
    `);
  } },
  { id: "110_stalled_step_watch", description: "Карточка 71651ad0: индекс под сторож зависших шагов (фильтр по agent_state + agent_heartbeat_at) и по attempt outcome для счётчика auto_restarted", up: () => {
    // Без индекса сторож сканирует всю `subtasks` раз в минуту, а это
    // единственный серверный цикл, который крутится на холодной базе
    // без таймеров systemd. Карточка 71651ad0 (А30/А37/А38/А39/Г1-к/Г1-л).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_heartbeat
               ON subtasks(agent_state, agent_heartbeat_at)
              WHERE agent_state = 'in_progress' AND collaboration_plan_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attempts_outcome_started
               ON attempts(subtask_id, outcome, started_at)`);
  } },
  { id: "112_test_run_budget", description: "Бюджет полных прогонов серверного набора: не больше двух на задачу, Разработчику один (владелец 06.10.2026)", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_run_budget (
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        full_runs INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_id, role)
      )
    `);
  } },
  { id: "113_orchestrator_events", description: "Очередь событий для вебхука оркестратора: сервер сам будит оркестратора (владелец 06.10.2026)", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        task_id TEXT NOT NULL,
        field TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        expired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_orchestrator_events_pending
        ON orchestrator_events(delivered_at, id);
    `);
  } },
  { id: "114_qa_live_tester_name", description: "Роль QA переименована в «Лайф-тестировщик»: проверяет только живое приложение (владелец 07.10.2026). Ключ qa и id role_qa не меняются", up: () => {
    // Только если название ещё прежнее — ручное переименование владельца не затираем.
    db.prepare("UPDATE roles SET title = 'Лайф-тестировщик', summary = 'пройти сценарии в живом приложении и найти баги.' WHERE key = 'qa' AND title = 'QA'").run();
    db.prepare("UPDATE users SET name = 'Лайф-тестировщик' WHERE id = 'role_qa' AND name = 'QA'").run();
  } },
  { id: "115_provider_limits_mode", description: "Метка лимита провайдера: режим timer (работал и упёрся — возврат через 5 ч 5 мин) или probe (упёрлись сразу — снимает проба) (владелец 07.10.2026)", up: () => {
    const cols = db.prepare("PRAGMA table_info(provider_limits)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "mode")) {
      db.exec("ALTER TABLE provider_limits ADD COLUMN mode TEXT NOT NULL DEFAULT 'timer'");
    }
  } },
  { id: "116_runtime_settings", description: "Общие настройки рантайма: автопереключение при лимите и автовозврат на основную модель (владелец 07.10.2026)", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } },

  // Архив задач вместо удаления (карточка 57c69735…). Зеркало миграции
  // 107_project_archive, но для задач. Колонки `tasks.archived_at` /
  // `tasks.archived_by` уже добавлены в `db.ts:migrate()` (аддитивно, как
  // проекты), эта миграция их фиксирует в schema_migrations и дотягивает
  // уже существующие базы. Никакого бэкфила `archived_at` задним числом
  // и никакого переноса существующего проекта «Архив»: решение о
  // миграции — за владельцем.
  //
  // Журнал `task_purge_log` — единый след карточки после purge. По
  // образцу `project_purge_log`: фиксированный набор полей (id, task_id,
  // task_title, project_id, actor_id, subtasks, comments, attachments,
  // events, created_at), индекс `(task_id, created_at DESC)`. project_id
  // хранится без внешнего ключа: на момент purge проект может быть уже
  // purged (другая операция), и ON DELETE CASCADE не нужен.
  { id: "117_task_archive", description: "Архив задач: tasks.archived_at/archived_by + task_purge_log", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("archived_at")) {
      db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
    }
    if (!cols.has("archived_by")) {
      db.exec("ALTER TABLE tasks ADD COLUMN archived_by TEXT REFERENCES users(id)");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_purge_log (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        project_id TEXT,
        actor_id TEXT REFERENCES users(id),
        subtasks INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        attachments INTEGER NOT NULL DEFAULT 0,
        events INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_purge_log_task
        ON task_purge_log(task_id, created_at DESC);
    `);
  } },

  { id: "118_plan_handoff_on_submission", description: "Role handoffs open on submission, acceptance remains a review status", up() {
    db.exec("UPDATE task_collaboration_plan_edges SET start_condition='submitted' WHERE start_condition='accepted'");
  } },
  {
    id: "119_kb_root_folder",
    description:
      "Пометка корневой папки библиотеки знаний (08.10.2026, решение владельца: роли должны читать контекст из единой корневой папки «TaskFlow Library» через taskflow_kb_search в первую очередь, и сами пополнять её находками). Колонка is_kb_root в journal_folders — ровно одна корневая папка (по соглашению «TaskFlow Library»), не привязанная к проекту. Индекс — частичный, чтобы быстро находить корень при запросах обогатителя и при суточном RAGFlow-синке. Существующие папки получают is_kb_root=0 по умолчанию.",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(journal_folders)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "is_kb_root")) {
        db.exec(
          `ALTER TABLE journal_folders ADD COLUMN is_kb_root INTEGER NOT NULL DEFAULT 0;`,
        );
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_journal_folders_kb_root
           ON journal_folders(is_kb_root) WHERE is_kb_root = 1;`,
      );
    },
  },

  // Единый реестр серверных параметров (MAK-95). Владелец правит значения
  // через Настройки → Сервер, изменения публикуются через шину событий и
  // подхватываются долгоживущими модулями без перезапуска процесса.
  // Значение по умолчанию — это хардкод в `serverSettingsRegistry.ts`,
  // здесь seed не нужен: ключ появляется в `server_settings` ровно когда
  // владелец (или смоук-тест) записал туда первое значение. Пустая
  // таблица = «всё по дефолту из кода», и это ожидаемое поведение.
  { id: "120_server_settings_registry", description: "Реестр серверных параметров: server_settings + server_settings_log", up() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by TEXT REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS server_settings_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT NOT NULL,
        reason TEXT,
        actor_id TEXT REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_server_settings_log_key
        ON server_settings_log(key, created_at DESC);
    `);
  } },

  { id: "121_owner_command_log", description:
      "MAK-82 / карточка d9dee6f8 «Сервер: выполнение команд владельца на .110»: " +
      "журнал вызовов /api/owner-command/run — кто/что/когда/чем кончилось. " +
      "request_id (UUID) связывает вызов с лентой и журналом; who (FK users) — " +
      "кто звал; action — какое действие из белого списка или произвольное; " +
      "command — конкретная команда (systemctl/journalctl/sqlite3), " +
      "params — параметры (имя сервиса, N строк журнала и т.п.), confirm — " +
      "передано ли подтверждение для не-белых действий. " +
      "started_at/finished_at (UTC), duration_ms, exit_code, " +
      "outcome ∈ (ok|rejected|timeout|error|backup_failed), stdout/stderr " +
      "(TEXT — лимит 64 KiB, обрезка хвостом), backup_path — путь к автобэкапу " +
      "(NULL если действие его не требует). " +
      "error — текстовая причина отказа/ошибки (NULL при ok). " +
      "Идемпотентно: CREATE TABLE IF NOT EXISTS + индексы IF NOT EXISTS.", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_command_log (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        who TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        command TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        confirm INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        duration_ms INTEGER,
        exit_code INTEGER,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('ok','rejected','timeout','error','backup_failed')),
        stdout TEXT,
        stderr TEXT,
        backup_path TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_owner_command_log_who
        ON owner_command_log(who, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_owner_command_log_outcome
        ON owner_command_log(outcome, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_owner_command_log_started
        ON owner_command_log(started_at DESC);
    `);
    db.prepare("UPDATE roles SET prompt=prompt || ? WHERE length(trim(coalesce(prompt,'')))>0 AND instr(prompt,'Команды владельцу — формат выдачи')=0").run("\n\n## Команды владельцу — формат выдачи\nКоманды для сервера .110 выдавай отдельным закрытым блоком bash: одна команда на блок, без приглашения $ и без ожидаемого вывода. Это позволяет владельцу подтвердить запуск кнопкой Play в iOS. Для команд Mac/iPhone явно укажи другую машину и используй блок с меткой zsh, чтобы не предлагать запуск на .110.\n");
  } },
  // ebc4d338 (queue, 09.10.2026): durable очередь сообщений роли +
  // generation fence. in-memory Map в chatSession.ts после рестарта
  // теряет неотработанные ходы на (chat_id, role_id); повторная
  // доставка POST и хвост старой Pi-сессии пропускаются насквозь.
  //
  // Два слоя:
  //   1. `chat_message_queue` — pending/picked ход на пару (chat, role):
  //      переживает рестарт, дедуп по `(chat_id, role_id, delivery_id)`,
  //      хранит `session_generation` на момент принятия.
  //   2. `chat_session_generation` — текущий generation пары: инкремент
  //      при `/new-session` или при фактическом крахе Pi. Ход из старой
  //      generation не применяется, а помечается `superseded` с записью
  //      в `task_events`.
  //
  // Внешние ключи: chat_id → chats(id) ON DELETE CASCADE; role_id →
  // users(id) ON DELETE CASCADE. delivery_id — текстовый ключ дедупа
  // (по умолчанию message_id, но клиент может прислать свой
  // `Idempotency-Key` через x-delivery-id).
  { id: "123_chat_message_queue_and_generation", description: "Карточка ebc4d338-…: durable очередь ходов роли + generation fence для пар (chat, role)", up: () => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_message_queue(
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
      session_generation INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','done','failed','superseded')),
      picked_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_queue_dedupe
      ON chat_message_queue(chat_id, role_id, delivery_id);
    CREATE INDEX IF NOT EXISTS idx_chat_message_queue_ready
      ON chat_message_queue(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_message_queue_session
      ON chat_message_queue(chat_id, role_id, status, session_generation);

    CREATE TABLE IF NOT EXISTS chat_session_generation(
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 1,
      bumped_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, role_id)
    );`);
  } },

  { id: "122_html_panel_command_contract", description: "Подключённые HTML-панели: контракт TaskFlow.runCommand в непустых DB-инструкциях ролей", up() {
    db.prepare("UPDATE roles SET prompt=prompt || ? WHERE length(trim(coalesce(prompt,'')))>0 AND instr(prompt,'## Подключённые HTML-панели в iOS')=0").run("\n\n## Подключённые HTML-панели в iOS\nЧтобы кнопка HTML-панели выполняла действие на сервере .110, вызывай в обработчике нажатия `const result = await TaskFlow.runCommand(command)`; command — точная Bash-команда строкой. Вызов делается сразу после нажатия, до первого другого await. Приложение само покажет владельцу нативное подтверждение и выполнит команду после его согласия. Promise вернёт {outcome, stdout, stderr, exitCode, durationSeconds, requestId}, либо отклонится при отмене/ошибке. Показывай настоящий результат в панели через textContent, обрабай catch и блокируй кнопку до finally. Не запускай действия при загрузке страницы, по таймеру или автоматически. Не проси токен и не делай fetch к API. Не обещай подключённое действие, если не используешь этот мост. Для Mac/iPhone этот мост не подходит — команды выполняются только на .110.\nПример: `<button onclick=\"run(this)\">Проверить сервер</button><pre id=\"result\"></pre><script>async function run(b){b.disabled=true;try{const r=await TaskFlow.runCommand(\"uptime\");document.getElementById(\"result\").textContent=r.stdout+\"; код \"+r.exitCode}catch(e){document.getElementById(\"result\").textContent=e.message}finally{b.disabled=false}}</script>`.\n");
  } },
  { id: "123_webhook_subscriptions", description: "iOS-подписки на события TaskFlow (CRUD, секрет write-only, project+kind фильтры) + durable delivery и wake-очередь для пробуждения Codex-чата (карточка c3c0c199…)", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        secret_preview TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        event_kinds TEXT NOT NULL,
        project_id TEXT,
        codex_thread_id TEXT,
        delivery_count INTEGER NOT NULL DEFAULT 0,
        wake_count INTEGER NOT NULL DEFAULT 0,
        last_delivery_at TEXT,
        last_delivery_status INTEGER,
        last_error TEXT,
        last_wake_at TEXT,
        last_wake_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_subs_enabled
        ON webhook_subscriptions(enabled, id);
      CREATE INDEX IF NOT EXISTS idx_webhook_subs_project
        ON webhook_subscriptions(project_id);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
        status INTEGER,
        error TEXT,
        PRIMARY KEY (event_id, subscription_id),
        FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub
        ON webhook_deliveries(subscription_id, delivered_at DESC);

      CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        ran_at TEXT NOT NULL DEFAULT (datetime('now')),
        next_retry_at TEXT,
        status INTEGER,
        error TEXT,
        success INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_sub
        ON webhook_delivery_attempts(subscription_id, event_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_pending
        ON webhook_delivery_attempts(success, next_retry_at);

      CREATE TABLE IF NOT EXISTS webhook_wake_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        message TEXT NOT NULL,
        enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        UNIQUE (event_id, subscription_id),
        FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_wake_pending
        ON webhook_wake_queue(delivered_at, id);
    `);
  } },

  { id: "123_consultation_chain_log",
    description:
      "Карточка 412f89f4 (MAK-…): журнал фактических провайдера/модели и список попыток fallback-цепочки по консультации",
    up: () => {
      // Идемпотентно добавляем колонки — на свежей БД их нет, на существующей уже могут быть.
      const cols = db.prepare("PRAGMA table_info(consultation_log)").all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      if (!have.has("actual_provider")) db.exec("ALTER TABLE consultation_log ADD COLUMN actual_provider TEXT");
      if (!have.has("actual_model"))    db.exec("ALTER TABLE consultation_log ADD COLUMN actual_model TEXT");
      if (!have.has("chain_attempts"))  db.exec("ALTER TABLE consultation_log ADD COLUMN chain_attempts TEXT");
    },
  },


{ id: "124_plan_subtask_admission_fingerprint", description: "Admission: durable fingerprint и admission_cycle на узлах плана. Идемпотентный claim через атомарный compare-and-swap по fingerprint; различение нового цикла доработки (changes_requested) от старого. Карточка 8aa95906 (admission).", up() {
    const info = db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>;
    const has = (name: string) => info.some((c) => c.name === name);
    if (!has("admission_fingerprint")) {
      db.exec("ALTER TABLE subtasks ADD COLUMN admission_fingerprint TEXT");
    }
    if (!has("admission_cycle")) {
      db.exec("ALTER TABLE subtasks ADD COLUMN admission_cycle INTEGER NOT NULL DEFAULT 0");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_subtasks_plan_admission_cycle ON subtasks(collaboration_plan_id, admission_cycle) WHERE collaboration_plan_id IS NOT NULL");
  } },
  { id: "125_task_project_name_snapshot", description: "Снимок имени проекта в задаче. Удаление проекта складывает его задачи в архив вместо безвозвратного стирания (владелец 10.10.2026: проект — пустая оболочка, восстанавливать нечего, проще создать новый). Имя остаётся в карточке историческим следом.", up() {
    const info = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!info.some((c) => c.name === "project_name_snapshot")) {
      db.exec("ALTER TABLE tasks ADD COLUMN project_name_snapshot TEXT");
    }
    // Заполняем снимок у живых задач, чтобы переименование папки не стирало
    // прежнее имя в уже сохранённой истории.
    db.exec(`UPDATE tasks SET project_name_snapshot = (
      SELECT p.name FROM projects p WHERE p.id = tasks.project_id
    ) WHERE project_id IS NOT NULL AND project_name_snapshot IS NULL`);
  } },

{ id: "126_note_access_counters", description: "Учёт обращений к заметкам. Нужен, чтобы помечалковое решение Секретаря можно было проверять фактом: если к заметке, помеченной как мусор, роль так и не обратилась — мусор подтверждён; обратилась — Секретарь ошибся и заметку надо вернуть в ценное (10.10.2026, схема базы знаний, заметка cfa5cdcd).", up() {
    const info = db.prepare("PRAGMA table_info(user_notes)").all() as Array<{ name: string }>;
    const has = (name: string) => info.some((c) => c.name === name);
    if (!has("access_count")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!has("last_accessed_at")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN last_accessed_at TEXT");
    }
    // Отдельная таблица, а не только счётчик: видно, КТО обращался — по
    // этому решается, чей опыт пометки «мусор» опровергает.
    db.exec(`CREATE TABLE IF NOT EXISTS note_accesses (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_note_accesses_note ON note_accesses(note_id, accessed_at DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_note_accesses_actor ON note_accesses(actor_id, accessed_at DESC)");
    // Срез по роли строится по автору заметки и по дате — без этого индекса
    // таблица заметок сканируется целиком на каждом запуске роли.
    db.exec("CREATE INDEX IF NOT EXISTS idx_user_notes_author ON user_notes(updated_by, updated_at DESC)");
  } },

{ id: "127_kb_note_categories", description: "Категории заметок для схемы базы знаний (заметка cfa5cdcd). kb_temp_category — временная метка, пока заметка не разобрана; kb_category — постоянная категория, только такие индексируются и попадают в срез роли; kb_source_task_id — задача-источник, связь не теряется; kb_reviewed_by — кем размечено. Правило: секретарь помечает мусор, но не удаляет — решение принимается по факту обращений (server/src/lib/noteAccessWatcher.ts).", up() {
    const info = db.prepare("PRAGMA table_info(user_notes)").all() as Array<{ name: string }>;
    const has = (name: string) => info.some((c) => c.name === name);
    if (!has("kb_temp_category")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN kb_temp_category TEXT");
    }
    if (!has("kb_category")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN kb_category TEXT");
    }
    if (!has("kb_source_task_id")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN kb_source_task_id TEXT");
    }
    if (!has("kb_reviewed_by")) {
      db.exec("ALTER TABLE user_notes ADD COLUMN kb_reviewed_by TEXT");
    }
    // Срез роли строится на каждом запуске: заметки с постоянной категорией,
    // по автору, свежие сверху. Без составного индекса таблица сканируется
    // целиком.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_notes_kb_category
      ON user_notes(kb_category, updated_at DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_notes_kb_pending
      ON user_notes(kb_temp_category) WHERE kb_temp_category IS NOT NULL`);
    // Разбор накопившегося: сколько заметок ждут разбора.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_notes_kb_unreviewed
      ON user_notes(updated_at DESC) WHERE kb_category IS NULL`);
  } },

  // Общий серверный журнал событий (карточка e87cd93f). Заменяет
  // разрозненные console.* и добавляет привязку к операциям: одна операция
  // (например, запуск роли или вызов MCP-инструмента) порождает цепочку
  // событий, связанных общим operation_id, и завершается одним терминальным
  // событием с duration_ms и outcome.
  //
  // Без FK на tasks/subtasks: событие должно переживать удаление карточки,
  // иначе разбор «что было перед сбоем» станет невозможен как раз тогда,
  // когда он нужен. task_id/subtask_id — справочные поля, не обязательные.
  //
  // scope — широкая категория для фильтрации и хранения; kind — точное
  // имя события внутри scope. outcome NULL допустим для стартовых и
  // промежуточных событий (например, 'role_run_started'), терминальные
  // ('role_run_succeeded', 'mcp_call_err') всегда его заполняют.
  {
    id: "128_server_events",
    description: "Общий серверный журнал событий с привязкой к операциям (карточка e87cd93f).",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_events (
          id TEXT PRIMARY KEY,
          operation_id TEXT,
          scope TEXT NOT NULL CHECK (scope IN
            ('lifecycle','queue','role_run','mcp','enricher','http_error','system')),
          kind TEXT NOT NULL,
          -- actor_id, task_id, subtask_id — справочные поля БЕЗ FK:
          -- журнал должен переживать удаление пользователей и карточек,
          -- иначе событие о работе пропадёт ровно тогда, когда оно
          -- нужно для разбора. Связь с пользователем сохраняется как
          -- «кто тогда это делал», а не как обязательство схемы.
          actor_id TEXT,
          task_id TEXT,
          subtask_id TEXT,
          subtype TEXT,
          message TEXT,
          data_json TEXT,
          duration_ms INTEGER,
          outcome TEXT CHECK (outcome IN ('ok','err','timeout','skipped','cancelled') OR outcome IS NULL),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_server_events_created
          ON server_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_server_events_operation
          ON server_events(operation_id) WHERE operation_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_server_events_scope_kind
          ON server_events(scope, kind, created_at);
        CREATE INDEX IF NOT EXISTS idx_server_events_task
          ON server_events(task_id, created_at) WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_server_events_subtask
          ON server_events(subtask_id, created_at) WHERE subtask_id IS NOT NULL;
      `);
    },
  },
  { id: "129_subtask_work_plans", description: "Рабочий чек-лист исполнителя внутри подзадачи, без смены жизненного цикла", up() {
    db.exec(`CREATE TABLE IF NOT EXISTS subtask_work_plans (
      subtask_id TEXT PRIMARY KEY REFERENCES subtasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, items_json TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
    )`);
  } },

  // Этап A (10.10.2026, карточка d3a628eb-…): пробуждение idle-агента по
  // адресному сообщению. Колонка chat_messages.delivery_state фиксирует,
  // что произошло с доставкой конкретного сообщения получателю:
  //   'pending' — только записано в чат, доставка ещё не разбиралась;
  //   'sent' — в agent_inbox есть запись, но wake-канал не дёргался
  //            (исполнитель сам прочтёт при следующем heartbeat);
  //   'delivered' — wake-канал подтвердил пробуждение, и iPhone-UI/чат
  //                  отметили ACK (см. WebSocket `chat:delivered`,
  //                  зависит от ответа на В1 в feature_spec);
  //   'unreachable' — адресат не на слоте и офлайн, либо регламент
  //                    (channel='owner', задача своя) запрещает будить;
  //   'wake_queued' — wake_runner принял задание, фактическая отправка
  //                    пойдёт через webhook_wake_queue / processWakePass.
  //
  // CHECK идемпотентен через PRAGMA table_info: ADD COLUMN с тем же
  // ограничением на уже-применённой БД упадёт на «duplicate column name»,
  // поэтому обёрнуто в проверку. Значения, которых ещё нет в новой
  // таблице (исторические строки до внедрения миграции), получат DEFAULT
  // 'pending' и далее дозаписываются по факту обработки.
  { id: "130_chat_messages_delivery_state", description: "Колонка chat_messages.delivery_state: доставка адресного сообщения адресату", up() {
    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "delivery_state")) {
      db.exec(
        `ALTER TABLE chat_messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending' ` +
          `CHECK (delivery_state IN ('pending','sent','delivered','unreachable','wake_queued'))`,
      );
    }
  } },

  // Карточка 905db3e3-…: durable секрет + раздельные wake_queued/wake_acked.
  // Контракт архитектора V2 (документ d8c9973a в проекте, коммит 429be23a).
  // Уточнения ведущего (комментарий 2026-10-10):
  //  - секрет строго write-only во всех ответах POST/PATCH/GET/test;
  //  - ack только по независимому подтверждению turn started или явному
  //    callback чата; grep очереди не считается подтверждением;
  //  - отсутствие ключа не валит весь сервер — только конкретные
  //    операции (подпись, расшифровка, bootstrap).
  { id: "128_webhook_durable_secret_and_wake_ack", description: "Webhooks V2: колонка secret_encrypted (AES-256-GCM) + раздельные codex_followup_id / wake_acked_at / wake_acked_kind в webhook_wake_queue. Карточка 905db3e3-…", up: () => {
    const subInfo = db.prepare("PRAGMA table_info(webhook_subscriptions)").all() as Array<{ name: string }>;
    const subHas = (name: string) => subInfo.some((c) => c.name === name);
    if (!subHas("secret_encrypted")) {
      db.exec("ALTER TABLE webhook_subscriptions ADD COLUMN secret_encrypted BLOB");
    }

    const wakeInfo = db.prepare("PRAGMA table_info(webhook_wake_queue)").all() as Array<{ name: string }>;
    const wakeHas = (name: string) => wakeInfo.some((c) => c.name === name);
    if (!wakeHas("codex_followup_id")) {
      db.exec("ALTER TABLE webhook_wake_queue ADD COLUMN codex_followup_id TEXT");
    }
    if (!wakeHas("wake_acked_at")) {
      db.exec("ALTER TABLE webhook_wake_queue ADD COLUMN wake_acked_at TEXT");
    }
    if (!wakeHas("wake_acked_kind")) {
      db.exec("ALTER TABLE webhook_wake_queue ADD COLUMN wake_acked_kind TEXT");
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_wake_followup ON webhook_wake_queue(codex_followup_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_wake_ack_pending ON webhook_wake_queue(wake_acked_at) WHERE wake_acked_at IS NULL");
  } },
  // All submission paths persist done=1, including artifacts and final review.
  // Keep checklist finalization in the same SQLite transaction; no new gate.
  { id: "131_work_plan_submission_tail", description: "Подтверждённая сдача закрывает последний пункт рабочего чек-листа", up() {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS work_plan_submission_tail
      AFTER UPDATE OF done ON subtasks WHEN NEW.done = 1
      BEGIN
        UPDATE subtask_work_plans
           SET items_json = json_set(items_json, '$[#-1].state', 'done'),
               revision = revision + 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE subtask_id = NEW.id AND json_valid(items_json)
           AND json_array_length(items_json) > 0
           AND json_extract(items_json, '$[#-1].state') IN ('pending','in_progress');
      END;
      UPDATE subtask_work_plans
         SET items_json = json_set(items_json, '$[#-1].state', 'done'),
             revision = revision + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE subtask_id IN (SELECT id FROM subtasks WHERE done = 1)
         AND json_valid(items_json) AND json_array_length(items_json) > 0
         AND json_extract(items_json, '$[#-1].state') IN ('pending','in_progress');
    `);
  } },

  { id: "132_review_history", description: "Review facts survive permanent task deletion", up: installReviewHistory },

  { id: "133_agent_rules_manifests", description: "Версионированный manifest правил и подтверждения (этап B)", noTransaction: true, up() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_rules_manifests (
        rule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_markdown TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT (datetime('now')),
        published_by TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'superseded')),
        role_scope TEXT NOT NULL DEFAULT '*',
        superseded_by TEXT,
        PRIMARY KEY (rule_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_rules_manifests_status
        ON agent_rules_manifests(status);
      CREATE INDEX IF NOT EXISTS idx_agent_rules_manifests_rule_status
        ON agent_rules_manifests(rule_id, status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS rule_acknowledgements (
        role TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        session_id TEXT,
        acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (role, rule_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_rule_acknowledgements_role
        ON rule_acknowledgements(role);
    `);

    // chat_messages.rule_ref — расширяем CHECK на 'kind', чтобы старый путь
    // taskflow_chat_send мог пометить сообщение как «объявление правила» (а
    // серверная валидация — отвергнуть без rule_ref). Тип-маркер message_type
    // уже умеет принимать 'rule_…' через отдельные ручки, kind здесь —
    // исключительно для пользовательской разметки.
    const chatDdl = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'")
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
    if (chatDdl && !chatDdl.includes("'rule'")) {
      const oldCheck = "CHECK (kind IS NULL OR kind IN ('совещание', 'делегирование', 'находка'))";
      const newCheck = "CHECK (kind IS NULL OR kind IN ('совещание', 'делегирование', 'находка', 'rule'))";
      if (!chatDdl.includes(oldCheck)) {
        throw new Error(
          "133_agent_rules_manifests: не нашёл ожидаемый CHECK на chat_messages.kind, схема разошлась — миграция остановлена",
        );
      }
      const newDdl = chatDdl
        .replace(oldCheck, newCheck)
        .replace(/CREATE TABLE\s+"?chat_messages"?/i, 'CREATE TABLE "chat_messages_new"');
      if (newDdl === chatDdl || !newDdl.includes('CREATE TABLE "chat_messages_new"')) {
        throw new Error("133_agent_rules_manifests: не удалось подготовить пересборку chat_messages");
      }
      const rowsBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }
      ).n;
      db.pragma("foreign_keys = OFF");
      try {
        const rebuild = db.transaction(() => {
          db.exec(newDdl);
          db.exec('INSERT INTO "chat_messages_new" SELECT * FROM chat_messages');
          db.exec("DROP TABLE chat_messages");
          db.exec('ALTER TABLE "chat_messages_new" RENAME TO chat_messages');
        });
        rebuild();
        // DROP TABLE chat_messages убивает индексы таблицы вместе с ней.
        // Без восстановления ленты чатов и история задачи читают
        // chat_messages полным сканом (аудит 24.10.2026: так потерялись
        // idx_chat_messages_to / _task / _channel / _chat).
        //
        // Определения — из миграций 012/019/020 (git show 916c0c00:server/
        // src/migrations.ts). IF NOT EXISTS — идемпотентно.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_messages_to
            ON chat_messages(to_user_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_chat_messages_task
            ON chat_messages(task_id);
          CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
            ON chat_messages(channel, created_at);
          CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
            ON chat_messages(chat_id, created_at);
        `);
        const rowsAfter = (
          db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }
        ).n;
        if (rowsAfter !== rowsBefore) {
          throw new Error(
            `133_agent_rules_manifests: пересборка chat_messages потеряла строки (было ${rowsBefore}, стало ${rowsAfter})`,
          );
        }
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }

    const chatCols = (
      db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!chatCols.includes("rule_ref")) {
      db.exec("ALTER TABLE chat_messages ADD COLUMN rule_ref TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_rule_ref ON chat_messages(rule_ref)",
      );
    }
  } },

  { id: "134_service_incident_tasks", description: "Служебные карточки починки: tasks.service_hidden и tasks.incident_key (поломка — уведомление, а не задача в проекте)", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("service_hidden")) {
      db.exec("ALTER TABLE tasks ADD COLUMN service_hidden INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has("incident_key")) {
      db.exec("ALTER TABLE tasks ADD COLUMN incident_key TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_incident_key ON tasks(incident_key) WHERE incident_key IS NOT NULL");
  } },
  { id: "135_plan_node_phases", description: "Группа шага родителя ветки: до дочерних (подготовка) или после (итог)", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_node_phases (
        plan_id TEXT NOT NULL REFERENCES task_collaboration_plans(id) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('before', 'after')),
        PRIMARY KEY (plan_id, slot_key)
      );
    `);
  } },
  { id: "136_chat_work_launches", description: "Работа по разговору: запуск исполнителей из чата виджетом с кнопкой", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_work_launches (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        plan_id TEXT,
        title TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'started', 'cancelled')),
        role_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_work_launches_chat ON chat_work_launches(chat_id, created_at);
    `);
  } },
  {
    // Перенос T05 (a5de2628, 30.09.2026) в main 13.10.2026: исходный номер 080
    // занят, миграция идёт следующей по порядку. Идемпотентна по DDL.
    id: "137_collaboration_plan_bug_regression_profile",
    description: "Разрешить profile='bug_regression' (T05) в task_collaboration_plans.profile.",
    noTransaction: true,
    up: () => addBugRegressionProfile(),
  },
  {
    // Перенос e21d678b (04.10.2026) в main 13.10.2026: исходный номер 088 занят.
    id: "138_escalation_rules",
    description:
      "Умные напоминания о просроченных задачах (карточка 615095f4-…): таблица правил эскалации (по одной записи на владельца) + таблица фактов отправки для дедупа по (task, step) на сутки. Шаги лежат в steps_json — не отдельная таблица, потому что правил всегда один набор на пользователя, читается целиком, форма правит «своими» шагами без миграции БД. UNIQUE-индекс по выражению date(sent_at) (SQLite 3.31+) гасит повторный INSERT в ту же дату.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS escalation_rules (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 1,
          quiet_from TEXT NOT NULL DEFAULT '22:00',
          quiet_to TEXT NOT NULL DEFAULT '08:00',
          weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
          steps_json TEXT NOT NULL DEFAULT '[
            {"after_hours": 1,  "priority_max": 1, "channels": ["inapp","apns"]},
            {"after_hours": 4,  "priority_max": 2, "channels": ["inapp","apns"]},
            {"after_hours": 24, "priority_max": 3, "channels": ["inapp"]},
            {"after_hours": 72, "priority_max": 4, "channels": ["inapp"]}
          ]',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS escalation_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          -- Формат: "p<priority>_h<after_hours>", напр. "p1_h1", "p2_h4".
          -- Тот же префикс, что у notifications.type = "escalation_p<priority>_h<after_hours>".
          step_key TEXT NOT NULL,
          sent_at TEXT NOT NULL DEFAULT (datetime('now')),
          notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_escalation_events_task
          ON escalation_events(task_id);
        CREATE INDEX IF NOT EXISTS idx_escalation_events_user_sent
          ON escalation_events(user_id, sent_at);
        -- Дедуп: один (task_id, step_key) на date(sent_at). date(sent_at)
        -- — выражение, поддерживается SQLite 3.31+; ON CONFLICT в INSERT
        -- OR IGNORE сошлётся на этот индекс и тихо проглотит дубль.
        CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_event_day
          ON escalation_events(task_id, step_key, date(sent_at));
      `);
    },
  },
  { id: "139_mail_trusted_senders", description: "Белый список отправителей почты: их письма Секретарь читает напрямую, без пересказа", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_trusted_senders (
        address TEXT PRIMARY KEY,
        added_by TEXT REFERENCES users(id),
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } },
  {
    id: "140_collaboration_plan_orchestrated_profile",
    description: "Разрешить profile='orchestrated' (режим «Оркестратор») в task_collaboration_plans.profile.",
    noTransaction: true,
    up: () => addOrchestratedProfile(),
  },
  // Внешний доступ iPhone к TaskFlow (карточка b5a16110, документ решения
  // a91ac9a1-…, §11.1). Номер 141, а не 140: 140 уже занята
  // collaboration_plan_orchestrated_profile, и вставить вторую миграцию с
  // тем же id нельзя — schema_migrations по id уникальна, вторая молча
  // считалась бы уже применённой и таблиц не создала бы.
  //
  // Главное свойство схемы: НИ ОТКРЫТЫЙ QR-КОД, НИ ТОКЕН УСТРОЙСТВА В БАЗЕ
  // НЕ ЛЕЖАТ. Только sha256 (hashApiToken из db.ts) и короткий префикс
  // токена для показа в списке устройств — по нему человек узнаёт свой
  // телефон, но он к доступу не ведёт.
  { id: "141_device_pairing", description: "Привязка телефона по QR: одноразовый код, токен устройства, отзыв и журнал", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        source_ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_hash ON pairing_codes(code_hash);
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_owner ON pairing_codes(created_by, used_at, created_at);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        install_id TEXT NOT NULL,
        name TEXT,
        model TEXT,
        os TEXT,
        app_version TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        revoke_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, install_id);

      CREATE TABLE IF NOT EXISTS device_events (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        user_id TEXT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events(device_id, created_at);
    `);
  } },

  // Тикет 1 «Сервер: реестр машин и шлюз хостов», план taskflow-host (D4, D7).
  //
  // Хранение ключа повторяет devices (миграция 141): только sha256 и
  // префикс для показа. Сам ключ уходит на машину один раз и в базе не
  // остаётся — поэтому восстановить его нельзя, можно только отозвать и
  // выпустить новый.
  //
  // Имя машины уникально СРЕДИ ЖИВЫХ: роль спрашивает «машина mac», и две
  // живые машины с одним именем сделали бы такой вопрос неоднозначным.
  // Частичный индекс (revoked_at IS NULL) оставляет имя свободным после
  // отзыва — иначе пришлось бы придумывать mac-2.
  { id: "142_machine_registry", description: "Реестр машин-хостов: ключ, разрешённые корни, версия, онлайн, журнал событий", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        allowed_roots TEXT NOT NULL,
        host_version TEXT,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        online INTEGER NOT NULL DEFAULT 0,
        revoked_at TEXT,
        revoke_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_live_name
        ON machines(name) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_machines_token ON machines(token_hash);

      CREATE TABLE IF NOT EXISTS machine_events (
        id TEXT PRIMARY KEY,
        machine_id TEXT,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_machine_events_machine
        ON machine_events(machine_id, created_at);
    `);
  } },

  // Ветка от сообщения (владелец 14.10.2026): отдельный чат с теми же
  // участниками и своей сессией роли — основной разговор её контекстом не
  // засоряется. Номер 143: 142 занят реестром машин в соседней ветке.
  { id: "143_chat_branches", description: "Ветка чата от сообщения: chats.branch_of_chat_id и branch_of_message_id", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map(c => c.name));
    if (!cols.has("branch_of_chat_id")) db.exec("ALTER TABLE chats ADD COLUMN branch_of_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL");
    if (!cols.has("branch_of_message_id")) db.exec("ALTER TABLE chats ADD COLUMN branch_of_message_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chat_branches ON chats(branch_of_chat_id)");
  } },

  // Инженер .110 (владелец 14.10.2026): дежурный по домашнему серверу,
  // отвечает за «Состояние системы». Запись — как у POST /api/roles: строка
  // в roles и учётка role_<ключ> без входа. MCP инфрапанели подключает
  // runtime/infraPanelMcp.ts, карточки поломок направляет diagnosticDispatch.
  { id: "144_infra_engineer_role", description: "Роль «Инженер .110» — дежурный по серверу и «Состоянию системы»", up: () => {
    if (db.prepare("SELECT 1 FROM roles WHERE key = 'infra_engineer'").get()) return;
    const prompt = [
      "Ты — Инженер .110, дежурный по домашнему серверу 192.168.1.110 и всему, что на нём работает: сервисы systemd, TaskFlow, сеть и VPN, локальные модели (Ollama), интеграции (Linear, Telegram), база знаний, бэкапы. TaskFlow — команда, которая обслуживает этот сервер; ты в ней отвечаешь за раздел «Состояние системы». Каждая тревога сторожа — твоя карточка починки.",
      "Порядок работы: 1) сначала картина — инструменты инфрапанели mcp__infra__* (начинай с infra_overview, дальше infra_service, infra_logs, infra_health), статус юнитов и журналы; 2) найди причину, а не лечи симптом; 3) инфраструктуру — юниты, конфиги, сеть, модели, доступы интеграций — чини сам; если причина в коде TaskFlow, опиши дефект понятными словами и передай Разработчику через план; 4) после починки проверь, что сторож видит норму по результату, а не только что процесс запущен.",
      "Нельзя без владельца: перезапускать taskflow-server и голосовой сервис Секретаря, удалять данные, менять секреты в обход хранилища, вливать ветки в main. Если без этого не починить — блокируйся и прямо напиши, какое действие нужно от владельца.",
      "Повторяющаяся тревога об одной и той же проблеме — одна поломка: не заводи новую карточку на каждое повторение.",
      "Где что лежит. Журнал уведомлений и поломок — ~/Проекты/taskflow-уведомления: inbox/ГГГГ-ММ-ДД/ЧЧММСС-<источник>.md — каждое уведомление сторожа или из Telegram, в момент получения; рядом _diagnostic/*.json — разбор тревоги, по которому заведена карточка; в конец .md сервер сам дописывает блоки «По результатам диагностики» и «Итог по устранению»; archive/ — закрытые сводки; format/svodka-template.md — формат сводки и маркеры тревог (формат не менять). Перед починкой найди в журнале прошлые срабатывания того же источника: как ломалось и как чинилось раньше.",
      "Инструменты: mcp__infra__* — инфрапанель, только чтение: infra_overview (общая картина), infra_services и infra_service (юниты), infra_logs (журналы), infra_health, infra_net и infra_net_probe (сеть, VPN, прокси), infra_dependencies, infra_timeline (что менялось), infra_backups, infra_runbooks (готовые процедуры). taskflow_kb_search — база знаний с рецептами и граблями по этому серверу: ищи там до того, как чинить вслепую. Встроенные bash, read, grep — для systemctl --user, journalctl и конфигов. Итог починки — в отчёт этапа: что сломалось, почему, что сделано, как проверено, что осталось; новый рецепт починки предложи записать в базу знаний.",
    ].join("\n\n");
    const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM roles").get() as { p: number }).p;
    db.prepare("INSERT INTO roles (key, title, summary, enabled, position, prompt) VALUES ('infra_engineer', 'Инженер .110', ?, 1, ?, ?)")
      .run("дежурит по серверу .110: сервисы, сеть, модели, интеграции; чинит поломки из «Состояния системы».", position, prompt);
    if (!db.prepare("SELECT 1 FROM users WHERE id = 'role_infra_engineer'").get()) {
      db.prepare(`INSERT INTO users (id, name, email, password_hash, role, role_key, type, is_system_bot, profile, initials, avatar_color)
        VALUES ('role_infra_engineer', 'Инженер .110', 'infra-engineer@taskflow.local', '!no-login', 'agent', 'infra_engineer', 'ai', 1, 'infra_engineer', 'И', '#8E8E93')`).run();
    }
  } },
  // Секретарь → «Помощник владельца» (владелец 14.10.2026): только видимые
  // имена и тексты; ключи secretary / u-secretary остаются — на них завязаны
  // данные и клиенты.
  { id: "145_secretary_owner_assistant", description: "Переименование роли «Секретарь» в «Помощник владельца»", up: () => {
    const forms: Array<[string, string]> = [
      ["Секретарём", "Помощником владельца"], ["Секретарю", "Помощнику владельца"], ["Секретаря", "Помощника владельца"],
      ["Секретаре", "Помощнике владельца"], ["Секретарь", "Помощник владельца"],
      ["секретарём", "помощником владельца"], ["секретарю", "помощнику владельца"], ["секретаря", "помощника владельца"],
      ["секретаре", "помощнике владельца"], ["секретарь", "помощник владельца"],
    ];
    const rename = (text: string) => forms.reduce((t, [from, to]) => t.split(from).join(to), text);
    db.prepare("UPDATE roles SET title = ? WHERE key = 'secretary'").run("Помощник владельца");
    db.prepare("UPDATE users SET name = ?, initials = ? WHERE id = 'u-secretary'").run("Помощник владельца", "ПВ");
    for (const row of db.prepare("SELECT key, prompt, summary FROM roles WHERE prompt LIKE '%екретар%' OR summary LIKE '%екретар%'").all() as Array<{ key: string; prompt: string | null; summary: string }>) {
      db.prepare("UPDATE roles SET prompt = ?, summary = ? WHERE key = ?").run(row.prompt === null ? null : rename(row.prompt), rename(row.summary), row.key);
    }
    for (const row of db.prepare("SELECT rowid AS id, text FROM role_context_overrides WHERE text LIKE '%екретар%'").all() as Array<{ id: number; text: string }>) {
      db.prepare("UPDATE role_context_overrides SET text = ? WHERE rowid = ?").run(rename(row.text), row.id);
    }
  } },
  // Архив и удаление карточки, пришедшей из Linear, повторяются в Linear
  // (владелец 14.10.2026). Очередь не привязана к карточке: удалённая карточка
  // уносит связь (ON DELETE CASCADE), а задание должно дожить до отправки.
  // Список «не заводить» — удалённое в TaskFlow автоимпорт больше не создаёт.
  { id: "146_linear_lifecycle", description: "Linear: очередь архива/возврата/удаления и список «не заводить»", up: () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linear_lifecycle_queue (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('archive','unarchive','delete')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_linear_lifecycle_pending ON linear_lifecycle_queue(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS linear_import_tombstones (
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(owner_id, workspace_id, source_id)
      );
    `);
  } },

  // Правка 1 плана taskflow-mac-host: машина, на которой выполняется роль.
  //
  // NULL означает «как раньше» — .110. Роль без host_id работает локально, и
  // ничего в существующем поведении не меняется: откат — одна миграция.
  //
  // Таблица одна: «слот» в TaskFlow — это не отдельная таблица, а подзадача с
  // plan_node_key (plan_node_phases/plan_topic_events описывают этапы плана,
  // slot_sessions — сессии агентов). Поэтому назначение машины живёт на
  // подзадаче: это и слот, и шаг в терминах плана.
  //
  // ON DELETE SET NULL: отзыв машины не удаляет чужие строки, но роль не
  // остаётся висеть на несуществующей машине — она получит ошибку словами
  // (roleHost.roleHostError, правка 2).
  { id: "147_role_hosts", description: "Машина исполнения роли: subtasks.host_id", up: () => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info(subtasks)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("host_id")) {
      db.exec("ALTER TABLE subtasks ADD COLUMN host_id TEXT REFERENCES machines(id) ON DELETE SET NULL");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_subtasks_host ON subtasks(host_id)");
  } },
  { id: "148_jev_settings", description: "Оценщик JEV (TypeSafe): подключение и сценарии — отдельная категория, не провайдер моделей ролей", up: () => {
    // Одна строка (id=1): JEV — один на трекер, как и его владелец. Ключ
    // хранится зашифрованным (lib/secretBox.ts), наружу отдаётся только
    // признак «ключ есть». Сценарии — отдельными флагами, по умолчанию
    // выключены: без явного включения ни один путь через JEV не идёт.
    db.exec(`CREATE TABLE IF NOT EXISTS jev_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT NOT NULL DEFAULT 'https://api.typesafe.ai',
      model TEXT NOT NULL DEFAULT 'jev-latest',
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      api_key_enc BLOB,
      plan_profile_enabled INTEGER NOT NULL DEFAULT 0,
      plan_profile_min_confidence REAL NOT NULL DEFAULT 0.6,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec("INSERT OR IGNORE INTO jev_settings (id) VALUES (1)");
  } },
  { id: "149_jev_subtask_roles", description: "JEV: сценарий «роли для подзадач» — своя галочка и порог уверенности", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(jev_settings)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("subtask_role_enabled")) db.exec("ALTER TABLE jev_settings ADD COLUMN subtask_role_enabled INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("subtask_role_min_confidence")) db.exec("ALTER TABLE jev_settings ADD COLUMN subtask_role_min_confidence REAL NOT NULL DEFAULT 0.6");
  } },
  { id: "150_jev_memory_skills", description: "JEV: отбор памяти для роли, проверка записи в память, навыки под задачу — свои галочки", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(jev_settings)").all() as Array<{ name: string }>).map((c) => c.name));
    const add = (name: string, ddl: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE jev_settings ADD COLUMN ${name} ${ddl}`); };
    add("memory_recall_enabled", "INTEGER NOT NULL DEFAULT 0");
    add("memory_recall_min_confidence", "REAL NOT NULL DEFAULT 0.8");
    add("memory_write_enabled", "INTEGER NOT NULL DEFAULT 0");
    add("memory_write_min_confidence", "REAL NOT NULL DEFAULT 0.8");
    add("skills_enabled", "INTEGER NOT NULL DEFAULT 0");
  } },
{id:"151_unified_role_tool_requests",description:"Долговечные запросы единого инструмента ролей",up:()=>{db.exec(TOOL_REQUEST_SCHEMA);}},

  // Карточка 66b0aa5f, этап fix: реализация из карточки 7efcc173
  // (коммит 08958501) перенесена на текущий main. Номер 151 в main уже
  // занят `151_unified_role_tool_requests`, поэтому здесь 152 — иначе два
  // разных миграционных id с одинаковым номером и путаница в журнале.
  { id: "152_step_topic_progress", description: "Дедупликатор сообщений темы задачи о смене состояния шага плана (карточки 7efcc173 и 66b0aa5f, контракт 73bf5e8d)", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS step_topic_progress (
      subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      notice_key TEXT NOT NULL,
      message_id TEXT REFERENCES chat_messages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (subtask_id, notice_key)
    );
  `) },
  { id: "153_role_envelope_json", description: "Структурированный JSON v1 ответа роли в чате", up: () => {
    const columns = new Set((db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("role_envelope_json")) db.exec("ALTER TABLE chat_messages ADD COLUMN role_envelope_json TEXT");
  } },
  { id: "154_collaboration_template_packages", description: "UX-концепция, API-интеграция и аудит: профили командного плана", noTransaction: true, up: () => addTemplateProfiles() },
  { id: "155_worktree_merge_queue", description: "Очередь автослияния веток ролей в main: состояние, SHA до/после, причина отказа (LOCK-WORKTREE-MANAGER-20261019)", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS worktree_merge_queue (
      task_id TEXT PRIMARY KEY,
      trigger TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      main_sha_before TEXT,
      result_sha TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS worktree_merge_queue_state
      ON worktree_merge_queue(state, created_at);
  `) },
  { id: "156_chat_checklist_items", description: "Отметки пунктов checklist-виджета в чате: клиент шлёт состояние, роль читает его операцией taskflow_checklist_state (карточка 21842242)", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS chat_checklist_items (
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      widget_key TEXT NOT NULL,
      item_key TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, widget_key, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_checklist_items_message
      ON chat_checklist_items(message_id);
  `) },
  { id: "157_external_agent_runtime", description: "Внешние агенты как самостоятельные участники: roles.runtime (pi | claude-code | …), участников заводит кнопка «Обновить» (lib/externalAgents.ts)", up: () => {
    const columns = new Set((db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("runtime")) db.exec("ALTER TABLE roles ADD COLUMN runtime TEXT NOT NULL DEFAULT 'pi'");
  } },
  { id: "158_chat_message_model", description: "Модель, выбранная пилюлей в окне ввода чата (на один ход), и модель, на которой внешний агент отработал последним", up: () => {
    const msg = new Set((db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!msg.has("model")) db.exec("ALTER TABLE chat_messages ADD COLUMN model TEXT");
    const roles = new Set((db.prepare("PRAGMA table_info(roles)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!roles.has("last_model")) db.exec("ALTER TABLE roles ADD COLUMN last_model TEXT");
  } },
  // Карточка 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5: учёт ошибок вызовов
  // инструментов ролями. Отказы — строкой в role_tool_audit (без значений
  // аргументов), успешные вызовы — счётчиком в role_tool_audit_counters.
  { id: "159_role_tool_audit", description: "Учёт вызовов инструментов ролями: отказы подробно, успешные — счётчиками", up: () => { db.exec(TOOL_AUDIT_SCHEMA); } },
  // Карточка 64af4c85-93ed-4926-bd78-5cdfaf6a9ba5, доработка 1: в уже
  // записанных отказах провайдер был назван эвристикой — «minimax» для всего,
  // что не anthropic/openai. Модель в ходе приходит как «провайдер/модель»,
  // значит провайдер известен: переписываем метку в старых записях, чтобы
  // выгрузка показывала, у кого истёк ключ. Счётчики не трогаем: их сводка
  // по провайдеру не отдаёт, а переписывание ключа потребовало бы сливать
  // строки.
  { id: "160_role_tool_audit_provider", description: "Провайдер в старых записях учёта — из префикса модели", up: () => {
    for (const provider of KNOWN_MODEL_PROVIDERS) {
      db.prepare(
        "UPDATE role_tool_audit SET provider = ? WHERE model LIKE ? AND (provider IS NULL OR provider <> ?)",
      ).run(provider, `${provider}/%`, provider);
    }
  } },
  // 21.10.2026, раздел «Чаты»: комнаты и сессии (docs/2026-10-21-chats-rooms-and-sessions.md).
  // Назначение комнаты хранится явно: личную комнату и личку роль↔роль раньше
  // угадывали по «первому чату, где ровно эти двое», и поручение Помощника
  // Оркестратору легло в служебную «Передачу принятых изменений».
  { id: "159_chat_room_kind", description: "chats.room_kind: personal (владелец↔роль), dm (роль↔роль), common, wake (Заминки задачи), handoff (Передача принятых изменений); общая комната «Заминки команды» закрыта", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("room_kind")) db.exec("ALTER TABLE chats ADD COLUMN room_kind TEXT CHECK (room_kind IS NULL OR room_kind IN ('personal','dm','common','wake','handoff'))");
    db.exec(`
      UPDATE chats SET room_kind='common' WHERE id='chat-common';
      UPDATE chats SET room_kind='personal' WHERE id='chat-secretary';
      UPDATE chats SET room_kind='handoff' WHERE id LIKE 'integration:%';
      UPDATE chats SET room_kind='wake', closed_at=COALESCE(closed_at, datetime('now')) WHERE id LIKE 'orchestrator-wake:%';
    `);
    const owner = (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1").get() as { id: string } | undefined)?.id;
    const plain = db.prepare(`SELECT c.id FROM chats c WHERE c.room_kind IS NULL AND c.kind='direct'
        AND c.task_id IS NULL AND c.project_id IS NULL AND c.parent_chat_id IS NULL AND c.branch_of_chat_id IS NULL AND c.closed_at IS NULL
        AND (SELECT COUNT(*) FROM chat_members WHERE chat_id=c.id)=2 ORDER BY c.created_at, c.id`).all() as Array<{ id: string }>;
    const seen = new Set<string>();
    for (const row of db.prepare("SELECT id FROM chats WHERE room_kind='personal'").all() as Array<{ id: string }>) {
      for (const m of db.prepare("SELECT member_id FROM chat_members WHERE chat_id=?").all(row.id) as Array<{ member_id: string }>) seen.add("p:" + m.member_id);
    }
    for (const chat of plain) {
      const members = (db.prepare("SELECT u.id, u.type FROM chat_members m JOIN users u ON u.id=m.member_id WHERE m.chat_id=?").all(chat.id) as Array<{ id: string; type: string }>);
      const ai = members.filter((m) => m.type === "ai").map((m) => m.id).sort();
      if (owner && ai.length === 1 && members.some((m) => m.id === owner)) {
        if (seen.has("p:" + ai[0])) continue;
        seen.add("p:" + ai[0]);
        db.prepare("UPDATE chats SET room_kind='personal' WHERE id=?").run(chat.id);
      } else if (ai.length === 2) {
        const key = "d:" + ai.join(":");
        if (seen.has(key)) continue;
        seen.add(key);
        db.prepare("UPDATE chats SET room_kind='dm' WHERE id=?").run(chat.id);
      }
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_chats_room_kind ON chats(room_kind)");
  } },
  // 21.10.2026: у внешних агентов (roles.runtime ≠ pi) постоянной комнаты по
  // умолчанию нет — их переписка с владельцем остаётся обычной сессией, а
  // комнату владелец заводит сам из меню «…».
  { id: "160_external_agent_rooms", description: "Личные комнаты внешних агентов, размеченные миграцией 159, становятся обычными сессиями", up: () => {
    db.exec(`UPDATE chats SET room_kind=NULL WHERE room_kind='personal' AND id IN (
      SELECT m.chat_id FROM chat_members m JOIN users u ON u.id=m.member_id LEFT JOIN roles r ON r.key=u.role_key
       WHERE u.type='ai' AND COALESCE(r.runtime,'pi') <> 'pi')`);
  } },  // 21.10.2026: рабочий чек-лист роли в чате — тот же, что у слота
  // (subtask_work_plans), но на пару «чат + роль», то есть на сессию роли.
  { id: "161_chat_work_plans", description: "chat_work_plans(chat_id, role_id): рабочий чек-лист роли в чатовой сессии", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS chat_work_plans (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, items_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, role_id)
    );`) },
  // 21.10.2026: уборка лишних чатов (карточка 0b7a8b81…): «удалить чат» —
  // это архивирование, а не стирание строк. `closed_at` помечает чат
  // закрытым (уходит из общего списка, новые сообщения не принимаются), но
  // он не различает «тема закрылась вместе с задачей» и «чат убран
  // человеком». `archived_at` — явная отметка уборки: её не снимает
  // возвращение задачи в работу (projectTopics.setTaskTopicClosed), поэтому
  // убранный чат остаётся убранным, а история и счётчики — в базе.
  { id: "162_chat_archive", description: "chats.archived_at: чат убран человеком в архив (строки не стираются)", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("archived_at")) db.exec("ALTER TABLE chats ADD COLUMN archived_at TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chats_archived_at ON chats(archived_at)");
  } },
  { id: "163_context_observability", description: "Журнал вклада энричеров и JEV, расход по ключу", up: () => db.exec(OBSERVABILITY_SCHEMA) },
  { id:"164_one_shot_review_templates",description:"Разовая проверка результата и ревью кода",noTransaction:true,up:()=>addTemplateProfiles(["result_review","code_review"]) },
  { id: "165_task_schedules", description: "Рутины (крон-задачи): task_schedules и schedule_runs", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS task_schedules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task_payload TEXT NOT NULL DEFAULT '{}',
      rule_kind TEXT NOT NULL,
      rule_expr TEXT,
      time_local TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      next_run_at TEXT,
      last_run_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','finished')),
      catch_up INTEGER NOT NULL DEFAULT 1 CHECK(catch_up IN (0,1)),
      overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK(overlap_policy IN ('skip','allow')),
      current_task_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES task_schedules(id) ON DELETE CASCADE,
      run_at TEXT NOT NULL,
      task_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('created','skipped','failed','error')),
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(schedule_id, run_at)
    );
    CREATE INDEX IF NOT EXISTS idx_task_schedules_next_run ON task_schedules(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, run_at DESC);
  `) },
  { id: "166_chat_execution_mode", description: "Выбор В чате / По карточке и снимок режима принятого сообщения", up: () => {
    for (const table of ["chats", "chat_messages"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[];
      if (!cols.some(c => c.name === "execution_mode")) db.exec(`ALTER TABLE ${table} ADD COLUMN execution_mode TEXT CHECK(execution_mode IN ('chat','card'))`);
    }
  } },
  { id: "168_chat_paused_work", description: "Пауза работы роли в личном чате: остановка хода новым сообщением и авто-возврат", up: () => db.exec(`
    CREATE TABLE IF NOT EXISTS chat_paused_work (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      paused_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_owner_at TEXT NOT NULL DEFAULT (datetime('now')),
      resumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_paused_work_open ON chat_paused_work(chat_id, resumed_at);
  `) },
  { id: "169_jev_assistance", description: "JEV: advisory report checks and chat intent", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(jev_settings)").all() as {name:string}[]).map(c=>c.name));
    for (const [name, ddl] of Object.entries({report_review_enabled:"INTEGER NOT NULL DEFAULT 0",chat_intent_enabled:"INTEGER NOT NULL DEFAULT 0",chat_intent_min_confidence:"REAL NOT NULL DEFAULT 0.7"})) {
      if (!cols.has(name)) db.exec(`ALTER TABLE jev_settings ADD COLUMN ${name} ${ddl}`);
    }
  } },
  { id: "181_jev_thought_review", description: "JEV: разбор мыслей роли — непонимание, зацикливание, уход в сторону", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(jev_settings)").all() as {name:string}[]).map(c=>c.name));
    // Включено сразу: владелец 27.10.2026 поручил направление в работу.
    for (const [name, ddl] of Object.entries({thought_review_enabled:"INTEGER NOT NULL DEFAULT 1",thought_review_min_confidence:"REAL NOT NULL DEFAULT 0.7"})) {
      if (!cols.has(name)) db.exec(`ALTER TABLE jev_settings ADD COLUMN ${name} ${ddl}`);
    }
  } },
  { id: "167_role_tool_gain_requests", description: "Заявки ролей на закрытые инструменты", up: () => db.exec(ROLE_TOOL_REQUEST_SCHEMA) },
  {
    // 24.10.2026 (аудит качества данных): каноническая учётка роли —
    // `role_<key>` — создавалась только через POST /api/roles (routes/roles.ts)
    // и миграцией 144 для одной роли. Миграции, заводящие САМИ роли (056),
    // строки в users НЕ писали.
    //
    // Что из этого следует: на свежей БД (или на восстановленной из бэкапа,
    // где таблица roles есть, а учёток нет) любое обращение роли к данным
    // падало «FOREIGN KEY constraint failed» — chat_sessions.role_id,
    // subtasks.assignee_id и другие колонки ссылаются на users(id).
    // Это же объясняло 42 падения в тестах: тестовая БД поднимается
    // миграциями с нуля, а канонических учёток там не было.
    //
    // Что делает миграция: для каждой роли из таблицы roles, у которой нет
    // учётки `role_<key>`, заводит её. Условия триггеров users_role_key_*_guard
    // (миграция 058) соблюдены: type='ai', role='agent', is_system_bot=1,
    // id = 'role_' || key, ключ роли есть в roles.
    //
    // Учётка не может логиниться: password_hash='!no-login' — тот же
    // маркер, что у ролей, заведённых через API.
    id: "170_role_accounts_for_all_roles",
    description:
      "Канонические учётки role_<key> для всех ролей из roles: без них роль не может работать на свежей БД (FOREIGN KEY)",
    up: () => {
      const роли = db
        .prepare("SELECT key, title FROM roles ORDER BY position, key")
        .all() as Array<{ key: string; title: string }>;
      for (const роль of роли) {
        const id = `role_${роль.key}`;
        // Помощник владельца живёт под учёткой u-secretary — это
        // историческое исключение из правила «учётка роли = role_<key>»
        // (см. roleUserId в roleRouting.ts). У него уже есть role_key,
        // поэтому отдельная учётка ему не нужна и невозможна: users.role_key
        // уникален (миграция 058).
        if (роль.key === "secretary") continue;
        const есть = db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
        if (есть) continue;
        const естьПоКлючу = db
          .prepare("SELECT 1 FROM users WHERE role_key = ?")
          .get(роль.key);
        if (естьПоКлючу) continue;
        const initials = (роль.title || роль.key).trim().slice(0, 1).toUpperCase() || "Р";
        db.prepare(
          `INSERT INTO users
             (id, name, email, password_hash, role, role_key, type, is_system_bot,
              profile, initials, avatar_color, status)
           VALUES (?, ?, ?, '!no-login', 'agent', ?, 'ai', 1, ?, ?, '#8E8E93', 'offline')`,
        ).run(
          id,
          роль.title || роль.key,
          `${роль.key.replace(/_/g, "-")}@taskflow.local`,
          роль.key,
          роль.key,
          initials,
        );
      }
    },
  },

  {
    id: "171_instruction_manifests_store",
    description:
      "Справочник манифестов инструкций: событие instruction_snapshot хранит ссылку, а не полный манифест (48 МБ → ~1 МБ), плюс перенос уже накопленных событий",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS instruction_manifests (
          sha256 TEXT PRIMARY KEY,
          manifest TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Перенос уже накопленных событий: манифест из to_value уезжает в
      // справочник (один раз на уникальное содержимое), в событии остаётся
      // ссылка. Аудит сохраняется — манифест восстанавливается по ссылке.
      //
      // События без манифеста (или с неразбираемым JSON) не трогаем: их
      // читает briefInstructionSnapshot, и он продолжает видеть mode/resumed.
      const строки = db
        .prepare(
          `SELECT id, to_value FROM task_events
            WHERE kind = 'instruction_snapshot' AND to_value LIKE '%manifest%'`,
        )
        .all() as Array<{ id: string; to_value: string }>;
      const вставить = db.prepare(
        `INSERT INTO instruction_manifests (sha256, manifest, created_at)
         VALUES (?, ?, datetime('now')) ON CONFLICT(sha256) DO NOTHING`,
      );
      const обновить = db.prepare(
        `UPDATE task_events SET to_value = ? WHERE id = ?`,
      );
      let перенесено = 0;
      for (const с of строки) {
        let parsed: any;
        try {
          parsed = JSON.parse(с.to_value);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || !("manifest" in parsed)) continue;
        const манифест = parsed.manifest;
        if (манифест === undefined || манифест === null) continue;
        const json = JSON.stringify(манифест);
        const sha = crypto.createHash("sha256").update(json).digest("hex");
        вставить.run(sha, json);
        // Форма события: mode, resumed и ссылка. Потребитель
        // briefInstructionSnapshot читает только mode/resumed — он работает
        // без изменений.
        обновить.run(
          JSON.stringify({
            mode: parsed.mode ?? null,
            resumed: parsed.resumed ?? null,
            manifest_sha256: sha,
          }),
          с.id,
        );
        перенесено += 1;
      }
      if (перенесено > 0) {
        console.log(
          `171_instruction_manifests_store: перенесено событий instruction_snapshot — ${перенесено}`,
        );
      }
    },
  },

  {
    id: "172_chat_messages_indexes",
    description:
      "Индексы chat_messages, потерянные при пересборке таблицы в миграции 133 (DROP TABLE убивает индексы вместе с таблицей)",
    up: () => {
      // Миграция 133 пересобирает chat_messages (нужен новый CHECK на kind):
      //   CREATE TABLE chat_messages_new → INSERT → DROP TABLE chat_messages
      //   → RENAME chat_messages_new TO chat_messages
      // DROP TABLE удаляет и индексы таблицы, а восстановить 133 взяла
      // только один (idx_chat_messages_rule_ref). Остальные четыре
      // (to / task / channel / chat) исчезли — на них стоят выборки лент
      // чатов и истории задачи: без них SQLite делал полный скан таблицы.
      //
      // Здесь восстанавливаем их. Определения — из миграции 012/019/020,
      // где они создавались (см. git show 916c0c00:server/src/migrations.ts).
      //
      // CREATE INDEX IF NOT EXISTS — идемпотентно: и на БД, где индексы
      // ещё живы, и на той, где их уже нет.
      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      const создать = (имя: string, sql: string) => {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(имя)) {
          return;
        }
        db.exec(sql);
      };
      if (cols.has("to_user_id") && cols.has("created_at")) {
        создать(
          "idx_chat_messages_to",
          "CREATE INDEX IF NOT EXISTS idx_chat_messages_to ON chat_messages(to_user_id, created_at)",
        );
      }
      if (cols.has("task_id")) {
        создать(
          "idx_chat_messages_task",
          "CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(task_id)",
        );
      }
      if (cols.has("channel") && cols.has("created_at")) {
        создать(
          "idx_chat_messages_channel",
          "CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel, created_at)",
        );
      }
      if (cols.has("chat_id") && cols.has("created_at")) {
        создать(
          "idx_chat_messages_chat",
          "CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, created_at)",
        );
      }
    },
  },
  {
    id: "173_chat_messages_stop_markers",
    description:
      "Признаки прерванного ответа в чате: chat_messages.stop_reason (почему ответ прерван) " +
      "и chat_messages.partial (ответ сохранён частично). Колонки аддитивные, CHECK не расширяем: " +
      "набор message_type остаётся прежним (системное сообщение / предложение задачи).",
    up: () => {
      const cols = new Set(
        (db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!cols.has("stop_reason")) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN stop_reason TEXT");
      }
      if (!cols.has("partial")) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN partial INTEGER NOT NULL DEFAULT 0");
      }
      // Поколение, которому принадлежит сохранённая сессия Pi. Поколение
      // уехало (прерывание, /new-session) — значит файл сессии больше не
      // источник правды: следующий ход идёт в свежую сессию с выжимкой.
      const sessionCols = new Set(
        (db.prepare("PRAGMA table_info(chat_sessions)").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (!sessionCols.has("generation")) {
        db.exec("ALTER TABLE chat_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    id: "174_chat_checkpoints",
    description:
      "Выжимка чата: chat_checkpoints(chat_id, role_id, generation, sections_json) — " +
      "трёхсекционная выжимка (что было / цель и задача / что выполнить) для свежего хода " +
      "после прерывания. PRIMARY KEY (chat_id, role_id, generation) — на поколение одна выжимка.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_checkpoints (
          chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          sections_json TEXT NOT NULL,
          source_run_id TEXT,
          source_leaf_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, role_id, generation)
        );
      `);
    },
  },

  // 25.10.2026, карточка b504958a (контракт note://115ba2ac-6a1d-45ac-a92f-2081c6ecf0c2):
  // чатовый чек-лист перестаёт быть подсказкой модели. `items_json` остаётся
  // тем, что пишет роль (порядок и названия), а состояние пунктов и самого
  // плана хранит сервер в `outcomes_json` и `status`. Только ADD COLUMN:
  // таблицу не пересобираем и CHECK не добавляем (старые строки читаются как
  // активный план без сдач).
  {
    id: "175_task_discussions",
    description:
      "Обсуждение работающей карточки: task_discussions (состояние open/closing/closed, " +
      "снимок рабочего контекста, итог закрытия, handoff_id, состояние доставки) и " +
      "task_discussion_handoffs (handoff на версию закрытия, получатель, квитанция). " +
      "Колонки аддитивные, CHECK на enum задаёт только допустимые состояния.",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_discussions (
          discussion_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL,
          role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closing','closed')),
          source_run_id TEXT,
          source_leaf_id TEXT,
          source_revision TEXT,
          summary_id TEXT,
          summary_sections_json TEXT,
          handoff_id TEXT,
          delivery_state TEXT NOT NULL DEFAULT 'not_ready'
            CHECK (delivery_state IN ('not_ready','awaiting','delivered','failed','no_recipient')),
          accepted_at TEXT,
          accepted_by TEXT,
          receipt_message_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_task_discussions_task ON task_discussions(task_id);
        CREATE TABLE IF NOT EXISTS task_discussion_handoffs (
          handoff_id TEXT PRIMARY KEY,
          discussion_id TEXT NOT NULL REFERENCES task_discussions(discussion_id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          recipient_subtask_id TEXT REFERENCES subtasks(id) ON DELETE SET NULL,
          recipient_role_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'awaiting'
            CHECK (state IN ('awaiting','delivered','failed','no_recipient')),
          payload_json TEXT NOT NULL,
          receipt_message_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          delivered_at TEXT,
          UNIQUE (discussion_id, version)
        );
      `);
    },
  },
  {
    id: "176_chat_work_plan_outcomes",
    description:
      "chat_work_plans: серверное состояние плана (status/stop_reason/stopped_at) и записи сдачи пунктов (outcomes_json)",
    up: () => {
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(chat_work_plans)").all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      const колонка = (имя: string, sql: string) => {
        if (!cols.has(имя)) db.exec(`ALTER TABLE chat_work_plans ADD COLUMN ${sql}`);
      };
      колонка("status", "status TEXT NOT NULL DEFAULT 'active'");
      колонка("stop_reason", "stop_reason TEXT");
      колонка("stopped_at", "stopped_at TEXT");
      колонка("source_message_id", "source_message_id TEXT");
      колонка("outcomes_json", "outcomes_json TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    id: "177_chat_checkpoint_transfers",
    description: "Durable checkpoint transfer across rooms and restarts",
    up: () => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_checkpoint_transfers(
        root_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        transfer_id TEXT NOT NULL,
        PRIMARY KEY(root_chat_id,role_id)
      )`);
    },
  },
  {
    id: "178_chat_item_action_budget",
    description: "Durable action accounting per checklist item",
    up: () => {
      const columns=db.prepare("PRAGMA table_info(chat_work_plans)").all() as Array<{name:string}>;
      if(!columns.some(column=>column.name==="action_budget_json"))
        db.exec("ALTER TABLE chat_work_plans ADD COLUMN action_budget_json TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {id:"179_chat_budget_cases",description:"Private manual review packets for 100+50 chat actions",up:()=>{db.exec(BUDGET_CASE_SCHEMA);}},
  {
    id: "180_chat_questions",
    description: "Уточнение роли у владельца из чата: вопросы роли, их статус и ответ владельца",
    up: () => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_questions(
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        message_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        answer_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        deadline_at TEXT,
        answered_at TEXT
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_questions_chat_created
        ON chat_questions(chat_id, created_at DESC)`);
    },
  },
  {
    id: "181_secretary_progress_narration",
    description: "Помощник владельца: пояснение владельцу раз в 5–7 шагов",
    up: () => {
      db.prepare("UPDATE roles SET prompt=COALESCE(prompt,'') || ? WHERE key='secretary' AND instr(COALESCE(prompt,''),'## Пояснения владельцу по ходу работы')=0").run("\n\n## Пояснения владельцу по ходу работы\nПока работаешь, примерно раз в 5–7 шагов (вызовов инструментов) пиши владельцу обычным текстом между вызовами одно короткое предложение по-человечески: что сейчас делаешь и зачем. Ровно одно предложение, без списков и технических подробностей.\n");
    },
  },
  // Рабочая папка чата (владелец 27.10.2026): имя папки из ~/Проекты/*,
  // NULL — ход идёт в домашней папке роли, как раньше.
  { id: "182_chat_workspace", description: "chats.workspace: рабочая папка хода роли в чате", up: () => {
    const cols = new Set((db.prepare("PRAGMA table_info(chats)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("workspace")) db.exec("ALTER TABLE chats ADD COLUMN workspace TEXT");
  } },

];
/**
 * Опции прогона миграций.
 *
 * Нужны ровно для одного сценария: тест хочет поднять БД до определённой
 * точки (например, «как есть сразу после 036, но ДО 037»), посеять
 * pre-037 строки и проверить, как обычный runMigrations() потом дотягивает
 * БД с этой точки. Без опции (или без поля `through`) поведение
 * byte-for-byte идентично старому — прогоняется всё подряд.
 */
export interface RunMigrationsOptions {
  /**
   * Реальный id миграции (как в `Migration.id`, например
   * "036_agent_execution_connection"). Прогон останавливается после
   * применения этой миграции включительно. Последующие миграции не
   * выполняются. Если id не найден в списке — бросаем Error, чтобы
   * опечатка не прошла как «прогнали всё».
   */
  through?: string;
}

/** Apply all still-unapplied migrations, one transaction per migration. */
export function runMigrations(options?: RunMigrationsOptions): void {
  try {
    runMigrationsInner(options);
  } finally {
    // Состав ролей живёт в таблице roles — после миграций перечитать.
    refreshRoles();
  }
}

function runMigrationsInner(options?: RunMigrationsOptions): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as Array<{
        id: string;
      }>
    ).map((r) => r.id),
  );

  const record = (m: Migration) =>
    db
      .prepare("INSERT INTO schema_migrations (id, description) VALUES (?, ?)")
      .run(m.id, m.description);

  // Если задан `through` — находим индекс этой миграции в массиве. После
  // её применения (включительно) цикл прерывается. -1 означает «не
  // задан» и цикл идёт до конца, как раньше.
  const throughId = options?.through;
  const stopIndex =
    throughId === undefined
      ? -1
      : (() => {
          const idx = migrations.findIndex((m) => m.id === throughId);
          if (idx === -1) {
            throw new Error(
              `runMigrations: через through="${throughId}" — такой миграции нет в списке`,
            );
          }
          return idx;
        })();

  for (let i = 0; i < migrations.length; i++) {
    if (stopIndex >= 0 && i > stopIndex) break;
    const m = migrations[i];
    if (applied.has(m.id)) continue;
    if (m.noTransaction) {
      // Транзакцию такая миграция держит внутри себя — см. Migration.noTransaction.
      m.up();
      record(m);
      continue;
    }
    const txn = db.transaction(() => {
      m.up();
      record(m);
    });
    txn();
  }
}
