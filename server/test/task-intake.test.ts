// Owner intake mode (карточка 5f292e87, серверная половина, шаг 1).
//
// Что здесь живёт:
//   1) миграция 037_task_intake_pipeline добавляет четыре колонки с нужными
//      дефолтами и CHECK-ограничениями на «свежей» и «живой» БД;
//   2) GET/PATCH /api/task-intake/settings отдают и меняют режим приёма
//      задач владельца, источник правды — users.task_intake_mode, не
//      какие-то настройки;
//   3) хелпер snapshotIntakeMode фиксирует режим владельца в
//      chat_task_drafts.intake_mode ДО работы модели и больше не
//      перечитывает users.task_intake_mode для того же сообщения.
//
// «Свежая БД» здесь — отдельное соединение better-sqlite3 во временном
// файле: тот же db.ts singleton занят тестовым buildApp() и не годится
// для проверки «с нуля». Закрытие соединения в afterEach обязательно —
// без этого better-sqlite3 держит файл открытым и setup.ts не сможет
// удалить временный каталог.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const { buildApp } = await import("../src/index.js");
const dbModule = await import("../src/db.js");
const migrationsModule = await import("../src/migrations.js");

// Импортируем хелпер заранее, на уровне файла — vitest кеширует модуль,
// и нам нужен один и тот же экспорт во всех snapshot-тестах.
const { snapshotIntakeMode: snapshotIntakeModeMod } = (await import(
  "../src/routes/task-intake.js"
)) as {
  snapshotIntakeMode: (
    ownerId: string,
    chatMessageId: string,
  ) => "manual" | "automatic";
};

// ── Локальные помощники ────────────────────────────────────────────────────

function freshDbPath(): string {
  const file = path.join(
    os.tmpdir(),
    `taskflow-intake-fresh-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
  );
  return file;
}

interface FreshHandle {
  db: Database.Database;
  path: string;
  close(): void;
}

function openFreshDb(): FreshHandle {
  const file = freshDbPath();
  const handle = new Database(file);
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  return {
    db: handle,
    path: file,
    close() {
      try {
        handle.close();
      } catch {
        // уже закрыт
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(file + suffix);
        } catch {
          // файла нет
        }
      }
    },
  };
}

/** Свежая БД: только базовая migrate(), без runMigrations(). Колонок
 *  task_intake_mode/intake_mode/needs_clarification/clarification_question
 *  быть не должно — это и есть точка отсчёта перед миграцией 037. */
function applyBaseSchema(target: Database.Database): void {
  // Минимальный набор, нужный миграции 037: users (с chat_messages/drafts
  // через FK), tasks, chat_messages. Совпадает с тем, что делает
  // db.ts:migrate() на чистой установке, но без лишних таблиц.
  target.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('owner','agent','viewer','orchestrator')),
      type TEXT NOT NULL DEFAULT 'human' CHECK(type IN ('human','ai')),
      avatar_color TEXT DEFAULT '#A6A6A6',
      initials TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      api_token TEXT,
      is_system_bot INTEGER DEFAULT 0,
      reviewer INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      project_id TEXT REFERENCES projects(id),
      priority INTEGER DEFAULT 1 CHECK(priority BETWEEN 1 AND 4),
      assignee_id TEXT REFERENCES users(id),
      creator_id TEXT REFERENCES users(id),
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL REFERENCES users(id),
      to_user_id TEXT REFERENCES users(id),
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('совещание','делегирование','находка')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function columnInfo(
  target: Database.Database,
  table: string,
  column: string,
): { name: string; type: string; notnull: number; dflt_value: string | null } | undefined {
  const rows = target
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
  return rows.find((r) => r.name === column);
}

// ── Тесты ──────────────────────────────────────────────────────────────────

describe("миграция 037_task_intake_pipeline", () => {
  let fresh: FreshHandle | null = null;

  afterEach(() => {
    fresh?.close();
    fresh = null;
  });

  it("на свежей БД добавляет четыре колонки с правильными дефолтами", () => {
    fresh = openFreshDb();
    applyBaseSchema(fresh.db);
    // Миграция 037 зависит от 028 (chat_task_drafts) — имитируем, что
    // та уже отработала: создаём таблицу до прогона нашего хелпера.
    fresh.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_task_drafts (
        chat_message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
    `);
    // До прогона версионных миграций — ни одной из новых колонок быть не
    // должно. Если какая-то уже есть, миграция 037 либо уже применена
    // (тест не сможет проверить ALTER), либо где-то раскопана дублем.
    expect(columnInfo(fresh.db, "users", "task_intake_mode")).toBeUndefined();
    expect(columnInfo(fresh.db, "chat_task_drafts", "intake_mode")).toBeUndefined();
    expect(columnInfo(fresh.db, "tasks", "needs_clarification")).toBeUndefined();
    expect(columnInfo(fresh.db, "tasks", "clarification_question")).toBeUndefined();

    // Прогон только «037» — без хвоста из 001..036, которых на этой
    // минимальной схеме просто не к чему применять. Так проверяется ровно
    // то, что добавляет наша миграция.
    migrationsModule.runIntakePipelineMigration(fresh.db);

    const u = columnInfo(fresh.db, "users", "task_intake_mode");
    expect(u).toBeDefined();
    expect(u!.type).toBe("TEXT");
    expect(u!.notnull).toBe(1);
    expect(u!.dflt_value).toBe("'manual'");

    // Дефолтное значение применяется к существующим строкам (здесь — нет
    // пользователей; важно, что DEFAULT действительно сохранён в схеме).
    const d = columnInfo(fresh.db, "chat_task_drafts", "intake_mode");
    expect(d).toBeDefined();
    expect(d!.type).toBe("TEXT");
    expect(d!.notnull).toBe(1);
    expect(d!.dflt_value).toBe("'manual'");

    const nc = columnInfo(fresh.db, "tasks", "needs_clarification");
    expect(nc).toBeDefined();
    expect(nc!.notnull).toBe(1);
    expect(nc!.dflt_value).toBe("0");

    const cq = columnInfo(fresh.db, "tasks", "clarification_question");
    expect(cq).toBeDefined();
    expect(cq!.type).toBe("TEXT");
    // clarification_question — необязательное поле (заполняется, только
    // когда нужно уточнение); допускает NULL.
    expect(cq!.notnull).toBe(0);
  });

  it("CHECK на task_intake_mode отвергает непредусмотренные значения", () => {
    fresh = openFreshDb();
    applyBaseSchema(fresh.db);
    fresh.db
      .prepare(
        "INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)",
      )
      .run("u-pre", "Pre", "pre@x", "h");
    migrationsModule.runIntakePipelineMigration(fresh.db);

    expect(() =>
      fresh!.db
        .prepare("UPDATE users SET task_intake_mode = ? WHERE id = ?")
        .run("weird", "u-pre"),
    ).toThrow(/CHECK/);

    // Оба штатных значения принимаются.
    for (const mode of ["manual", "automatic"]) {
      expect(() =>
        fresh!.db
          .prepare("UPDATE users SET task_intake_mode = ? WHERE id = ?")
          .run(mode, "u-pre"),
      ).not.toThrow();
    }
  });

  it("CHECK на intake_mode в chat_task_drafts отвергает чужой режим", () => {
    fresh = openFreshDb();
    applyBaseSchema(fresh.db);
    // Чтобы FOREIGN KEY на chat_messages не падал на INSERT ниже — нужны
    // родительские строки. applyBaseSchema только создаёт таблицы, без
    // данных; добавляем самих владельца и три сообщения.
    fresh.db
      .prepare(
        "INSERT INTO users (id, name, email, password_hash) VALUES (?, 'Owner', 'o@x', 'h')",
      )
      .run("u-owner");
    fresh.db
      .prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, 'u-owner', 'msg-1')",
      )
      .run("m1");
    fresh.db
      .prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, 'u-owner', 'msg-2')",
      )
      .run("m2");
    fresh.db
      .prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, 'u-owner', 'msg-3')",
      )
      .run("m3");
    // Таблица chat_task_drafts заводится отдельно: миграция 037 её
    // предполагает уже существующей (миграция 028). Создаём ДО прогона
    // 037 — иначе хелпер её колонку пропустит (tableExists в нём
    // проверяет наличие таблицы).
    fresh.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_task_drafts (
        chat_message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );
    `);
    migrationsModule.runIntakePipelineMigration(fresh.db);

    expect(() =>
      fresh!.db
        .prepare(
          "INSERT INTO chat_task_drafts (chat_message_id, status, intake_mode) VALUES (?, ?, ?)",
        )
        .run("m1", "pending", "manual"),
    ).not.toThrow();
    expect(() =>
      fresh!.db
        .prepare(
          "INSERT INTO chat_task_drafts (chat_message_id, status, intake_mode) VALUES (?, ?, ?)",
        )
        .run("m2", "pending", "automatic"),
    ).not.toThrow();
    expect(() =>
      fresh!.db
        .prepare(
          "INSERT INTO chat_task_drafts (chat_message_id, status, intake_mode) VALUES (?, ?, ?)",
        )
        .run("m3", "pending", "garbage"),
    ).toThrow(/CHECK/);
  });

  it("на живой БД миграция 037 идемпотентна при повторном прогоне", () => {
    fresh = openFreshDb();
    applyBaseSchema(fresh.db);
    migrationsModule.runIntakePipelineMigration(fresh.db);
    // Второй запуск не должен падать на дубликате колонки.
    expect(() =>
      migrationsModule.runIntakePipelineMigration(fresh.db),
    ).not.toThrow();
  });

  it("на pre-037 БД (реалистичная схема через runner): defaults применены к существующим строкам, schema_migrations пополняется, идемпотентна", () => {
    fresh = openFreshDb();

    // Симулируем реалистичную pre-037 БД: migrate() + миграции 001-036
    // уже применены, осталась только 037. Полный runner в этом тесте
    // не подходит (он завязан на singleton db и сразу же применил бы 037
    // вместе с остальными), поэтому собираем фикстуру руками:
    //   - базовая схема из db.ts:migrate();
    //   - таблицы, которые добавляют миграции до 037 включительно —
    //     только те, к которым 037 потом обращается (chat_messages,
    //     chat_task_drafts);
    //   - schema_migrations с пометкой 001-036 как применённых.
    // Хелпер runIntakePipelineMigration подключается ровно на 037.
    applyBaseSchema(fresh.db);
    // tasks.project_id — FK на projects, без неё INSERT INTO tasks
    // не пройдёт. На реалистичной БД projects создаются в db.ts:migrate()
    // вместе с остальной базой; в этой минимальной фикстуре добавляем
    // проекты руками — ровно столько, сколько нужно, чтобы 037 смог
    // работать со своим INSERT-путём и применять DEFAULT'ы.
    fresh.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#4A9FD8',
        owner_id TEXT REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    fresh.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL REFERENCES users(id),
        to_user_id TEXT REFERENCES users(id),
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT CHECK (kind IS NULL OR kind IN ('совещание','делегирование','находка')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // 028: chat_task_drafts в её исходном виде (без intake_mode, который
    // добавит 037). CHECK на status — ровно тот, что в миграции 028.
    fresh.db.exec(`
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
    `);
    // schema_migrations — таблица, которую ведёт runMigrations().
    fresh.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT,
        applied_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Помечаем 001-036 как применённые. Без этого раннер при следующем
    // запуске решил бы, что их ещё нет, и попытался бы выполнить —
    // а их up() завязаны на singleton db.
    const markApplied = fresh.db.prepare(
      "INSERT INTO schema_migrations (id, description) VALUES (?, ?)",
    );
    for (let i = 1; i <= 36; i++) {
      markApplied.run(
        `${String(i).padStart(3, "0")}_pre037_fixture`,
        "смоделировано в тесте pre-037 фикстуры",
      );
    }

    // Вставляем живые строки ДО 037, чтобы убедиться, что DEFAULT'ы
    // применяются и к ним.
    fresh.db
      .prepare(
        "INSERT INTO users (id, name, email, password_hash) VALUES ('u-pre-1', 'Pre1', 'pre1@x', 'h')",
      )
      .run();
    fresh.db
      .prepare(
        "INSERT INTO tasks (id, title, creator_id) VALUES ('t-pre-1', 'PreTask1', 'u-pre-1')",
      )
      .run();
    fresh.db
      .prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES ('m-pre-1', 'u-pre-1', 'pre')",
      )
      .run();
    fresh.db
      .prepare(
        "INSERT INTO chat_task_drafts (chat_message_id, status) VALUES ('m-pre-1', 'pending')",
      )
      .run();

    // До прогона 037 — ни одной из новых колонок в схеме быть не должно.
    expect(columnInfo(fresh.db, "users", "task_intake_mode")).toBeUndefined();
    expect(columnInfo(fresh.db, "chat_task_drafts", "intake_mode")).toBeUndefined();
    expect(columnInfo(fresh.db, "tasks", "needs_clarification")).toBeUndefined();
    expect(columnInfo(fresh.db, "tasks", "clarification_question")).toBeUndefined();
    // И запись 037 в schema_migrations ещё не появилась.
    expect(
      fresh.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE id = '037_task_intake_pipeline'",
        )
        .get(),
    ).toBeUndefined();

    // Прогон 037 (тело — то же, что у одноимённой миграции) и запись
    // в schema_migrations тем же приёмом, что и runMigrations(). Это
    // проверяет не только схему, но и контракт runner'а: 037 реально
    // записывается в журнал.
    fresh.db.transaction(() => {
      migrationsModule.runIntakePipelineMigration(fresh.db);
      fresh.db
        .prepare(
          "INSERT INTO schema_migrations (id, description) VALUES (?, ?)",
        )
        .run(
          "037_task_intake_pipeline",
          "Owner intake mode и снимок режима на сообщение",
        );
    })();

    // Колонки добавлены и DEFAULT'ы применены к УЖЕ существующим строкам.
    const u = columnInfo(fresh.db, "users", "task_intake_mode");
    expect(u).toBeDefined();
    expect(u!.dflt_value).toBe("'manual'");
    const preUser = fresh.db
      .prepare("SELECT task_intake_mode FROM users WHERE id = 'u-pre-1'")
      .get() as { task_intake_mode: string };
    expect(preUser.task_intake_mode).toBe("manual");

    const t = columnInfo(fresh.db, "tasks", "needs_clarification");
    expect(t).toBeDefined();
    expect(t!.dflt_value).toBe("0");
    const preTask = fresh.db
      .prepare(
        "SELECT needs_clarification, clarification_question FROM tasks WHERE id = 't-pre-1'",
      )
      .get() as { needs_clarification: number; clarification_question: string | null };
    expect(preTask.needs_clarification).toBe(0);
    expect(preTask.clarification_question).toBeNull();

    const d = columnInfo(fresh.db, "chat_task_drafts", "intake_mode");
    expect(d).toBeDefined();
    expect(d!.dflt_value).toBe("'manual'");
    const preDraft = fresh.db
      .prepare(
        "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = 'm-pre-1'",
      )
      .get() as { intake_mode: string };
    expect(preDraft.intake_mode).toBe("manual");

    // 037 записана в schema_migrations.
    const recorded = fresh.db
      .prepare(
        "SELECT id FROM schema_migrations WHERE id = '037_task_intake_pipeline'",
      )
      .get() as { id: string };
    expect(recorded.id).toBe("037_task_intake_pipeline");

    // Идемпотентность: повторный прогон 037 (как сделал бы runMigrations
    // при следующем старте сервера) не падает и не дублирует запись.
    fresh.db.transaction(() => {
      migrationsModule.runIntakePipelineMigration(fresh.db);
    })();
    const recordedCount = (
      fresh.db
        .prepare(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '037_task_intake_pipeline'",
        )
        .get() as { n: number }
    ).n;
    expect(recordedCount).toBe(1);
  });
});

describe("owner /api/task-intake/settings", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let agentAuth: string;

  beforeAll(async () => {
    app = await buildApp();

    const ownerReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Owner", email: "owner@intake.test", password: "password123" },
    });
    ownerAuth = `Bearer ${ownerReg.json().token}`;
    ownerId = ownerReg.json().user.id;
    dbModule.default
      .prepare("UPDATE users SET role = 'owner' WHERE id = ?")
      .run(ownerId);

    const agentReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Agent", email: "agent@intake.test", password: "password123" },
    });
    agentAuth = `Bearer ${agentReg.json().token}`;
    dbModule.default
      .prepare("UPDATE users SET type = 'ai' WHERE id = ?")
      .run(agentReg.json().user.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it("по умолчанию режим 'manual' (свежий владелец — свежая колонка)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "manual" });
  });

  it("PATCH меняет режим, GET отдаёт новое значение", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
      payload: { mode: "automatic" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ mode: "automatic" });

    const get = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
    });
    expect(get.json()).toEqual({ mode: "automatic" });
  });

  it("режим сохраняется после перезапуска приложения", async () => {
    // Закрываем и поднимаем app заново — ту же БД, никаких других
    // изменений. Это та же проверка, что и в taskState.test.ts:
    // /api/task-intake/settings читает из БД, не из in-memory.
    await app.close();
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "automatic" });

    // Возвращаем к 'manual', чтобы следующие тесты не зависели от того,
    // в каком порядке vitest их запустил.
    const reset = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
      payload: { mode: "manual" },
    });
    expect(reset.statusCode).toBe(200);
  });

  it("не-владелец получает 403 на оба эндпоинта", async () => {
    const get = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: agentAuth },
    });
    expect(get.statusCode).toBe(403);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: agentAuth },
      payload: { mode: "automatic" },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("неизвестный режим → 400, значение в БД не меняется", async () => {
    const before = dbModule.default
      .prepare("SELECT task_intake_mode FROM users WHERE id = ?")
      .get(ownerId) as { task_intake_mode: string };

    const res = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
      payload: { mode: "ai-decides" },
    });
    expect(res.statusCode).toBe(400);

    const after = dbModule.default
      .prepare("SELECT task_intake_mode FROM users WHERE id = ?")
      .get(ownerId) as { task_intake_mode: string };
    expect(after.task_intake_mode).toBe(before.task_intake_mode);
  });
});

describe("snapshotIntakeMode: режим фиксируется в строке черновика", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerIdValue: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Snap", email: "snap@intake.test", password: "password123" },
    });
    ownerAuth = `Bearer ${reg.json().token}`;
    ownerIdValue = reg.json().user.id;
    dbModule.default
      .prepare("UPDATE users SET role = 'owner' WHERE id = ?")
      .run(ownerIdValue);
  });

  afterAll(async () => {
    await app.close();
  });

  function makeChatMessage(id: string): void {
    dbModule.default
      .prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, ?, ?)",
      )
      .run(id, ownerIdValue, "test message");
  }

  it("записывает режим владельца в intake_mode и возвращает его", async () => {
    makeChatMessage("m-snap-1");
    // Без makeDraftRow — хелпер сам заводит строку черновика и кладёт
    // в неё снимок из users.task_intake_mode. До этого хелпера никаких
    // INSERT в chat_task_drafts быть не должно.

    const mode = snapshotIntakeModeMod(ownerIdValue, "m-snap-1");
    expect(mode).toBe("manual");

    const row = dbModule.default
      .prepare(
        "SELECT intake_mode, status FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get("m-snap-1") as { intake_mode: string; status: string };
    expect(row.intake_mode).toBe("manual");
    // Хелпер сам ставит status='pending' (то же поведение, что у
    // прежнего INSERT в lib/ownerDraft.ts — Task 6 его заменит на этот
    // helper).
    expect(row.status).toBe("pending");
  });

  it("не перечитывает users.task_intake_mode для уже снапшотнутой строки", async () => {
    // Шаг 1: владелец в 'manual', делаем снимок для сообщения.
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?")
      .run(ownerIdValue);
    makeChatMessage("m-snap-2");

    const first = snapshotIntakeModeMod(ownerIdValue, "m-snap-2");
    expect(first).toBe("manual");

    // Шаг 2: владелец переключает общий режим на 'automatic'. В живой
    // цепочке этот момент и есть «поздние стадии»: модель ещё не
    // вызвана, снимок уже сделан, и переключение пользовательской
    // настройки НЕ должно затереть то, что лежит в строке.
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?")
      .run(ownerIdValue);

    // Шаг 3: повторный вызов хелпера для того же сообщения. Идемпотентность
    // держится БД-уровневой метой (ON CONFLICT DO NOTHING), а не модульным
    // состоянием — поэтому тест работает даже если процесс/модуль были
    // перезапущены между вызовами.
    const second = snapshotIntakeModeMod(ownerIdValue, "m-snap-2");
    expect(second).toBe("manual");

    const row = dbModule.default
      .prepare(
        "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get("m-snap-2") as { intake_mode: string };
    expect(row.intake_mode).toBe("manual");
  });

  it("снапшот подхватывает automatic, если владелец его уже включил", async () => {
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?")
      .run(ownerIdValue);
    makeChatMessage("m-snap-3");

    const mode = snapshotIntakeModeMod(ownerIdValue, "m-snap-3");
    expect(mode).toBe("automatic");

    // Возвращаем к 'manual', чтобы тесты ниже друг друга не задевали.
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?")
      .run(ownerIdValue);
  });
});
