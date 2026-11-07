// Гейт формата ответов ролей через настоящие HTTP-маршруты — карточка
// cea8d997, критерий приёмки «живой прогон».
//
// roleFormat.test.ts проверяет сам разбор текста блока. Этот файл проверяет
// другое: что гейт действительно стоит в тех маршрутах, куда сервер
// принимает текст роли (результат шага, комментарий, описание задачи), что
// очевидное заменяется автоматически, а неверный блок доходит до роли с
// текстом ошибки и образцом — и что текст владельца сервер не переписывает.
//
// Фикстура повторяет путь роли: владелец заводит карточку, план со слотом
// исполнителя утверждает, роль работает в своём шаге.
import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("../src/runtime/inProcessRun.js", async original => ({
  ...(await original<any>()),
  runRoleInProcess: vi.fn(async () => ({
    runId: "gate-test",
    completion: Promise.resolve(),
  })),
}));

import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { roleUserId } from "../src/roleRouting.js";
import { seedRoleAccounts, demoteSeededOwner } from "./helpers/seedOwner.js";

const TABLE = [
  "| Проверка | Результат |",
  "| --- | --- |",
  "| tsc | чисто |",
  "| тесты | 12/12 |",
].join("\n");

const METRICS = ["Задач: 12", "Проверок: 7", "Дефектов: 0"].join("\n");

const BROKEN = [
  "```widget",
  '{"type":"heatmap","weeks":12,"cells":[{"date":"2026-10-14","value":7,"max":9}],"max":9}',
  "```",
].join("\n");

describe("Гейт формата роли в маршрутах сервера", () => {
  let app: any;
  let owner: string;
  let builder: string;
  let project: string;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const u = (
      await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          name: "Gate owner",
          email: crypto.randomUUID() + "@test",
          password: "password123",
        },
      })
    ).json();
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(u.user.id);
    owner = "Bearer " + u.token;
    builder = "Bearer " + app.jwt.sign({ id: roleUserId("builder") });
    project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { authorization: owner },
        payload: { name: "Gate project " + crypto.randomUUID() },
      })
    ).json().id;
  });

  /** Карточка с планом: у роли есть свой шаг, который она ведёт. */
  async function fixture() {
    const task = (
      await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { authorization: owner },
        payload: {
          title: "Формат ответа роли " + crypto.randomUUID(),
          project_id: project,
        },
      })
    ).json().task;
    const plan = (
      await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/collaboration-plans`,
        headers: { authorization: owner },
        payload: {
          profile: "manual",
          nodes: [
            {
              slot_key: "build",
              role_key: "builder",
              expected_result: "Результат работы",
            },
          ],
          edges: [],
        },
      })
    ).json().plan;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/integration-responsibility`,
      headers: { authorization: owner },
      payload: { mode: "manual", owner_id: roleUserId("architect") },
    });
    await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/collaboration-plans/${plan.id}/approve`,
      headers: { authorization: owner },
      payload: {},
    });
    const step = db
      .prepare("SELECT * FROM subtasks WHERE task_id=? AND plan_node_key='build'")
      .get(task.id) as any;
    // Роль — исполнитель карточки: без этого правка описания у неё 404
    // (getTaskForWrite для агента — создатель или назначенный).
    db.prepare("UPDATE tasks SET assignee_id=? WHERE id=?").run(
      roleUserId("builder"),
      task.id,
    );
    return { task, step };
  }

  it("результат шага: текстовая таблица сохраняется блоком table", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${f.step.id}`,
      headers: { authorization: builder },
      payload: { result: TABLE },
    });
    expect(res.statusCode).toBe(200);
    const stored = (
      db.prepare("SELECT result FROM subtasks WHERE id=?").get(f.step.id) as any
    ).result as string;
    expect(stored).toContain('"type": "table"');
    expect(stored).not.toContain("| --- | --- |");
  });

  it("результат шага: битый блок — 400 с текстом ошибки и образцом", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${f.step.id}`,
      headers: { authorization: builder },
      payload: { result: BROKEN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("role_format");
    expect(res.json().error).toContain("cells[0]");
    expect(res.json().error).toContain("```widget");
    const stored = (
      db.prepare("SELECT result FROM subtasks WHERE id=?").get(f.step.id) as any
    ).result;
    expect(stored ?? "").toBe("");
  });

  it("описание задачи: ряд «название: число» превращается в метрики", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${f.task.id}`,
      headers: { authorization: builder },
      payload: { description: METRICS },
    });
    expect(res.statusCode).toBe(200);
    const stored = (
      db.prepare("SELECT description FROM tasks WHERE id=?").get(f.task.id) as any
    ).description as string;
    expect(stored).toContain('"type": "metrics"');
    expect(stored).not.toContain("Дефектов: 0");
  });

  it("описание задачи: неизвестный тип блока — 400 и отказ", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${f.task.id}`,
      headers: { authorization: builder },
      payload: {
        description: "```widget\n" + '{"type":"unknown_thing","items":[]}' + "\n```",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("role_format");
  });

  it("комментарий карточки: текстовая таблица сохраняется блоком table", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${f.task.id}/comments`,
      headers: { authorization: builder },
      payload: { text: TABLE },
    });
    expect(res.statusCode).toBe(200);
    const row = db
      .prepare(
        "SELECT text FROM comments WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(f.task.id) as any;
    expect(String(row?.text ?? "")).toContain('"type": "table"');
  });

  it("текст владельца сервер не переписывает", async () => {
    const f = await fixture();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${f.task.id}`,
      headers: { authorization: owner },
      payload: { description: TABLE },
    });
    expect(res.statusCode).toBe(200);
    const stored = (
      db.prepare("SELECT description FROM tasks WHERE id=?").get(f.task.id) as any
    ).description as string;
    expect(stored).toContain("| Проверка | Результат |");
    expect(stored).not.toContain('"type": "table"');
  });
});