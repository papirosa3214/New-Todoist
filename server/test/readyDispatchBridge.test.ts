// Карточка 5ceda583 — мост «owner поднял ready на задаче без исполнителя»
// → «канонический выбор 8-роли и запуск через единственный Pi runtime».
//
// Дефект: задача с ready_for_pickup=1 и assignee_id=NULL оставалась без
// роли, без agent_inbox, без notifications и без вызова Pi. Существующий
// /api/tasks/:id/enrich мутировал ready_for_pickup прямо в обогащении и
// всегда возвращал architect первым — поэтому его трогать нельзя, нужен
// отдельный маршрут с одной обязанностью.
//
// Контракт:
//   1. PATCH /api/tasks/:id { ready_for_pickup: true } от владельца —
//      поднимает флаг, ничего больше не делает (готовое поведение, см.
//      readyFlag.test.ts).
//   2. POST /api/tasks/:id/dispatch:
//        - требует ready_for_pickup=1 и assignee_id IS NULL, иначе 400/403;
//        - если owner_selected_role на задаче непуст и входит в 8 ролей —
//          побеждает (owner выбирает);
//        - иначе выбирается дефолтная роль (architect);
//        - записывает dispatched_role на задачу, делает её видимой;
//        - ставит assignee_id = единственному Pi runtime;
//        - пишет notifications (assigned) и agent_inbox (event_type=assignment)
//          — оба обязательны, иначе будильник задачу не увидит;
//        - ready_for_pickup НЕ трогает (это ось владельца, не диспетчера).
//   3. PATCH /api/tasks/:id { owner_selected_role } — отдельная ось,
//        только владелец, валидация против ROLE_NAMES; неверное значение → 400.
//   4. trigger.py читает поле role из задачи при запуске. В тесте мы
//      проверяем именно серверную часть контракта — то, что Pi получит
//      нужную роль при вызове handle_task — отдельный вопрос.
//
// Тесты намеренно идут через app.inject (HTTP), без прямого UPDATE: нас
// интересует контракт наружу, и тот же контракт потребляет iOS-клиент и
// веб. Любая короткая дорога через UPDATE — это обход проверок и нарушение
// ровно того инварианта, который мы чиним.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { PI_AGENT_ID, ROLE_NAMES } from "./helpers/dispatch.js";

const PI = PI_AGENT_ID;

describe("Мост dispatch: ready → 8-роль → Pi (5ceda583)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let ownerId: string;
  let strangerAuth: string;

  async function regAndPatch(
    name: string,
    email: string,
    patch?: { role?: string; type?: string },
  ): Promise<{ id: string; jwt: string }> {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    if (patch?.role)
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
        patch.role,
        body.user.id,
      );
    if (patch?.type)
      db.prepare("UPDATE users SET type = ? WHERE id = ?").run(
        patch.type,
        body.user.id,
      );
    return { id: body.user.id as string, jwt: body.token as string };
  }

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  beforeAll(async () => {
    app = await buildApp();
    const owner = await regAndPatch(
      "DispatchOwner",
      `dispatch-owner-${Date.now()}@test`,
      { role: "owner" },
    );
    ownerId = owner.id;
    ownerAuth = bearer(owner.jwt);

    const stranger = await regAndPatch(
      "DispatchStranger",
      `dispatch-stranger-${Date.now()}@test`,
    );
    strangerAuth = bearer(stranger.jwt);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    // Чистим следы предыдущих прогонов: чтобы inbox/notification-счётчики
    // не накапливались между тестами. assignment-события и notifications
    // от старых задач не должны влиять на инварианты ниже.
    db.prepare(
      "DELETE FROM agent_inbox WHERE event_type = 'assignment'",
    ).run();
    db.prepare("DELETE FROM notifications WHERE type = 'assigned'").run();
  });

  /** Создать задачу без исполнителя и поднять владельцу флаг готовности. */
  async function createReadyUnassigned(
    title: string,
    extras: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title, ...extras },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;
    // Флаг ставится прямо в базу, а не через PATCH: с 14.09.2026 поднятие
    // флага владельцем САМО отдаёт задачу исполнителю (владелец: «регулятором
    // выступает флаг»). Тестам ниже нужна карточка готовая, но ещё не
    // отданная, — иначе проверять гейты ручного маршрута не на чем.
    // Автоматический путь проверяется отдельно, в конце файла.
    db.prepare(
      `UPDATE tasks
          SET ready_for_pickup = 1,
              ready_set_at = datetime('now'),
              ready_set_by = ?
        WHERE id = ?`,
    ).run(ownerId, taskId);
    return taskId;
  }

  // ───────────────────────────────────────────────────────────────────
  // 1. Гейты: dispatch без готовности / с чужим флагом / с занятым
  //    assignee — отказ, и состояние задачи НЕ меняется.
  // ───────────────────────────────────────────────────────────────────

  it("dispatch без ready_for_pickup → 400, задача не меняется", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "не готова" },
    });
    const taskId = created.json().task.id as string;
    // ready_for_pickup остаётся 0.

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(400);
    expect(dispatch.json().error).toMatch(/готов(а|ности)/);

    // assignee_id остался NULL, dispatched_role — пусто.
    const row = db
      .prepare(
        "SELECT assignee_id, dispatched_role FROM tasks WHERE id = ?",
      )
      .get(taskId) as { assignee_id: string | null; dispatched_role: string | null };
    expect(row.assignee_id).toBeNull();
    expect(row.dispatched_role).toBeNull();
  });

  it("dispatch от не-владельца → 403", async () => {
    const taskId = await createReadyUnassigned("чужим нельзя");

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: strangerAuth,
    });
    expect(dispatch.statusCode).toBe(403);

    const row = db
      .prepare(
        "SELECT assignee_id, dispatched_role FROM tasks WHERE id = ?",
      )
      .get(taskId) as { assignee_id: string | null; dispatched_role: string | null };
    expect(row.assignee_id).toBeNull();
    expect(row.dispatched_role).toBeNull();
  });

  it("dispatch задачи с занятым assignee_id → 400, чужое назначение не сбивается", async () => {
    // Задача сразу с чужим assignee_id — готовая, но занятая. dispatch
    // не должен её забирать: это была бы подмена уже розданной работы.
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "занята", assignee_id: strangerAuth ? ownerId : ownerId },
    });
    const taskId = created.json().task.id as string;
    // Назначим конкретного постороннего агента:
    const stranger = await regAndPatch(
      "OtherExecutor",
      `dispatch-other-${Date.now()}-${Math.random()}@test`,
      { type: "ai" },
    );
    db.prepare("UPDATE tasks SET assignee_id = ? WHERE id = ?").run(
      stranger.id,
      taskId,
    );
    db.prepare("UPDATE tasks SET ready_for_pickup = 1 WHERE id = ?").run(taskId);

    const before = db
      .prepare(
        "SELECT assignee_id, dispatched_role FROM tasks WHERE id = ?",
      )
      .get(taskId) as { assignee_id: string | null; dispatched_role: string | null };

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(400);
    expect(dispatch.json().error).toMatch(/назначен/);

    const after = db
      .prepare(
        "SELECT assignee_id, dispatched_role FROM tasks WHERE id = ?",
      )
      .get(taskId) as { assignee_id: string | null; dispatched_role: string | null };
    expect(after.assignee_id).toBe(before.assignee_id);
    expect(after.dispatched_role).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────
  // 2. Счастливый путь: дефолтная роль (architect), видимость, Pi, события.
  // ───────────────────────────────────────────────────────────────────

  it("dispatch без owner_selected_role → дефолт (architect), задача у Pi, события созданы", async () => {
    const taskId = await createReadyUnassigned("выбрать слой API");

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(200);
    const body = dispatch.json();
    expect(body.task.dispatched_role).toBe("architect");
    expect(body.task.assignee_id).toBe(PI);
    expect(body.task.dispatched_at).toBeTruthy();
    expect(body.task.dispatched_by).toBe(ownerId);
    // Логическая роль остаётся видимой — это не service-only поле.
    expect(body.task.role).toBe("architect");

    // DB-инварианты: ready_for_pickup остался 1 (не сбит), dispatched_role
    // записан, assignee_id поставлен.
    const row = db
      .prepare(
        `SELECT ready_for_pickup, assignee_id, dispatched_role, dispatched_at, dispatched_by
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as {
      ready_for_pickup: number;
      assignee_id: string;
      dispatched_role: string;
      dispatched_at: string;
      dispatched_by: string;
    };
    expect(row.ready_for_pickup).toBe(1);
    expect(row.assignee_id).toBe(PI);
    expect(row.dispatched_role).toBe("architect");
    expect(row.dispatched_by).toBe(ownerId);

    // Уведомление для Pi (assigned) — иначе будильник задачу не увидит.
    const notif = db
      .prepare(
        `SELECT user_id, type, task_id FROM notifications
          WHERE task_id = ? AND type = 'assigned'`,
      )
      .get(taskId) as
      | { user_id: string; type: string; task_id: string }
      | undefined;
    expect(notif).toBeTruthy();
    expect(notif?.user_id).toBe(PI);

    // inbox-событие event_type=assignment для Pi — второй шов доставки.
    const inbox = db
      .prepare(
        `SELECT to_user_id, task_id, event_type, status FROM agent_inbox
          WHERE task_id = ? AND event_type = 'assignment'`,
      )
      .get(taskId) as
      | {
          to_user_id: string;
          task_id: string;
          event_type: string;
          status: string;
        }
      | undefined;
    expect(inbox).toBeTruthy();
    expect(inbox?.to_user_id).toBe(PI);
    expect(inbox?.event_type).toBe("assignment");
    expect(inbox?.status).toBe("sent");
  });

  // ───────────────────────────────────────────────────────────────────
  // 3. Owner override: owner_selected_role побеждает над дефолтом.
  // ───────────────────────────────────────────────────────────────────

  it("owner_selected_role побеждает: PATCH с ролью + dispatch → выбранная владельцем роль", async () => {
    const taskId = await createReadyUnassigned("выбрать слой API");

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "builder" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.owner_selected_role).toBe("builder");

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(200);
    const body = dispatch.json();
    expect(body.task.dispatched_role).toBe("builder");
    expect(body.task.role).toBe("builder");
  });

  it("owner_selected_role может быть снят (null) — дефолт снова побеждает", async () => {
    const taskId = await createReadyUnassigned("снять выбор");

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "qa" },
    });
    const clear = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: null },
    });
    expect(clear.statusCode).toBe(200);

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json().task.dispatched_role).toBe("architect");
  });

  it("owner_selected_role валидируется против 8 ролей — мусор → 400", async () => {
    const taskId = await createReadyUnassigned("плохая роль");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { owner_selected_role: "wizard" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/рол/i);

    // Мусор в колонку не попал. Пустой она уже не бывает: с 14.09.2026
    // исполнитель подбирается сразу при создании любой задачи, поэтому
    // проверяем не «null», а «осталась допустимой ролью».
    const row = db
      .prepare("SELECT owner_selected_role FROM tasks WHERE id = ?")
      .get(taskId) as { owner_selected_role: string | null };
    expect(row.owner_selected_role).not.toBe("wizard");
    if (row.owner_selected_role !== null) {
      expect(ROLE_NAMES).toContain(row.owner_selected_role);
    }
  });

  it("не-владелец не может задать owner_selected_role → 403", async () => {
    // Сначала заведём постороннего агента и НАЗНАЧИМ ему задачу, чтобы он
    // её видел (мимо getTaskForWrite он иначе получит 404, а нам нужен
    // именно field-level 403 на смене роли — он покрывает ветку «видит,
    // но не владелец»). Это тот же приём, что в readyFlag.test.ts.
    const stranger = await regAndPatch(
      "OtherDispatchAgent",
      `dispatch-other-${Date.now()}-${Math.random()}@test`,
      { type: "ai" },
    );
    const strangerHeaders = bearer(stranger.jwt);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "чужой выбор", assignee_id: stranger.id },
    });
    const taskId = created.json().task.id as string;
    // ready уже поднят через тот же PATCH в общем потоке:
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });

    const denied = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: strangerHeaders,
      payload: { owner_selected_role: "qa" },
    });
    expect(denied.statusCode).toBe(403);

    const row = db
      .prepare("SELECT owner_selected_role FROM tasks WHERE id = ?")
      .get(taskId) as { owner_selected_role: string | null };
    expect(row.owner_selected_role).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────
  // 4. Каждая из 8 ролей проходит как owner_selected_role — граница списка.
  // ───────────────────────────────────────────────────────────────────

  for (const role of ROLE_NAMES) {
    it(`owner_selected_role = "${role}" → dispatched_role = "${role}"`, async () => {
      const taskId = await createReadyUnassigned(`роль ${role}`);

      const patch = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${taskId}`,
        headers: ownerAuth,
        payload: { owner_selected_role: role },
      });
      expect(patch.statusCode).toBe(200);

      const dispatch = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/dispatch`,
        headers: ownerAuth,
      });
      expect(dispatch.statusCode).toBe(200);
      expect(dispatch.json().task.dispatched_role).toBe(role);
      expect(dispatch.json().task.role).toBe(role);
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // 5. Идемпотентность / повторный запуск: повторный dispatch — отказ,
  //    потому что assignee_id уже не NULL. Это та же защита, что у claim.
  // ───────────────────────────────────────────────────────────────────

  it("повторный dispatch → 400, состояние не ломается", async () => {
    const taskId = await createReadyUnassigned("повтор");
    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(second.statusCode).toBe(400);

    const row = db
      .prepare(
        `SELECT assignee_id, dispatched_role, ready_for_pickup FROM tasks WHERE id = ?`,
      )
      .get(taskId) as {
      assignee_id: string;
      dispatched_role: string;
      ready_for_pickup: number;
    };
    expect(row.assignee_id).toBe(PI);
    expect(row.dispatched_role).toBe("architect");
    expect(row.ready_for_pickup).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // 6. Граница со старым enrich: dispatch НЕ должен трогать ready_for_pickup
  //    (это и есть «не вызывать старый enrich» на уровне гарантий).
  // ───────────────────────────────────────────────────────────────────

  it("dispatch не сбрасывает ready_for_pickup — это ось владельца", async () => {
    const taskId = await createReadyUnassigned("флаг должен жить");
    const before = db
      .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as { ready_for_pickup: number };
    expect(before.ready_for_pickup).toBe(1);

    const dispatch = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/dispatch`,
      headers: ownerAuth,
    });
    expect(dispatch.statusCode).toBe(200);

    const after = db
      .prepare("SELECT ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as { ready_for_pickup: number };
    expect(after.ready_for_pickup).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────
  // Флаг владельца сам отдаёт задачу (14.09.2026). Раньше карточка после
  // флага стояла, пока владелец не нажимал «отдать в работу» отдельно.
  // ───────────────────────────────────────────────────────────────────

  it("владелец поднял флаг через API → задача уже у Pi, без отдельной отдачи", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Флаг сам отдаёт задачу" },
    });
    const taskId = created.json().task.id as string;

    const flag = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });
    expect(flag.statusCode).toBe(200);

    const row = db
      .prepare("SELECT assignee_id, dispatched_role, ready_for_pickup FROM tasks WHERE id = ?")
      .get(taskId) as {
      assignee_id: string | null;
      dispatched_role: string | null;
      ready_for_pickup: number;
    };
    expect(row.assignee_id).toBe(PI_AGENT_ID);
    expect(row.dispatched_role).toBeTruthy();
    expect(row.ready_for_pickup).toBe(1);
  });

  it("снятие флага задачу не отдаёт", async () => {
    const taskId = await createReadyUnassigned("Флаг снимается");
    const flag = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: false },
    });
    expect(flag.statusCode).toBe(200);

    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null };
    expect(row.assignee_id).toBeNull();
  });

  it("флаг на задаче с чужим исполнителем его не сбивает", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "Чужой исполнитель и флаг", assignee_id: ownerId },
    });
    const taskId = created.json().task.id as string;

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: ownerAuth,
      payload: { ready_for_pickup: true },
    });

    const row = db
      .prepare("SELECT assignee_id FROM tasks WHERE id = ?")
      .get(taskId) as { assignee_id: string | null };
    expect(row.assignee_id).toBe(ownerId);
  });
});
