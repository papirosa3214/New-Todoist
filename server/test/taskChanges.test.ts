// Дельты и ETag/304 на выдаче задач (вариант B трафика iOS-клиента,
// владелец 25.10.2026).
//
// Что проверяем:
//   1. Журнал изменений ЛОВИТ правку карточки, её подзадачи и комментария
//      (триггеры, а не код приложения: иначе забытый путь записи отдаст
//      клиенту неполную дельту).
//   2. GET /api/tasks/changes?since= отдаёт изменившиеся и исчезнувшие id.
//   3. Курсор вне покрытия журнала → full: true (клиент перечитывает всё).
//   4. GET /api/tasks с If-None-Match → 304 без тела (телефон не качает
//      402 КБ gzip впустую).
//
// Триггеры проверяются на СВЕЖЕЙ базе прогона: именно там ловится ошибка
// «no such column: OLD.id» (в триггере INSERT нет строки OLD), которая
// 25.10.2026 положила вставку в subtasks/comments на живом сервере.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let owner: string;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp();
  owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
  token = app.jwt.sign({ id: owner });
  db.prepare("INSERT INTO tasks (id,title,creator_id) VALUES (?,?,?)").run("delta-a", "Карточка А", owner);
  db.prepare("INSERT INTO tasks (id,title,creator_id) VALUES (?,?,?)").run("delta-b", "Карточка Б", owner);
});

afterAll(async () => {
  await app?.close();
});

describe("журнал изменений задач", () => {
  it("ловит вставку, правку и удаление карточки", () => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-b'").get() as { n: number }
    ).n;
    expect(before).toBeGreaterThan(0); // INSERT записан триггером
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Карточка Б (правка)", "delta-b");
    db.prepare("DELETE FROM tasks WHERE id = ?").run("delta-b");
    const rows = db
      .prepare("SELECT deleted FROM task_changes WHERE task_id = 'delta-b' ORDER BY seq")
      .all() as Array<{ deleted: number }>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[rows.length - 1].deleted).toBe(1); // удаление помечено
  });

  it("ловит правку дочерней таблицы (подзадача, комментарий)", () => {
    // Именно эти триггеры падали «no such column: OLD.id».
    db.prepare("INSERT INTO subtasks (id,task_id,title) VALUES (?,?,?)").run("delta-sub", "delta-a", "Подзадача");
    db.prepare("INSERT INTO comments (id,task_id,user_id,text) VALUES (?,?,?,?)").run("delta-cmt", "delta-a", owner, "Комментарий");
    const sub = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-a'").get() as { n: number }
    ).n;
    expect(sub).toBeGreaterThanOrEqual(3); // вставка карточки + подзадача + комментарий
  });

  it("ловит удаление дочерней строки (триггер читает OLD, а не NEW)", () => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-a'").get() as { n: number }
    ).n;
    db.prepare("DELETE FROM subtasks WHERE id = ?").run("delta-sub");
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-a'").get() as { n: number }
    ).n;
    expect(after).toBe(before + 1);
  });

  it("ловит правку ноды плана совместной работы (ключ — подзапрос к плану)", () => {
    db.prepare(
      "INSERT INTO task_collaboration_plans (id,task_id,revision,profile,created_by) VALUES (?,?,?,?,?)",
    ).run("delta-plan", "delta-a", 1, "research", owner);
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-a'").get() as { n: number }
    ).n;
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id,plan_id,slot_key,role_key) VALUES (?,?,?,?)",
    ).run("delta-node", "delta-plan", "slot-1", "builder");
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM task_changes WHERE task_id = 'delta-a'").get() as { n: number }
    ).n;
    expect(after).toBe(before + 1); // в журнал — карточка плана, а не id плана
  });
});

describe("GET /api/tasks/changes", () => {
  it("без курсора просит полную перечитку", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tasks/changes", headers: auth() });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.full).toBe(true);
    expect(body.changed_ids).toEqual([]);
    expect(body.removed_ids).toEqual([]);
    expect(typeof body.server_time).toBe("string");
  });

  it("отдаёт изменившиеся карточки по курсору", async () => {
    // Курсор берём из заголовка полной выдачи — так же, как это делает клиент.
    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: auth() });
    const cursor = list.headers["x-taskflow-sync-cursor"] as string;
    expect(cursor).toBeTruthy();
    db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("Карточка А (правка)", "delta-a");

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/changes?since=${encodeURIComponent(cursor)}`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.full).toBe(false);
    expect(body.changed_ids).toContain("delta-a");
  });

  it("курсор старше покрытия журнала → full: true", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/changes?since=${encodeURIComponent("2020-01-01 00:00:00")}`,
      headers: auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().full).toBe(true);
  });

  it("курсор идёт по часам сервера, а не застревает на последней записи журнала", async () => {
    // Последняя запись журнала — час назад (тихая полоса). Курсор всё равно
    // должен быть «сейчас»: иначе клиент на каждом опросе получал бы ту же
    // дельту заново, окно чтения росло бы, а через 7 дней вышел бы за
    // границу хранения журнала — и клиент сделал бы полную перечитку.
    db.prepare("UPDATE task_changes SET changed_at = datetime('now', '-1 hour')").run();

    const list = await app.inject({ method: "GET", url: "/api/tasks", headers: auth() });
    const cursor = list.headers["x-taskflow-sync-cursor"] as string;
    expect(cursor).toBeTruthy();

    const nowSec = Date.now() / 1000;
    const cursorSec = Date.parse(cursor.replace(" ", "T") + "Z") / 1000;
    expect(Math.abs(cursorSec - nowSec)).toBeLessThan(5); // курсор ≈ сейчас

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/changes?since=${encodeURIComponent(cursor)}`,
      headers: auth(),
    });
    const body = response.json();
    expect(body.full).toBe(false);
    const serverSec = Date.parse(body.server_time.replace(" ", "T") + "Z") / 1000;
    expect(Math.abs(serverSec - nowSec)).toBeLessThan(5); // server_time ≈ сейчас
  });
});

describe("ETag на GET /api/tasks", () => {
  it("отдаёт ETag и курсор, а повтор с If-None-Match — 304 без тела", async () => {
    const first = await app.inject({ method: "GET", url: "/api/tasks", headers: auth() });
    expect(first.statusCode).toBe(200);
    const etag = first.headers["etag"] as string;
    expect(etag).toBeTruthy();
    expect(first.headers["x-taskflow-sync-cursor"]).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { ...auth(), "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });
});
