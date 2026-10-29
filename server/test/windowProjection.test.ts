// Проекция ответа для «окна» (владелец, 29.10.2026): телефон — чисто
// окошко, вся переработка JSON делается на сервере.
//
// Проверяется правило, а не детали реализации:
//   • лёгкий ответ (`?projection=list`) отдаёт счётчики вместо подзадач и
//     одну строку описания вместо всего описания;
//   • полный ответ — прежний, и старый клиент (который проекцию не
//     просит) ничего не теряет;
//   • карточка задачи (`GET /api/tasks/:id`) по-прежнему приносит
//     подзадачи целиком — список лёгкий, карточка полная.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import {
  listDescription,
  projectRoleForList,
  projectStepsForList,
  projectionOf,
} from "../src/lib/windowProjection.js";

describe("Проекция ответа: телефон рисует, считает сервер", () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Владелец",
        email: "owner@window-projection.test",
        password: "password123",
      },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    ownerToken = body.token as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it("проекция выбирается из query и по умолчанию полная", () => {
    expect(projectionOf({ projection: "list" })).toBe("list");
    expect(projectionOf({ projection: "full" })).toBe("full");
    expect(projectionOf({})).toBe("full");
    expect(projectionOf(undefined)).toBe("full");
  });

  it("описание для списка — одна строка, как её рисует строка задачи", () => {
    expect(listDescription("первая\nвторая")).toBe("первая вторая");
    expect(listDescription("   ")).toBeNull();
    expect(listDescription(null)).toBeNull();
    const long = "я".repeat(400);
    const cut = listDescription(long) ?? "";
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(241);
  });

  it("шаги для списка: без вывода и аргументов, но с признаками", () => {
    const steps = {
      duration_ms: 10,
      items: [
        { kind: "step", id: "s1", tool: "bash", args: "ls -la", output: "итог" },
        { kind: "thinking", id: "t1", text: "думаю" },
      ],
    };
    const projected = projectStepsForList(steps) as any;
    const step = projected.items[0];
    expect(step.output).toBeUndefined();
    expect(step.args).toBeUndefined();
    expect(step.has_output).toBe(true);
    expect(step.has_args).toBe(true);
    expect(step.tool).toBe("bash");
    // Размышление остаётся: его показывают в окне мыслей.
    expect(projected.items[1].text).toBe("думаю");
    // Полный ответ не тронут.
    expect((steps.items[0] as any).output).toBe("итог");
  });

  it("профиль роли для списка: без промпта, навыков и описаний операций", () => {
    const role = {
      role: "role_analyst",
      title: "Аналитик",
      prompt: "длинный промпт",
      skills: [{ skill_name: "x" }],
      tools_detail: [],
      operations_detail: [],
    };
    const projected = projectRoleForList(role) as any;
    expect(projected.prompt).toBeUndefined();
    expect(projected.skills).toBeUndefined();
    expect(projected.tools_detail).toBeUndefined();
    expect(projected.operations_detail).toBeUndefined();
    expect(projected.has_prompt).toBe(true);
    expect(projected.has_skills).toBe(true);
    expect(projected.title).toBe("Аналитик");
  });

  it("список задач: в лёгкой проекции подзадач нет, в полной — есть", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Задача для проекции" },
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json().task.id as string;

    for (const title of ["Первый шаг", "Второй шаг"]) {
      const sub = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/subtasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { title },
      });
      expect(sub.statusCode).toBe(200);
    }
    const subs = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/subtasks`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(subs.json().length).toBe(2);
    await app.inject({
      method: "PATCH",
      url: `/api/subtasks/${subs.json()[0].id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { done: true },
    });

    const light = await app.inject({
      method: "GET",
      url: "/api/tasks?projection=list",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(light.statusCode).toBe(200);
    const lightTask = light
      .json()
      .find((t: any) => t.id === taskId);
    expect(lightTask).toBeTruthy();
    expect(lightTask.subtasks).toBeUndefined();
    expect(lightTask.subtask_total).toBe(2);
    expect(lightTask.subtask_done).toBe(1);

    // Старый клиент без проекции получает прежний ответ.
    const full = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const fullTask = full
      .json()
      .find((t: any) => t.id === taskId);
    expect(Array.isArray(fullTask.subtasks)).toBe(true);
    expect(fullTask.subtasks.length).toBe(2);
    expect(fullTask.subtask_total).toBe(2);

    // Карточка — полная: подзадачи на месте.
    const card = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(card.statusCode).toBe(200);
    expect(card.json().subtasks.length).toBe(2);
  });
});
