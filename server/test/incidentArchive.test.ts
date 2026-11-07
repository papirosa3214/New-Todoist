// server/test/incidentArchive.test.ts
//
// Карточка 6dee5bc3: поломка, чью карточку починки отправили в архив,
// обязана исчезнуть из «Состояния системы» — из ленты уведомлений и из
// сводки поломок, — и не возвращаться, пока та же поломка не возникнет
// снова.
//
// Три причины, по которым запись оставалась (проверено на .110 20.10.2026):
//   1. `archiveTask` (lib/taskArchive.ts) не трогал `notifications` —
//      уведомление типа `incident` лежало в базе навсегда;
//   2. `GET /api/system-state` архивные поломки исключал, но и не сообщал
//      клиенту, какие ключи закрыты — клиенту было нечем убрать строку;
//   3. клиент рисовал строку проверки по `incident_key` закрытой поломки.
//
// Проверки идут через API (app.inject) и напрямую по базе там, где API
// отдаёт другой срез (уведомление по архивной карточке и так не отдаётся
// списком — важно, что оно ЛЕЖИТ в базе).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { raiseIncident } from "../src/lib/incidents.js";
import { purgeTasks } from "../src/lib/taskPurge.js";

const KEY = "test-incident-archive";

describe("архив карточки починки убирает поломку из «Состояния системы»", () => {
  let app: FastifyInstance;
  const owner = () =>
    (db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as any).id as string;
  const headers = () => ({ authorization: "Bearer " + app.jwt.sign({ id: owner() }) });
  const clean = () =>
    purgeTasks(
      (db.prepare("SELECT id FROM tasks WHERE incident_key = ?").all(KEY) as any[]).map(
        (r) => r.id,
      ),
    );

  beforeAll(async () => {
    app = await buildApp();
    clean();
  });
  afterAll(async () => {
    clean();
    await app.close();
  });

  const incidentNotifications = (taskId: string) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE type = 'incident' AND task_id = ?",
        )
        .get(taskId) as any
    ).n;

  it("после архива уведомление о поломке исчезает из базы и из ленты", async () => {
    const raised = raiseIncident({
      key: KEY,
      title: "Проверочная поломка шлюза",
      description: "## Причина\nпроба",
    });
    expect(raised?.created).toBe(true);
    const taskId = raised!.taskId;
    expect(incidentNotifications(taskId)).toBe(1);

    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: headers(),
    });
    expect(archived.statusCode).toBe(200);

    // Главное: уведомление больше не лежит в базе. До правки оно оставалось
    // там навсегда, и клиенты с кэшем уведомлений показывали его до
    // перезагрузки.
    expect(incidentNotifications(taskId)).toBe(0);

    const feed = await app.inject({ method: "GET", url: "/api/notifications", headers: headers() });
    expect(feed.statusCode).toBe(200);
    const inFeed = (feed.json() as any[]).filter(
      (n) => n.type === "incident" && n.task_id === taskId,
    );
    expect(inFeed).toHaveLength(0);
  });

  it("чужие уведомления по той же карточке не трогаются", async () => {
    const raised = raiseIncident({
      key: KEY,
      title: "Проверочная поломка шлюза",
      description: "проверка чужих уведомлений",
    });
    const taskId = raised!.taskId;
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)
       VALUES (?, ?, 'agent_watch', ?, 'наблюдение', NULL)`,
    ).run("watch-" + taskId, owner(), taskId);

    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: headers(),
    });
    expect(archived.statusCode).toBe(200);

    const left = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE id = ?")
      .get("watch-" + taskId) as any;
    expect(left.n).toBe(1);
    db.prepare("DELETE FROM notifications WHERE id = ?").run("watch-" + taskId);
  });

  it("сводка «Состояние системы»: поломки нет, но она помечена закрытой (id + ключ)", async () => {
    const raised = raiseIncident({
      key: KEY,
      title: "Проверочная поломка шлюза",
      description: "проверка сводки",
    });
    const taskId = raised!.taskId;

    const before = await app.inject({ method: "GET", url: "/api/system-state", headers: headers() });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as any;
    expect(beforeBody.incidents.some((i: any) => i.id === taskId)).toBe(true);
    expect((beforeBody.closed ?? []).some((c: any) => c.id === taskId)).toBe(false);

    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: headers(),
    });
    expect(archived.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/system-state", headers: headers() });
    expect(after.statusCode).toBe(200);
    const body = after.json() as any;
    // Открытой поломки в сводке больше нет.
    expect(body.incidents.some((i: any) => i.id === taskId)).toBe(false);
    // Клиенту сказано, что поломка закрыта: id и ключ — по ним он убирает
    // строку сводки, привязанную к этой поломке.
    const closed = (body.closed ?? []).find((c: any) => c.id === taskId);
    expect(closed).toBeTruthy();
    expect(closed.key).toBe(KEY);
    expect(closed.id).toBe(taskId);
  });

  it("та же поломка возникла снова — новая карточка, поломка снова в сводке", async () => {
    const first = raiseIncident({
      key: KEY,
      title: "Проверочная поломка шлюза",
      description: "первое occurrence",
    });
    const firstId = first!.taskId;
    await app.inject({
      method: "POST",
      url: `/api/tasks/${firstId}/archive`,
      headers: headers(),
    });

    const second = raiseIncident({
      key: KEY,
      title: "Проверочная поломка шлюза",
      description: "второе occurrence",
    });
    expect(second?.created).toBe(true);
    const secondId = second!.taskId;
    expect(secondId).not.toBe(firstId);

    const res = await app.inject({ method: "GET", url: "/api/system-state", headers: headers() });
    const body = res.json() as any;
    const live = body.incidents.find((i: any) => i.id === secondId);
    expect(live).toBeTruthy();
    expect(live.key).toBe(KEY);
    // Закрытая поломка осталась помеченной закрытой — клиент по-прежнему
    // различает «старую закрытую» и «новую живую».
    expect((body.closed ?? []).some((c: any) => c.id === firstId)).toBe(true);
  });

  it("карточка без incident_key в закрытые поломки не попадает", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: headers(),
      payload: { title: "Обычная карточка", description: "без поломки" },
    });
    expect(created.statusCode).toBe(200);
    const plainId = (created.json() as any).id as string;
    await app.inject({
      method: "POST",
      url: `/api/tasks/${plainId}/archive`,
      headers: headers(),
    });

    const res = await app.inject({ method: "GET", url: "/api/system-state", headers: headers() });
    const body = res.json() as any;
    expect((body.closed ?? []).some((c: any) => c.id === plainId)).toBe(false);
  });
});
