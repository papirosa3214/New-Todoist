// Уборка лишних чатов (карточка 0b7a8b81…, 21.10.2026). Три правила:
//
//   1. ПРАВО УБИРАТЬ. Темы задач заводит сервер (lib/projectTopics.ts), и
//      создатель у них один на весь проект — проверка «только создатель» к
//      ним была неприменима. Теперь тему задачи убирает любой участник
//      проекта, а личные и групповые переписки (dm, personal, handoff,
//      wake) — только их создатель.
//   2. УБРАТЬ = АРХИВИРОВАТЬ. Строки не стираются: у чата появляется
//      closed_at, сообщения и счётчики остаются в базе, архивный чат уходит
//      из общего списка, но виден в карточке своей задачи.
//   3. ОТБОР КАНДИДАТОВ. Массовая уборка берёт только пустые темы задач:
//      без сообщений, без строк в очереди доставки, не тронутые два часа, без
//      живых попыток. Личные переписки в кандидаты не попадают никогда.
//
// Идём через app.inject — контракт наружу, тот же, что у клиентов.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db, { hashApiToken } from "../src/db.js";
import { ensureTaskRoom } from "../src/lib/projectTopics.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";

const ROLE_TOKEN = "role-builder-cleanup-token";

describe("Уборка лишних чатов: правило прав", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let otherAuth: { authorization: string };
  let otherId: string;
  let roleAuth: { authorization: string };
  let topicId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const owner = await reg("CleanupOwner", "owner");
    ownerAuth = bearer(owner.jwt);
    const other = await reg("CleanupOther");
    otherId = other.id;
    otherAuth = bearer(other.jwt);
    // Роль работает по задаче — значит, участник проекта.
    db.prepare("UPDATE users SET api_token = ? WHERE id = 'role_builder'").run(
      hashApiToken(ROLE_TOKEN),
    );
    roleAuth = { authorization: `Bearer ${ROLE_TOKEN}` };

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: ownerAuth,
        payload: { name: "Проект уборки" },
      })
    ).json();
    const taskId = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: ownerAuth,
        payload: { title: "Задача с темой", project_id: project.id },
      })
    ).json().task.id;
    topicId = ensureTaskRoom(taskId)!;
    expect(topicId).toBeTruthy();
    // Роль — участник темы задачи (заводит её план, а не человек).
    db.prepare(
      "INSERT OR IGNORE INTO chat_members(chat_id, member_id, last_read_at) VALUES (?, 'role_builder', datetime('now'))",
    ).run(topicId);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("тему задачи убирает участник проекта, даже если он не создатель", async () => {
    const created = db.prepare("SELECT created_by FROM chats WHERE id = ?").get(topicId) as {
      created_by: string;
    };
    expect(created.created_by).not.toBe("role_builder");

    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/archive`,
      headers: roleAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBe(true);

    const row = db
      .prepare("SELECT closed_at, archived_at FROM chats WHERE id = ?")
      .get(topicId) as { closed_at: string | null; archived_at: string | null };
    expect(row.closed_at).toBeTruthy();
    expect(row.archived_at).toBeTruthy();
  });

  it("личную переписку убирает только её создатель", async () => {
    const chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Личная переписка", member_ids: [otherId] },
      })
    ).json().chat;

    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: otherAuth,
    });
    expect(foreign.statusCode).toBe(403);

    const own = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: ownerAuth,
    });
    expect(own.statusCode).toBe(200);
  });

  it("личную комнату (personal) убирает только создатель, общую — никто", async () => {
    const personal = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Комната роли", member_ids: [otherId] },
      })
    ).json().chat;
    db.prepare("UPDATE chats SET room_kind = 'personal' WHERE id = ?").run(personal.id);
    const foreignPersonal = await app.inject({
      method: "DELETE",
      url: `/api/chats/${personal.id}`,
      headers: otherAuth,
    });
    expect(foreignPersonal.statusCode).toBe(403);
    const ownPersonal = await app.inject({
      method: "DELETE",
      url: `/api/chats/${personal.id}`,
      headers: ownerAuth,
    });
    expect(ownPersonal.statusCode).toBe(200);

    const common = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Общая", member_ids: [otherId] },
      })
    ).json().chat;
    db.prepare("UPDATE chats SET room_kind = 'common' WHERE id = ?").run(common.id);
    const refusedCommon = await app.inject({
      method: "DELETE",
      url: `/api/chats/${common.id}`,
      headers: ownerAuth,
    });
    expect(refusedCommon.statusCode).toBe(403);
  });

  it("чужой чат недоступен → 404", async () => {
    const chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Не твоё", member_ids: [otherId] },
      })
    ).json().chat;
    const stranger = await reg("CleanupStranger");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: bearer(stranger.jwt),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Уборка лишних чатов: удаление как архивирование", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let otherId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    const owner = await reg("ArchiveOwner", "owner");
    ownerAuth = bearer(owner.jwt);
    const other = await reg("ArchiveOther");
    otherId = other.id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("после уборки строка чата и сообщения остаются в базе", async () => {
    const chat = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Переписка", member_ids: [otherId] },
      })
    ).json().chat;
    const message = (
      await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/messages`,
        headers: ownerAuth,
        payload: { text: "сообщение остаётся в базе" },
      })
    ).json().message;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(200);

    const row = db
      .prepare("SELECT id, closed_at, archived_at FROM chats WHERE id = ?")
      .get(chat.id) as { id: string; closed_at: string | null; archived_at: string | null };
    expect(row.id).toBe(chat.id);
    expect(row.closed_at).toBeTruthy();
    expect(row.archived_at).toBeTruthy();

    const kept = db
      .prepare("SELECT text FROM chat_messages WHERE id = ?")
      .get(message.id) as { text: string } | undefined;
    expect(kept?.text).toBe("сообщение остаётся в базе");
  });

  it("архивный чат уходит из общего списка, но остаётся в карточке задачи", async () => {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: ownerAuth,
        payload: { name: "Проект архива" },
      })
    ).json();
    const taskId = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: ownerAuth,
        payload: { title: "Задача архива", project_id: project.id },
      })
    ).json().task.id;
    const topicId = ensureTaskRoom(taskId)!;

    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/archive`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/chats", headers: ownerAuth });
    const ids = (list.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);

    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
    });
    const chats = card.json().chats as Array<{ id: string }>;
    expect(chats.map((c) => c.id)).toContain(topicId);
  });

  it("возврат задачи в работу не воскрешает убранную тему", async () => {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: ownerAuth,
        payload: { name: "Проект переоткрытия" },
      })
    ).json();
    const taskId = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: ownerAuth,
        payload: { title: "Задача переоткрытия", project_id: project.id },
      })
    ).json().task.id;
    const topicId = ensureTaskRoom(taskId)!;

    await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/archive`,
      headers: ownerAuth,
    });
    // Задача закрылась (тема закрылась вместе с ней) и вернулась в работу.
    const { setTaskRoomClosed } = await import("../src/lib/projectTopics.js");
    setTaskRoomClosed(taskId, true);
    setTaskRoomClosed(taskId, false);

    const row = db
      .prepare("SELECT closed_at, archived_at FROM chats WHERE id = ?")
      .get(topicId) as { closed_at: string | null; archived_at: string | null };
    expect(row.archived_at).toBeTruthy();
    expect(row.closed_at).toBeTruthy();
  });
});

describe("Уборка лишних чатов: отбор кандидатов", () => {
  let app: FastifyInstance;
  let ownerAuth: { authorization: string };
  let otherId: string;
  let ownerId: string;

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  async function reg(name: string, role?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email: `${name}-${Date.now()}@test`, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, body.user.id);
    return { id: body.user.id as string, jwt: body.token as string };
  }

  /** Тема задачи: заводится сервером, как в жизни. */
  async function topic(title: string): Promise<{ taskId: string; topicId: string }> {
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: ownerAuth,
        payload: { name: `Проект ${title}` },
      })
    ).json();
    const taskId = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: ownerAuth,
        payload: { title, project_id: project.id },
      })
    ).json().task.id;
    return { taskId, topicId: ensureTaskRoom(taskId)! };
  }

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    const owner = await reg("CandidatesOwner", "owner");
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);
    const other = await reg("CandidatesOther");
    otherId = other.id;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("кандидат — пустая тема задачи, лежащая дольше двух часов", async () => {
    const { topicId } = await topic("Давно пустая");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);

    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(topicId);
  });

  it("недавняя тема в кандидаты не попадает", async () => {
    const { topicId } = await topic("Свежая тема");
    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);
  });

  it("тема с живой попыткой в кандидаты не попадает", async () => {
    const { taskId, topicId } = await topic("Живой ход");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);
    db.prepare(
      `INSERT INTO attempts(id, task_id, executor_id, started_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(`attempt-${topicId}`, taskId, ownerId);

    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);
  });

  it("тема с сообщениями и личная переписка в кандидаты не попадают", async () => {
    const { topicId } = await topic("Тема с перепиской");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);
    await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/messages`,
      headers: ownerAuth,
      payload: { text: "тут была переписка" },
    });

    const personal = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: ownerAuth,
        payload: { title: "Личная", member_ids: [otherId] },
      })
    ).json().chat;
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(personal.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);
    expect(ids).not.toContain(personal.id);
  });

  it("тема карточки в работе (agent_state in_progress) не убирается и принимает сообщения", async () => {
    const { taskId, topicId } = await topic("Карточка в работе");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);
    db.prepare("UPDATE tasks SET agent_state = 'in_progress' WHERE id = ?").run(taskId);

    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);

    // Тема остаётся рабочим местом: сообщения принимаются, уборка её не трогает.
    const sent = await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/messages`,
      headers: ownerAuth,
      payload: { text: "Тема живая, не убирать" },
    });
    expect(sent.statusCode).toBe(200);

    const clean = await app.inject({
      method: "POST",
      url: "/api/chats/cleanup",
      headers: ownerAuth,
      payload: { confirm: true },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().chats as string[]).not.toContain(topicId);
    const row = db.prepare("SELECT closed_at, archived_at FROM chats WHERE id = ?").get(topicId) as any;
    expect(row.closed_at).toBeNull();
    expect(row.archived_at).toBeNull();
  });

  it("карточка с незакрытым шагом роли в работе в кандидаты не попадает", async () => {
    const { taskId, topicId } = await topic("Шаг роли в работе");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);
    db.prepare(
      "INSERT INTO subtasks(id, task_id, title, done, agent_state) VALUES (?, ?, 'Шаг', 0, 'in_progress')",
    ).run(`sub-${topicId}`, taskId);

    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (res.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);
  });

  it("карточка, взявшаяся в работу между предпросмотром и подтверждением, не убирается", async () => {
    const { taskId, topicId } = await topic("Гонка уборки");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);

    // Имитируем гонку: как только отбор кандидатов отработал (предпросмотр
    // показал тему), карточка уходит в работу — а проверка в момент
    // архивирования обязана это увидеть. Ставим состояние прямо после
    // отбора кандидатов, до проверки перед архивированием.
    const originalPrepare = db.prepare.bind(db);
    let armed = true;
    (db as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!armed || !sql.includes("COALESCE(c.archived_at")) return stmt;
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "all")
            return (...args: unknown[]) => {
              const rows = (value as any).apply(target, args);
              armed = false;
              originalPrepare("UPDATE tasks SET agent_state = 'in_progress' WHERE id = ?").run(
                taskId,
              );
              return rows;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chats/cleanup",
        headers: ownerAuth,
        payload: { confirm: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().chats as string[]).not.toContain(topicId);
    } finally {
      (db as any).prepare = originalPrepare;
    }

    const row = db.prepare("SELECT closed_at, archived_at FROM chats WHERE id = ?").get(topicId) as any;
    expect(row.archived_at).toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it("тему карточки в работе не убирают и одиночной архивацией (409)", async () => {
    const { taskId, topicId } = await topic("Одиночная защита");
    db.prepare("UPDATE tasks SET agent_state = 'in_progress' WHERE id = ?").run(taskId);
    const res = await app.inject({
      method: "POST",
      url: `/api/chats/${topicId}/archive`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(409);
    const row = db.prepare("SELECT closed_at FROM chats WHERE id = ?").get(topicId) as any;
    expect(row.closed_at).toBeNull();
  });

  it("уборка без подтверждения ничего не делает, с подтверждением — архивирует кандидатов", async () => {
    const { topicId } = await topic("Убираем");
    db.prepare("UPDATE chats SET updated_at = datetime('now','-3 hours') WHERE id = ?").run(topicId);

    const withoutConfirm = await app.inject({
      method: "POST",
      url: "/api/chats/cleanup",
      headers: ownerAuth,
      payload: {},
    });
    expect(withoutConfirm.statusCode).toBe(400);
    const untouched = db
      .prepare("SELECT archived_at FROM chats WHERE id = ?")
      .get(topicId) as { archived_at: string | null };
    expect(untouched.archived_at).toBeNull();

    const res = await app.inject({
      method: "POST",
      url: "/api/chats/cleanup",
      headers: ownerAuth,
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archived).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare("SELECT closed_at, archived_at FROM chats WHERE id = ?")
      .get(topicId) as { closed_at: string | null; archived_at: string | null };
    expect(row.archived_at).toBeTruthy();
    expect(row.closed_at).toBeTruthy();

    // Убранная тема второй раз в кандидаты не возвращается.
    const again = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: ownerAuth,
    });
    const ids = (again.json().chats as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(topicId);
  });

  it("уборку запускает владелец", async () => {
    const stranger = await reg("CandidatesStranger");
    const res = await app.inject({
      method: "GET",
      url: "/api/chats/cleanup/candidates",
      headers: bearer(stranger.jwt),
    });
    expect(res.statusCode).toBe(403);
  });
});
