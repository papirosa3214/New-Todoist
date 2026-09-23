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
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const { buildApp } = await import("../src/index.js");
const dbModule = await import("../src/db.js");
const migrationsModule = await import("../src/migrations.js");
const { demoteSeededOwner } = await import("./helpers/seedOwner.js");

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

  // Проверка через реальный runner идёт в describe'е «real migration
  // runner on a temporary file DB» ниже — там поднимаются два отдельных
  // процесса, которые используют НАСТОЯЩИЙ runMigrations() с настоящими
  // id миграций. Подробности — в шапке того describe'а.
});

describe("owner /api/task-intake/settings", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let agentAuth: string;

  beforeAll(async () => {
    app = await buildApp();
    // Миграция 039_seed_owner заводит 'u1' как владельца; без этого
    // `isOwner(req.userId)` в /api/task-intake/settings видит u1, а не
    // нашего Owner, и отдаёт 403 вместо 200. Понижаем u1 до agent.
    demoteSeededOwner(dbModule.default);

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
    // GET /api/task-intake/settings теперь отдаёт и reviewer_first_default
    // (миграция с флагом ревью по умолчанию); здесь проверяем именно режим
    // приёма, без точной формы всего ответа — toMatchObject устойчив к
    // будущим дополнительным полям.
    expect(res.json()).toMatchObject({ mode: "manual" });
  });

  it("PATCH меняет режим, GET отдаёт новое значение", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
      payload: { mode: "automatic" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ mode: "automatic" });

    const get = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
    });
    expect(get.json()).toMatchObject({ mode: "automatic" });
  });

  it("режим сохраняется после перезапуска приложения", async () => {
    // Закрываем и поднимаем app заново — ту же БД, никаких других
    // изменений. Это та же проверка, что и в taskState.test.ts:
    // /api/task-intake/settings читает из БД, не из in-memory.
    await app.close();
    app = await buildApp();
    // После перезапуска app надо снова понизить u1: buildApp() не
    // пересоздаёт БД, но мы перестраховываемся от того, чтобы тест
    // упал, если setup.ts или миграции поменяются.
    demoteSeededOwner(dbModule.default);

    const res = await app.inject({
      method: "GET",
      url: "/api/task-intake/settings",
      headers: { authorization: ownerAuth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "automatic" });

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
    // Миграция 039_seed_owner сидит 'u1' как владельца — иначе
    // snapshotIntakeMode (через ownerId() в lib/ownerDraft.ts) работает
    // не с тем владельцем и режимы снимка расходятся с users.task_intake_mode.
    demoteSeededOwner(dbModule.default);

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

// ── Round 2: реальные границы — настоящий runner и настоящий процесс ──────
//
// Всё, что выше, работает на синглтоне db.ts текущего vitest-процесса и
// через in-memory helper (если бы он ещё был). Этого недостаточно:
// реальный сценарий — сервер стартует, миграции применяются настоящим
// runner'ом, настройка переключается между процессами, и конвейер должен
// остаться стабильным. Два теста ниже запускают дочерние процессы под
// `tsx` против свежего временного DB_PATH каждый раз, чтобы:
//
//   - миграция 037 реально прошла через runMigrations (тот самый, что
//     стартует в buildApp) — а не через ручной INSERT в schema_migrations;
//   - хелпер snapshotIntakeMode реально вызвался в ДРУГОМ процессе с
//     чистым импортом модуля, без in-memory Set, без общего кеша.
// Если кто-то откатит helper на старый Set+UPDATE, оба теста упадут
// именно из-за этого.
import { spawnSync } from "node:child_process";

// Путь к tsx внутри локального node_modules. Используем абсолютный путь,
// чтобы spawn не зависел от PATH, который в CI может быть урезан.
// Корень сервера и URL модулей выводим от расположения этого теста, чтобы
// child-процессы работали в любом checkout, включая CI.
const TEST_FILE = fileURLToPath(import.meta.url);
const SERVER_CWD = path.resolve(path.dirname(TEST_FILE), "..");
const TSX_BIN = path.join(SERVER_CWD, "node_modules", ".bin", "tsx");
const DB_MODULE_URL = pathToFileURL(path.join(SERVER_CWD, "src", "db.ts")).href;
const MIGRATIONS_MODULE_URL = pathToFileURL(
  path.join(SERVER_CWD, "src", "migrations.ts"),
).href;
const TASK_INTAKE_MODULE_URL = pathToFileURL(
  path.join(SERVER_CWD, "src", "routes", "task-intake.ts"),
).href;

interface ChildResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Запустить inline-скрипт в отдельном Node-процессе под tsx, в отдельной
 *  БД (через DB_PATH). Тонкая обёртка над spawnSync — возвращает код
 *  выхода и stdout/stderr, чтобы тест мог сказать, почему упало.
 *  Скрипт пишется как top-level async (ESM), результаты пишут в stdout. */
function runInChild(script: string, dbPath: string): ChildResult {
  // Каждый скрипт уходит в уникальный временный файл — параллельные
  // запуски не подерутся за путь, и после выполнения файл снимается.
  const scriptPath = path.join(
    os.tmpdir(),
    `taskflow-intake-child-${process.pid}-${crypto.randomBytes(6).toString("hex")}.mjs`,
  );
  fs.writeFileSync(scriptPath, script, { encoding: "utf8" });
  try {
    const result = spawnSync(TSX_BIN, [scriptPath], {
      cwd: SERVER_CWD,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? -1,
    };
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // файл мог быть уже снят вирусом или нами — не критично
    }
  }
}

/** Создать свежую временную папку под DB_PATH и вернуть путь к базе.
 *  Каталог снимается в afterEach родительского describe — здесь чисто
 *  путь. */
function freshRunnerDbPath(): { dir: string; path: string } {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `taskflow-intake-runner-${process.pid}-${crypto.randomBytes(4).toString("hex")}`),
  );
  return { dir, path: path.join(dir, "taskflow.db") };
}

describe("real migration runner on a temporary file DB", () => {
  let dir: string | null = null;
  let dbPath: string | null = null;

  afterEach(() => {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // уже снято
      }
      dir = null;
      dbPath = null;
    }
  });

  it("child1 поднимает БД до 036 включительно через runMigrations({through: '036_agent_execution_connection'}), child2 дотягивает её обычным runMigrations() — defaults применены, 037 в schema_migrations, идемпотентна при повторном прогоне", () => {
    const setup = freshRunnerDbPath();
    dir = setup.dir;
    dbPath = setup.path;

    // Дочерний процесс №1: открывает СВОЮ БД по DB_PATH (она свежая и
    // пустая), прогоняет migrate() + runMigrations({through: <реальный
    // id 036>}), затем сеет pre-037 строки. Никаких INSERT'ов в
    // schema_migrations руками — ровно столько, сколько сделал бы
    // buildApp() в проде до точки «до 037».
    const child1 = `
      const { migrate } = await import(${JSON.stringify(DB_MODULE_URL)});
      const { runMigrations } = await import(${JSON.stringify(MIGRATIONS_MODULE_URL)});
      const db = (await import(${JSON.stringify(DB_MODULE_URL)})).default;

      migrate();
      runMigrations({ through: "036_agent_execution_connection" });

      // После 036 миграции 037 ещё не было, а 028 уже отработала —
      // таблица chat_task_drafts существует, без intake_mode.
      db.prepare(
        "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'owner', 'human')",
      ).run("u-real-runner", "RealRunner", "real-runner@x", "h");
      db.prepare(
        "INSERT INTO tasks (id, title, creator_id) VALUES (?, ?, ?)",
      ).run("t-real-runner", "RealRunnerTask", "u-real-runner");
      db.prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, ?, ?)",
      ).run("m-real-runner", "u-real-runner", "real runner msg");
      db.prepare(
        "INSERT INTO chat_task_drafts (chat_message_id, status) VALUES (?, 'pending')",
      ).run("m-real-runner");

      // Контроль: 037 в schema_migrations быть не должно — мы её ещё
      // не применяли. Если она тут уже есть, тест не сможет проверить,
      // что child2 ЕЁ добавил.
      const before = db
        .prepare(
          "SELECT id FROM schema_migrations WHERE id = '037_task_intake_pipeline'",
        )
        .get();
      if (before) {
        console.error("PREFAIL: 037 already in schema_migrations before child2");
        process.exit(1);
      }
      console.log("child1 done");
    `;
    const r1 = runInChild(child1, dbPath);
    expect(
      r1.status,
      `child1 должен выйти с 0, иначе нечем тестировать. stderr:\n${r1.stderr}\nstdout:\n${r1.stdout}`,
    ).toBe(0);

    // Дочерний процесс №2: тот же DB_PATH. Вызывает обычный
    // runMigrations() (без through). Ожидаем, что runner увидит
    // незакрытую 037 и применит её через настоящий up(), а потом
    // запишет в schema_migrations.
    const child2 = `
      const { runMigrations } = await import(${JSON.stringify(MIGRATIONS_MODULE_URL)});
      const db = (await import(${JSON.stringify(DB_MODULE_URL)})).default;

      runMigrations();

      // Колонки добавлены с настоящими DEFAULT'ами.
      const userCol = db
        .prepare("PRAGMA table_info(users)")
        .all()
        .find((c) => c.name === "task_intake_mode");
      if (!userCol || userCol.dflt_value !== "'manual'") {
        console.error("FAIL: users.task_intake_mode не добавлена с DEFAULT 'manual'");
        process.exit(1);
      }
      const draftCol = db
        .prepare("PRAGMA table_info(chat_task_drafts)")
        .all()
        .find((c) => c.name === "intake_mode");
      if (!draftCol || draftCol.dflt_value !== "'manual'") {
        console.error("FAIL: chat_task_drafts.intake_mode не добавлена с DEFAULT 'manual'");
        process.exit(1);
      }
      const taskCols = db
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .map((c) => c.name);
      if (!taskCols.includes("needs_clarification") || !taskCols.includes("clarification_question")) {
        console.error("FAIL: tasks.needs_clarification / tasks.clarification_question не добавлены");
        process.exit(1);
      }

      // Defaults применены к существующим строкам, которые child1 посеял.
      const userRow = db
        .prepare("SELECT task_intake_mode FROM users WHERE id = ?")
        .get("u-real-runner");
      if (!userRow || userRow.task_intake_mode !== "manual") {
        console.error("FAIL: существующий пользователь не получил task_intake_mode='manual'");
        process.exit(1);
      }
      const draftRow = db
        .prepare(
          "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
        )
        .get("m-real-runner");
      if (!draftRow || draftRow.intake_mode !== "manual") {
        console.error("FAIL: существующий черновик не получил intake_mode='manual'");
        process.exit(1);
      }
      const taskRow = db
        .prepare(
          "SELECT needs_clarification, clarification_question FROM tasks WHERE id = ?",
        )
        .get("t-real-runner");
      if (!taskRow || taskRow.needs_clarification !== 0 || taskRow.clarification_question !== null) {
        console.error("FAIL: существующая задача не получила defaults по needs_clarification/clarification_question");
        process.exit(1);
      }

      // 037 реально записана runner'ом — РЕАЛЬНЫМ id, не синтетикой.
      const recorded = db
        .prepare(
          "SELECT id, description, applied_at FROM schema_migrations WHERE id = ?",
        )
        .get("037_task_intake_pipeline");
      if (!recorded) {
        console.error("FAIL: 037_task_intake_pipeline не появилась в schema_migrations");
        process.exit(1);
      }
      if (recorded.id !== "037_task_intake_pipeline") {
        console.error("FAIL: id в schema_migrations не тот, что ожидался: " + recorded.id);
        process.exit(1);
      }

      // Идемпотентность при повторном прогоне.
      runMigrations();
      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '037_task_intake_pipeline'",
        )
        .get();
      if (count.n !== 1) {
        console.error("FAIL: после второго runMigrations() запись 037 не уникальна: n=" + count.n);
        process.exit(1);
      }

      console.log("child2 done");
    `;
    const r2 = runInChild(child2, dbPath);
    expect(
      r2.status,
      `child2 упал. stderr:\n${r2.stderr}\nstdout:\n${r2.stdout}`,
    ).toBe(0);
  });
});

describe("process boundary: snapshot stability survives restart", () => {
  let dir: string | null = null;
  let dbPath: string | null = null;

  afterEach(() => {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      dir = null;
      dbPath = null;
    }
  });

  it("child1 делает снапшот 'manual' и переключает настройку на 'automatic'; child2 со свежим импортом модуля возвращает 'manual' и не перетирает строку", () => {
    const setup = freshRunnerDbPath();
    dir = setup.dir;
    dbPath = setup.path;

    // Процесс A: поднимает БД через migrate() + runMigrations(),
    // создаёт владельца, сообщение И строку chat_task_drafts (через
    // тот же INSERT, что раньше делал lib/ownerDraft.ts). Затем
    // делает снапшот 'manual' и переключает пользовательскую настройку
    // на 'automatic'.
    //
    // Почему строка черновика сеется РУКАМИ, а не через хелпер. Нам
    // нужно одно и то же поведение и для старого (Set+UPDATE), и для
    // нового (ON CONFLICT DO NOTHING) хелпера: оба должны иметь
    // возможность вызваться на существующей строке, чтобы проверить,
    // что они делают дальше. Если строки нет, старый хелпер падает
    // с "не найдена" ДО того, как мы успеваем проверить его
    // кросс-процессное поведение — а это уже не та причина падения,
    // которую мы хотим зафиксировать в тесте. С явной строкой оба
    // хелпера проходят первый вызов и дальше ведут себя по-разному.
    const child1 = `
      const { migrate } = await import(${JSON.stringify(DB_MODULE_URL)});
      const { runMigrations } = await import(${JSON.stringify(MIGRATIONS_MODULE_URL)});
      const { snapshotIntakeMode } = await import(${JSON.stringify(TASK_INTAKE_MODULE_URL)});
      const db = (await import(${JSON.stringify(DB_MODULE_URL)})).default;

      migrate();
      runMigrations();

      db.prepare(
        "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, 'owner', 'human')",
      ).run("u-process", "ProcessUser", "process@x", "h");
      db.prepare(
        "INSERT INTO chat_messages (id, from_user_id, text) VALUES (?, ?, ?)",
      ).run("m-process", "u-process", "process boundary msg");
      // Строка черновика уже на месте — DEFAULT 'manual' ставит
      // миграция 037 в task_intake_mode на этот момент, или миграция
      // 028 (если 037 ещё не было). В обоих случаях мы получаем
      // строку с intake_mode='manual', которую оба варианта хелпера
      // способны обработать.
      db.prepare(
        "INSERT INTO chat_task_drafts (chat_message_id, status) VALUES (?, 'pending')",
      ).run("m-process");

      const first = snapshotIntakeMode("u-process", "m-process");
      if (first !== "manual") {
        console.error("FAIL: child1 первый снапшот ожидался 'manual', получен '" + first + "'");
        process.exit(1);
      }

      // Владелец переключает общую настройку на 'automatic' ДО второго
      // вызова. Если бы хелпер полагался на in-memory Set и процесс
      // бы перезапустился между вызовами — следующий вызов перечитал
      // бы users.task_intake_mode и перезаписал строку.
      db.prepare(
        "UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?",
      ).run("u-process");

      console.log("child1 done");
    `;
    const r1 = runInChild(child1, dbPath);
    expect(
      r1.status,
      `child1 упал. stderr:\n${r1.stderr}\nstdout:\n${r1.stdout}`,
    ).toBe(0);

    // Процесс B: тот же DB_PATH, но это НОВЫЙ процесс — никакого
    // module-level состояния из child1 в нём нет. Свежий import
    // snapshotIntakeMode, вызов для того же сообщения.
    const child2 = `
      const { runMigrations } = await import(${JSON.stringify(MIGRATIONS_MODULE_URL)});
      const { snapshotIntakeMode } = await import(${JSON.stringify(TASK_INTAKE_MODULE_URL)});
      const db = (await import(${JSON.stringify(DB_MODULE_URL)})).default;

      // На случай, если бы child1 не оставил БД в консистентном
      // состоянии — обычный прогон миграций; на реальной БД после
      // child1 это no-op.
      runMigrations();

      const second = snapshotIntakeMode("u-process", "m-process");
      if (second !== "manual") {
        console.error(
          "FAIL: child2 ожидал 'manual' (снимок из child1), получил '" + second + "'. " +
          "Если здесь 'automatic' — хелпер перечитал users.task_intake_mode " +
          "вместо того, чтобы опираться на БД-снимок (in-memory Set или UPDATE).",
        );
        process.exit(1);
      }

      const stored = db
        .prepare(
          "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
        )
        .get("m-process");
      if (!stored || stored.intake_mode !== "manual") {
        console.error(
          "FAIL: в строке chat_task_drafts ожидалось intake_mode='manual', " +
          "получено '" + (stored ? stored.intake_mode : "null") + "'",
        );
        process.exit(1);
      }

      // И живая настройка действительно 'automatic' — иначе тест был
      // бы «зелёным по совпадению», а не по существу.
      const live = db
        .prepare("SELECT task_intake_mode FROM users WHERE id = ?")
        .get("u-process");
      if (!live || live.task_intake_mode !== "automatic") {
        console.error("FAIL: живая настройка пользователя не 'automatic' — тест не валиден");
        process.exit(1);
      }

      console.log("child2 done");
    `;
    const r2 = runInChild(child2, dbPath);
    expect(
      r2.status,
      `child2 упал — хелпер НЕ пережил настоящий рестарт процесса. ` +
      `stderr:\n${r2.stderr}\nstdout:\n${r2.stdout}`,
    ).toBe(0);
  });
});
