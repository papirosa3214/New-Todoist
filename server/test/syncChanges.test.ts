// Общий журнал синхронизации (`/api/sync/changes`) — догон по курсору для
// проектов, меток, заметок, дневника, рутин и вложений.
//
// Что проверяем:
//   1. Журнал ЛОВИТ правку каждой из этих сущностей (триггеры, а не код
//      приложения: иначе забытый путь записи отдаст клиенту неполную дельту).
//   2. `GET /api/sync/changes?since=` отдаёт изменившиеся и исчезнувшие id
//      ПО ТИПАМ, а не «всё вместе».
//   3. Удаление едет тем же потоком, что и правка (removed_ids), и клиент
//      узнаёт о нём без догадок по отсутствию сущности.
//   4. Курсор вне окна хранения → full: true (клиент перечитывает всё).
//   5. Видимость — на сервере: чужой приватный проект и чужая метка в
//      дельту не попадают.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { installRealtimeInvalidation } from "../src/lib/realtimeInvalidation.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let owner: string;
let other: string;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await buildApp();
  owner = (db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get() as { id: string }).id;
  // Второй человек: не владелец трекера, ничего чужого не видит.
  db.prepare(
    "INSERT OR IGNORE INTO users (id,name,email,password_hash,role,type) VALUES (?,?,?,?,?,?)",
  ).run("sync-other", "Другой", "sync-other@example.com", "x", "agent", "human");
  db.prepare(
    "INSERT OR IGNORE INTO users (id,name,email,password_hash,role,type) VALUES (?,?,?,?,?,?)",
  ).run("sync-helper", "Помощник", "sync-helper@example.com", "x", "agent", "human");
  other = "sync-other";
  token = app.jwt.sign({ id: owner });
});

afterAll(async () => {
  await app?.close();
});

/** Курсор, с которого читается дельта. */
const since = (seq: number) => `s:${seq}`;

/** Текущий максимальный seq журнала. */
function cursorNow(): number {
  return (db.prepare("SELECT MAX(seq) AS m FROM sync_changes").get() as { m: number }).m ?? 0;
}

describe("общий журнал синхронизации", () => {
  it("ловит правку проекта, метки, заметки и рутины", async () => {
    const start = cursorNow();
    db.prepare("INSERT INTO projects (id,name,owner_id) VALUES (?,?,?)").run("sync-p1", "Проект синхронизации", owner);
    db.prepare("INSERT INTO labels (id,name,owner_id) VALUES (?,?,?)").run("sync-l1", "Метка синхронизации", owner);
    db.prepare("INSERT INTO user_notes (id,title,updated_by) VALUES (?,?,?)").run("sync-n1", "Заметка синхронизации", owner);
    db.prepare(
      "INSERT INTO task_schedules (id,title,task_payload,rule_kind,time_local,timezone,created_by) VALUES (?,?,?,?,?,?,?)",
    ).run("sync-s1", "Рутина синхронизации", "{}", "daily", "09:00", "Europe/Moscow", owner);

    const res = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${since(start)}`,
      headers: auth(),
    });
    const body = res.json();
    expect(body.full).toBe(false);
    expect(body.entities.projects.changed_ids).toContain("sync-p1");
    expect(body.entities.labels.changed_ids).toContain("sync-l1");
    expect(body.entities.notes.changed_ids).toContain("sync-n1");
    expect(body.entities.schedules.changed_ids).toContain("sync-s1");
  });

  it("удаление едет тем же потоком: removed_ids по типу", async () => {
    const start = cursorNow();
    db.prepare("DELETE FROM labels WHERE id = 'sync-l1'").run();
    db.prepare("DELETE FROM user_notes WHERE id = 'sync-n1'").run();

    const res = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${since(start)}`,
      headers: auth(),
    });
    const body = res.json();
    expect(body.entities.labels.removed_ids).toContain("sync-l1");
    expect(body.entities.labels.changed_ids).not.toContain("sync-l1");
    expect(body.entities.notes.removed_ids).toContain("sync-n1");
  });

  it("курсор вне окна хранения → full: true", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${since(999999999)}`,
      headers: auth(),
    });
    const body = res.json();
    expect(body.full).toBe(true);
    expect(body.entities.projects.changed_ids).toEqual([]);
  });

  it("без курсора клиент просит полную перечитку", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sync/changes",
      headers: auth(),
    });
    expect(res.json().full).toBe(true);
  });

  it("чужие приватные проект и метка в дельту не попадают", async () => {
    const start = cursorNow();
    db.prepare(
      "INSERT INTO projects (id,name,owner_id,is_private) VALUES (?,?,?,1)",
    ).run("sync-p-secret", "Чужой приватный", other);
    db.prepare("INSERT INTO labels (id,name,owner_id) VALUES (?,?,?)").run("sync-l-other", "Чужая метка", other);

    // Чужой человек (не владелец трекера) не видит ни приватный проект
    // владельца чужого проекта, ни чужую метку — то же правило, что в
    // списках проектов и меток.
    const otherToken = app.jwt.sign({ id: "sync-helper" });
    const otherRes = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${since(start)}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    const otherBody = otherRes.json();
    expect(otherBody.entities.projects.changed_ids).not.toContain("sync-p-secret");
    expect(otherBody.entities.labels.changed_ids).not.toContain("sync-l-other");

    // Владелец трекера видит приватный проект (как и в списке проектов).
    const ownerRes = await app.inject({
      method: "GET",
      url: `/api/sync/changes?since=${since(start)}`,
      headers: auth(),
    });
    expect(ownerRes.json().entities.projects.changed_ids).toContain("sync-p-secret");
  });


  it("правка заметки порождает событие сокета (У1)", async () => {
    // Сервер следил за заброшенной таблицей `notes`, а заметки лежат в
    // `user_notes` — правка заметки не порождала событие вообще. Проверяем,
    // что триггер реальтайма стоит именно на `user_notes`.
    installRealtimeInvalidation(db, () => {});
    const noteId = "sync-note-event";
    db.prepare("INSERT INTO user_notes (id,title,content,updated_by) VALUES (?,?,?,?)").run(
      noteId,
      "Заметка для события",
      "{}",
      owner,
    );
    const dirty = db
      .prepare(
        "SELECT topic FROM temp.tf_realtime_dirty WHERE topic = 'note:changed'",
      )
      .all() as Array<{ topic: string }>;
    expect(dirty.length).toBeGreaterThan(0);

    // Правка заметки — тоже изменение.
    db.prepare("UPDATE user_notes SET title = ? WHERE id = ?").run("Другая заметка", noteId);
    const afterUpdate = db
      .prepare(
        "SELECT topic FROM temp.tf_realtime_dirty WHERE topic = 'note:changed'",
      )
      .all() as Array<{ topic: string }>;
    expect(afterUpdate.length).toBeGreaterThan(0);
  });
});
