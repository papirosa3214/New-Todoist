// MAK-77: recordAttemptModel — пишет модель/провайдера в открытую попытку
// при запуске роли, не перетирая уже записанное и не трогая закрытые.
//
// Модуль тестируется напрямую (это чистая функция над БД), поэтому живой
// запуск роли и SDK подменять не нужно. Как и в mak70/mak76: buildApp()
// инициализирует схему и миграции, дальше attempt/subtask/task верстаем
// прямыми запросами в db — точные условия (открытая попытка, пустая model,
// ended_at) проще собрать руками, чем через API.
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { recordAttemptModel } from "../src/lib/attemptModel.js";

const uid = () => crypto.randomUUID();

// Открытая attempt на шаге: subtask_id = subtaskId, ended_at NULL, model пустой.
function insertAttempt(taskId: string, subtaskId: string | null, closed: boolean): string {
  const id = uid();
  db.prepare(
    `INSERT INTO attempts (id, task_id, subtask_id, executor_id, started_at, ended_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
  ).run(id, taskId, subtaskId, ownerId, closed ? "2020-01-01 00:00:00" : null);
  return id;
}

function makeTask(): string {
  const id = uid();
  db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES (?, ?, ?, 'active')")
    .run(id, "MAK-77 task", ownerId);
  return id;
}

function makeSubtask(taskId: string): string {
  const id = uid();
  db.prepare("INSERT INTO subtasks (id, task_id, title, done, position) VALUES (?, ?, ?, 0, 0)")
    .run(id, taskId, "MAK-77 step");
  return id;
}

let app: FastifyInstance;
let ownerId: string;

describe("MAK-77: recordAttemptModel", () => {
  beforeAll(async () => {
    app = await buildApp();
    // Один исполнитель на все вставляемые attempts (FK на users.id).
    ownerId = uid();
    db.prepare(
      "INSERT INTO users (id, name, email, password_hash, role, type) VALUES (?, 'MAK77 Owner', ?, 'x', 'owner', 'human')",
    ).run(ownerId, `mak77-${ownerId.slice(0, 8)}@test`);
  });

  it("(а) шаг с открытой попыткой — пишет model и provider, возвращает 1", () => {
    const taskId = makeTask();
    const subtaskId = makeSubtask(taskId);
    const attemptId = insertAttempt(taskId, subtaskId, false);
    db.prepare("UPDATE subtasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, subtaskId);

    const changed = recordAttemptModel({ taskId, subtaskId, modelId: "claude-3-5-sonnet", provider: "anthropic" });
    expect(changed).toBe(1);

    const row = db.prepare("SELECT model, provider FROM attempts WHERE id = ?").get(attemptId) as { model: string | null; provider: string | null };
    expect(row.model).toBe("claude-3-5-sonnet");
    expect(row.provider).toBe("anthropic");
  });

  it("(б) повторный вызов с другой моделью — НЕ перезаписывает, возвращает 0", () => {
    const taskId = makeTask();
    const subtaskId = makeSubtask(taskId);
    const attemptId = insertAttempt(taskId, subtaskId, false);
    db.prepare("UPDATE subtasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, subtaskId);

    // Первая запись закрепляется (model не пустой → повтор не должен менять).
    expect(recordAttemptModel({ taskId, subtaskId, modelId: "claude-3-5-sonnet", provider: "anthropic" })).toBe(1);
    const changed = recordAttemptModel({ taskId, subtaskId, modelId: "gpt-4o", provider: "openai" });

    expect(changed).toBe(0);
    const row = db.prepare("SELECT model, provider FROM attempts WHERE id = ?").get(attemptId) as { model: string | null; provider: string | null };
    expect(row.model).toBe("claude-3-5-sonnet");
    expect(row.provider).toBe("anthropic");
  });

  it("(в) задача без шага — пишется в попытку из tasks.current_attempt_id", () => {
    const taskId = makeTask();
    // subtask_id NULL: попытка задачи целиком (подпадает под tasks.current_attempt_id).
    const attemptId = insertAttempt(taskId, null, false);
    db.prepare("UPDATE tasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, taskId);

    const changed = recordAttemptModel({ taskId, subtaskId: null, modelId: "MiniMax-M2", provider: "minimax" });
    expect(changed).toBe(1);

    const row = db.prepare("SELECT model, provider FROM attempts WHERE id = ?").get(attemptId) as { model: string | null; provider: string | null };
    expect(row.model).toBe("MiniMax-M2");
    expect(row.provider).toBe("minimax");
  });

  it("(г) попытка уже закрыта (ended_at заполнен) — возвращает 0, не трогает", () => {
    const taskId = makeTask();
    const subtaskId = makeSubtask(taskId);
    const attemptId = insertAttempt(taskId, subtaskId, true);
    db.prepare("UPDATE subtasks SET current_attempt_id = ? WHERE id = ?").run(attemptId, subtaskId);

    const changed = recordAttemptModel({ taskId, subtaskId, modelId: "claude-3-5-sonnet", provider: "anthropic" });
    expect(changed).toBe(0);

    const row = db.prepare("SELECT model FROM attempts WHERE id = ?").get(attemptId) as { model: string | null };
    expect(row.model).toBeNull();
  });
});
