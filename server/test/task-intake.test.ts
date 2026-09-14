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

  function makeDraftRow(chatMessageId: string): void {
    // Без intake_mode — колонка получена миграцией 037, DEFAULT 'manual'
    // заполнит её автоматически. Здесь имитируем строку ДО вызова
    // snapshotIntakeMode, чтобы хелпер обновил её явно.
    dbModule.default
      .prepare(
        "INSERT INTO chat_task_drafts (chat_message_id, status) VALUES (?, 'pending')",
      )
      .run(chatMessageId);
  }

  it("записывает режим владельца в intake_mode и возвращает его", async () => {
    makeChatMessage("m-snap-1");
    makeDraftRow("m-snap-1");

    const { snapshotIntakeMode } = await import("../src/routes/task-intake.js");
    const mode = snapshotIntakeMode(ownerIdValue, "m-snap-1");
    expect(mode).toBe("manual");

    const row = dbModule.default
      .prepare(
        "SELECT intake_mode FROM chat_task_drafts WHERE chat_message_id = ?",
      )
      .get("m-snap-1") as { intake_mode: string };
    expect(row.intake_mode).toBe("manual");
  });

  it("не перечитывает users.task_intake_mode для уже снапшотнутой строки", async () => {
    // Шаг 1: владелец в 'manual' (по умолчанию), снимаем снапшот.
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?")
      .run(ownerIdValue);
    makeChatMessage("m-snap-2");
    makeDraftRow("m-snap-2");
    const { snapshotIntakeMode } = await import("../src/routes/task-intake.js");
    const first = snapshotIntakeMode(ownerIdValue, "m-snap-2");
    expect(first).toBe("manual");

    // Шаг 2: владелец переключает общий режим на 'automatic' ДО разбора
    // (модель ещё не вызвана, потому что это юнит-тест хелпера — а в
    // живой цепочке именно так и будет: снимок снимается ДО модели).
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'automatic' WHERE id = ?")
      .run(ownerIdValue);

    // Шаг 3: хранимое значение в строке НЕ изменилось от того, что
    // владелец поменял настройку. Это и есть «поздние стадии не
    // перечитывают пользовательскую настройку»: модель и конвейер
    // читают chat_task_drafts.intake_mode и видят зафиксированное
    // значение, а не текущее users.task_intake_mode.
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
    makeDraftRow("m-snap-3");
    const { snapshotIntakeMode } = await import("../src/routes/task-intake.js");
    const mode = snapshotIntakeMode(ownerIdValue, "m-snap-3");
    expect(mode).toBe("automatic");

    // Возвращаем к 'manual', чтобы тесты ниже друг друга не задевали.
    dbModule.default
      .prepare("UPDATE users SET task_intake_mode = 'manual' WHERE id = ?")
      .run(ownerIdValue);
  });
});
