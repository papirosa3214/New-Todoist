// Отказ в комментарии объясняет роли, что делать дальше (19.10.2026):
// голый 404 «Not found» роли читали как «нет доступа» и жаловались владельцу.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");
const { demoteSeededOwner, seedRoleAccounts } = await import("./helpers/seedOwner.js");

describe("отказ в комментарии", () => {
  let app: FastifyInstance;
  const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });
  const comment = (id: string, taskId: string) =>
    app.inject({ method: "POST", url: `/api/tasks/${taskId}/comments`, headers: as(id), payload: { text: "проверка" } });
  const human = `cr-human-${Date.now()}`;
  const live = `cr-live-${Date.now()}`;
  const archived = `cr-arch-${Date.now()}`;

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,'Чужой','" + human + "@test','!','viewer','human')").run(human);
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, 'Живая карточка без шага роли')").run(live);
    db.prepare("INSERT INTO tasks (id, title, archived_at) VALUES (?, 'Архивная', datetime('now'))").run(archived);
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it("роль без открытого шага получает 403 с причиной и следующим шагом", async () => {
    const res = await comment("role_analyst", live);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("открытого шага нет");
    expect(res.json().error).toContain("taskflow_my_tasks");
  });

  it("архивная карточка — 409 с объяснением", async () => {
    const res = await comment("role_analyst", archived);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("в архиве");
  });

  it("несуществующая карточка и чужой человек — по-прежнему 404 без подробностей", async () => {
    expect((await comment("role_analyst", "нет-такой")).statusCode).toBe(404);
    const res = await comment(human, live);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not found");
  });
});
