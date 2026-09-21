// Флаг «нужно глубокое исследование» (миграция 052) и запуск серверного
// конвейера `POST /api/tasks/:id/research`.
//
// Контракт:
//   1. `needs_research` — обычное поле карточки: PATCH его пишет, GET отдаёт.
//      По умолчанию 0 (старые задачи не помечены).
//   2. Запуск исследования — только владелец (403 остальным).
//   3. Без поднятого флага — 400: конвейер не должен гоняться за источниками
//      по рабочим пустякам.
//   4. С флагом владелец получает 200 { started: true }.
//
// Тест идёт через app.inject (HTTP) — нас интересует контракт наружу, тот же,
// что потребляют iOS и веб. Сам конвейер подменяется `/bin/true` через
// RESEARCH_PIPELINE_SCRIPT, чтобы тест не поднимал реальный обход.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";

describe("Флаг глубокого исследования и запуск конвейера (052)", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let strangerAuth: string;

  async function reg(
    name: string,
    email: string,
    role?: string,
  ): Promise<{ id: string; jwt: string }> {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name, email, password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const body = reg.json();
    if (role) {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(
        role,
        body.user.id,
      );
    }
    return { id: body.user.id as string, jwt: body.token as string };
  }

  const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  beforeAll(async () => {
    // Шов: вместо настоящего конвейера — no-op, читается в обработчике.
    process.env.RESEARCH_PIPELINE_SCRIPT = "/bin/true";
    app = await buildApp();
    ownerAuth = bearer(
      (await reg("ResearchOwner", `research-owner-${Date.now()}@test`, "owner"))
        .jwt,
    );
    strangerAuth = bearer(
      (await reg("ResearchStranger", `research-stranger-${Date.now()}@test`))
        .jwt,
    );
  });

  afterAll(async () => {
    delete process.env.RESEARCH_PIPELINE_SCRIPT;
    if (app) await app.close();
  });

  async function createTask(title: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title },
    });
    expect(created.statusCode).toBe(200);
    return created.json().task.id as string;
  }

  it("по умолчанию флаг снят", async () => {
    const id = await createTask("исследование по умолчанию");
    const got = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().needs_research ? 1 : 0).toBe(0);
  });

  it("создание задачи с флагом сохраняет его", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: ownerAuth,
      payload: { title: "создана с флагом", needs_research: true },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().task.id as string;
    const got = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
    });
    expect(got.json().needs_research ? 1 : 0).toBe(1);
  });

  it("PATCH поднимает и снимает флаг", async () => {
    const id = await createTask("исследование с флагом");
    const on = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
      payload: { needs_research: true },
    });
    expect(on.statusCode).toBe(200);

    const got = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
    });
    expect(got.json().needs_research ? 1 : 0).toBe(1);

    const off = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
      payload: { needs_research: false },
    });
    expect(off.statusCode).toBe(200);
    const got2 = await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
    });
    expect(got2.json().needs_research ? 1 : 0).toBe(0);
  });

  it("без флага исследование не запускается → 400", async () => {
    const id = await createTask("без флага");
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/research`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("запуск не владельцем → 403", async () => {
    const id = await createTask("чужой запуск");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
      payload: { needs_research: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/research`,
      headers: strangerAuth,
    });
    expect(res.statusCode).toBe(403);
  });

  it("владелец с флагом получает запуск → 200", async () => {
    const id = await createTask("запуск исследования");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${id}`,
      headers: ownerAuth,
      payload: { needs_research: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${id}/research`,
      headers: ownerAuth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().started).toBe(true);
  });
});
