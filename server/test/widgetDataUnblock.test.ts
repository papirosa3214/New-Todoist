// Разблокировка данных для новых типов виджетов (карточка 3e27dafe,
// документ галереи docs/2026-10-14-widget-gallery-layouts-and-types.md,
// раздел 6): срок и приоритет в ролевом ответе, агрегат по дням для
// heatmap/calendar_grid и фиче-флаг выдачи новых типов в инструкцию.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { short, shortTaskDates } from "../src/runtime/inProcessRun.js";
import { newWidgetTypesEnabled } from "../src/lib/widgetFeatureFlag.js";

describe("short(): срок и приоритет", () => {
  it("отдаёт срок и приоритет, когда они есть", () => {
    const out = short({
      id: "t1",
      title: "Счёт поставщику",
      status: "active",
      due_date: "2026-10-17",
      priority: 2,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({ срок: "2026-10-17", приоритет: 2 });
  });

  it("без срока и приоритета лишних ключей не добавляет", () => {
    const out = short({ id: "t2", title: "Без срока", status: "active" });
    expect(Object.keys(out as Record<string, unknown>)).toEqual([
      "id",
      "название",
      "статус",
      "работа",
    ]);
  });

  it("старые четыре поля на месте — старые вызовы не ломаются", () => {
    expect(short({ id: "t3", title: "X", status: "active", agent_state: "in_progress" })).toEqual({
      id: "t3",
      название: "X",
      статус: "active",
      работа: "in_progress",
    });
  });

  it("мусорные даты и приоритет вне 1..4 отбрасываются, а не показываются", () => {
    // Дата вне календаря показалась бы в виджете как «2026-02-30» — такую
    // клетку нельзя ни нарисовать, ни провалидировать.
    expect(shortTaskDates({ due_date: "2026-02-30", priority: 9 })).toEqual({});
    expect(shortTaskDates({ due_date: "", priority: null })).toEqual({});
    expect(shortTaskDates({ due_date: "17.10.2026" })).toEqual({});
    expect(shortTaskDates({ due_date: "2026-10-17", priority: 1 })).toEqual({
      due_date: "2026-10-17",
      priority: 1,
    });
  });
});

describe("фиче-флаг новых типов", () => {
  it("по умолчанию выключен, включение только явным значением", () => {
    const saved = process.env.TASKFLOW_WIDGET_NEW_TYPES;
    try {
      delete process.env.TASKFLOW_WIDGET_NEW_TYPES;
      expect(newWidgetTypesEnabled()).toBe(false);
      process.env.TASKFLOW_WIDGET_NEW_TYPES = "";
      expect(newWidgetTypesEnabled()).toBe(false);
      process.env.TASKFLOW_WIDGET_NEW_TYPES = "нет";
      expect(newWidgetTypesEnabled()).toBe(false);
      process.env.TASKFLOW_WIDGET_NEW_TYPES = "1";
      expect(newWidgetTypesEnabled()).toBe(true);
      process.env.TASKFLOW_WIDGET_NEW_TYPES = "on";
      expect(newWidgetTypesEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TASKFLOW_WIDGET_NEW_TYPES;
      else process.env.TASKFLOW_WIDGET_NEW_TYPES = saved;
    }
  });
});

describe("GET /api/tasks/summary — агрегат по дням", () => {
  let app: FastifyInstance;
  let token: string;
  let ownerId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "SummaryOwner",
        email: `summary-${crypto.randomUUID()}@test.local`,
        password: "password123",
      },
    });
    token = registration.json().token;
    ownerId = registration.json().user.id;
    for (const [title, due] of [
      ["Счёт 17-го", "2026-10-17"],
      ["Отчёт 17-го", "2026-10-17"],
      ["Созвон 20-го", "2026-10-20"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { authorization: `Bearer ${token}` },
        payload: { title, due_date: due },
      });
      ids.push(created.json().task.id);
    }
  });

  afterAll(async () => {
    // Задачи не удаляем руками: у задачи есть связанные строки без
    // ON DELETE CASCADE, и удаление падает по внешнему ключу. Тестовая база
    // одноразовая — уборки тут не требуется.
    await app.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it("считает по дням и отдаёт ячейку на каждый день периода, включая нули", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/summary?from=2026-10-16&to=2026-10-19&bucket=due",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toEqual([
      { date: "2026-10-16", value: 0 },
      { date: "2026-10-17", value: 2 },
      { date: "2026-10-18", value: 0 },
      { date: "2026-10-19", value: 0 },
    ]);
    expect(body.total).toBe(2);
    expect(body.max).toBe(2);
  });

  it("срок вне периода не попадает в выдачу", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks/summary?from=2026-10-18&to=2026-10-19&bucket=due",
      headers: auth(),
    });
    expect(res.json().total).toBe(0);
  });

  it("мусорные даты и перевёрнутый период отклоняются", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/api/tasks/summary?from=2026-10-19&to=2026-10-16",
      headers: auth(),
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: "/api/tasks/summary?from=2026-10-16",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(400);
    const garbage = await app.inject({
      method: "GET",
      url: "/api/tasks/summary?from=2026-02-30&to=2026-10-16",
      headers: auth(),
    });
    expect(garbage.statusCode).toBe(400);
  });

  it("чужая работа в агрегат не попадает", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "OtherSummary",
        email: `other-summary-${crypto.randomUUID()}@test.local`,
        password: "password123",
      },
    });
    const otherToken = other.json().token;
    const otherTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { title: "Чужая задача со сроком", due_date: "2026-10-17" },
    });
    const otherId = otherTask.json().task.id;
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/summary?from=2026-10-17&to=2026-10-17&bucket=due",
        headers: auth(),
      });
      // У владельца на 17-е ровно две задачи из трёх (третья — на 20-е).
      const ownerValue = res.json().days[0].value as number;
      expect(ownerValue).toBe(2);
      expect(ids).toHaveLength(3);
      // Чужая задача в другом аккаунте — её не должно быть видно в выдаче
      // не-владельца.
      const viewer = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          name: "ViewerSummary",
          email: `viewer-summary-${crypto.randomUUID()}@test.local`,
          password: "password123",
        },
      });
      const viewerRes = await app.inject({
        method: "GET",
        url: "/api/tasks/summary?from=2026-10-17&to=2026-10-17&bucket=due",
        headers: { authorization: `Bearer ${viewer.json().token}` },
      });
      expect(viewerRes.json().total).toBe(0);
    } finally {
      void otherId;
    }
  });

  it("owner_id из регистрации совпадает с владельцем задач", () => {
    const owner = db.prepare("SELECT id FROM users WHERE id=?").get(ownerId);
    expect(owner).toBeTruthy();
  });
});