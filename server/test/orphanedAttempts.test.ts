// Осиротевшие попытки ролей: периодический проход закрывает запуск, который
// умер без перезапуска сервера.
//
// Регрессия 24.10.2026 (аудит надёжности): периодический проход отбирал
// попытки условием `heartbeat_at < datetime('now', ?)`. Попытки, заведённые
// БЕЗ heartbeat_at (createAttempt в PiRuntimeAdapter.ts такую колонку не
// пишет; roleLoadWatcher — тоже), в SQLite этому условию не удовлетворяют:
// сравнение с NULL даёт NULL, а не true. Такие попытки не закрывались
// НИКОГДА — висели `ended_at IS NULL`, занимали слот по UNIQUE-индексу
// (idx_attempts_one_active_per_task) и не давали новой попытке по задаче.
//
// Проверка не «функция вернула число», а поведение: попытка без пульса
// закрыта, живая попытка с свежим пульсом — нет.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { closeOrphanedAttempts } from "../src/runtime/orphanedAttempts.js";

function вставитьПопытку(opts: {
  id: string;
  heartbeat: string | null;
  ended: string | null;
}): void {
  // attempts.task_id и executor_id — внешние ключи на tasks/users, поэтому
  // заводим настоящую задачу и исполнителя, иначе вставка падает на FK.
  const taskId = `task-${opts.id}`;
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type)
     VALUES ('audit-orphan-exec', 'Аудитор', 'audit-orphan@taskflow.local', '!no-login', 'agent', 'ai')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, creator_id, status)
     VALUES (?, 'Задача аудита', 'audit-orphan-exec', 'active')`,
  ).run(taskId);
  db.prepare(
    `INSERT INTO attempts
       (id, task_id, executor_id, runner, model, started_at, heartbeat_at, ended_at)
     VALUES (?, ?, 'audit-orphan-exec', 'pi', 'test-model', datetime('now','-2 hours'), ?, ?)`,
  ).run(opts.id, taskId, opts.heartbeat, opts.ended);
}

describe("Осиротевшие попытки", () => {
  beforeAll(() => {
    // Схема на тестовой базе создаётся явно: setup.ts только выставляет
    // DB_PATH, миграции он не гоняет.
    migrate();
    runMigrations();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM attempts WHERE id LIKE 'audit-orphan-%'").run();
  });

  it("закрывает попытку, у которой пульса не было никогда (heartbeat_at IS NULL)", () => {
    вставитьПопытку({ id: "audit-orphan-nohb", heartbeat: null, ended: null });

    closeOrphanedAttempts(10);

    const строка = db
      .prepare("SELECT ended_at, outcome FROM attempts WHERE id = ?")
      .get("audit-orphan-nohb") as { ended_at: string | null; outcome: string | null };
    expect(строка.ended_at).toBeTruthy();
    expect(строка.outcome).toBe("interrupted");
  });

  it("НЕ закрывает живую попытку со свежим пульсом", () => {
    вставитьПопытку({
      id: "audit-orphan-alive",
      heartbeat: new Date().toISOString(),
      ended: null,
    });

    closeOrphanedAttempts(10);

    const строка = db
      .prepare("SELECT ended_at FROM attempts WHERE id = ?")
      .get("audit-orphan-alive") as { ended_at: string | null };
    expect(строка.ended_at).toBeNull();
  });

  it("НЕ трогает уже закрытые попытки", () => {
    вставитьПопытку({
      id: "audit-orphan-closed",
      heartbeat: null,
      ended: "2026-01-01 00:00:00",
    });

    closeOrphanedAttempts(10);

    const строка = db
      .prepare("SELECT ended_at, outcome FROM attempts WHERE id = ?")
      .get("audit-orphan-closed") as { ended_at: string | null; outcome: string | null };
    expect(строка.ended_at).toBe("2026-01-01 00:00:00");
    expect(строка.outcome).toBeNull();
  });
});
