// Запись роли в память (карточка f044ef1a, этап work_2):
//   1) taskflow_remember — в ядре, роль видит его без taskflow_tools;
//   2) scope=role работает: ключ роли сервер берёт из учётки, а не из
//      аргументов (поля role_key в схеме инструмента нет и не нужно).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { setInProcessApp } from "../src/runtime/inProcessRun.js";
import { chatTools } from "../src/runtime/chatTools.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { allRoles } from "../src/roleRouting.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

describe("запись роли в память", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    setInProcessApp(app);
    seedRoleAccounts(db);
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it("память роли — в активной группе taskflow_memory, прежние имена в реестре", () => {
    for (const role of allRoles()) {
      const catalog = buildRoleToolCatalog({ role: role.key, mode: "work", runId: "remember-core" });
      expect(catalog.activeNames, role.key).toContain("taskflow_memory");
      expect(catalog.registeredNames, role.key).toContain("taskflow_remember");
      expect(catalog.registeredNames, role.key).toContain("taskflow_recall");
    }
  });

  it("scope=role: ключ роли берётся из учётки, даже если в users.role_key пусто", async () => {
    // Учётка роли без users.role_key — как в живой базе до миграций:
    // прежде такой запрос падал с 400 «для памяти роли нужен role_key».
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type, is_system_bot, initials)
       VALUES ('role_ghost', 'Ghost', 'ghost@taskflow.local', '', 'agent', 'ai', 1, 'G')`,
    ).run();
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: { authorization: `Bearer ${app.jwt.sign({ id: "role_ghost" })}` },
      payload: { text: "Учётка роли без role_key пишет в память своей роли", scope: "role", kind: "lesson" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().memory).toMatchObject({ scope: "role", role_key: "ghost" });
  });

  it("роль не пишет в память чужой роли — отказ объясняет, а не затирает молча", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/memories",
      headers: { authorization: `Bearer ${app.jwt.sign({ id: "role_ghost" })}` },
      payload: { text: "Попытка записать в чужую память роли", scope: "role", role_key: "qa" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("своей роли");
  });

  it("роль пишет в память своей роли инструментом и читает её обратно", async () => {
    const tool = chatTools("researcher").find((t) => t.name === "taskflow_remember")!;
    expect(tool).toBeDefined();
    const out = JSON.parse((await tool.execute("call-1", { text: "Исследователь помнит: память роли пишется сама" })).content[0].text);
    expect(out.итог).toBe("запомнил");
    const row = db.prepare("SELECT scope, role_key FROM memories WHERE id = ?").get(out.id) as { scope: string; role_key: string };
    expect(row).toMatchObject({ scope: "role", role_key: "researcher" });
  });
});
