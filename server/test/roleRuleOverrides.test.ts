// Реестр правил: переопределения владельца поверх role-rules.json и GET /api/role-rules.
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { rulesFor } from "../src/lib/roleRules.js";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rules-ov-")), "role-rules.json");
fs.writeFileSync(file, JSON.stringify([
  { id: "A1", text: "- Общее правило", kind: "rule", category: "общий шаблон", roles: "all", channels: ["card", "chat"] },
  { id: "A2", text: "- Только разработчику", kind: "rule", category: "личные инструкции", roles: ["builder"], channels: ["card"] },
  { id: "C1", text: "- Строка из кода", kind: "rule", category: "из кода", roles: "all", channels: ["card"], condition: "x", site: "y" },
]));
process.env.TASKFLOW_ROLE_RULES = file;
const ids = (role: string) => rulesFor(role, "card").map((r) => r.id);

describe("переопределения правил ролей", () => {
  let app: FastifyInstance; let owner: string; let agent: string;
  const reg = async (email: string) => (await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: email, email, password: "password123" } })).json();
  beforeAll(async () => {
    app = await buildApp();
    const o = await reg("owner@rules.test"); db.prepare("UPDATE users SET role='owner' WHERE id=?").run(o.user.id); owner = o.token;
    const a = await reg("ai@rules.test"); db.prepare("UPDATE users SET type='ai' WHERE id=?").run(a.user.id); agent = a.token;
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { db.prepare("DELETE FROM role_rule_overrides").run(); db.prepare("DELETE FROM role_rule_explanations").run(); });

  it("без переопределений отбор прежний", () => {
    expect(ids("builder")).toEqual(["A1", "A2"]);
    expect(ids("qa")).toEqual(["A1"]);
  });

  it("active=1 включает правило вне категорий, active=0 выключает, roles заменяет адресатов", () => {
    db.prepare("INSERT INTO role_rule_overrides(id,active,roles_json,recommended,updated_at) VALUES('C1',1,NULL,0,'t')").run();
    db.prepare("INSERT INTO role_rule_overrides(id,active,roles_json,recommended,updated_at) VALUES('A1',0,NULL,0,'t')").run();
    db.prepare(`INSERT INTO role_rule_overrides(id,active,roles_json,recommended,updated_at) VALUES('A2',NULL,'["qa"]',0,'t')`).run();
    expect(ids("builder")).toEqual(["C1"]);
    expect(ids("qa")).toEqual(["C1", "A2"]); // «из кода» идёт блоком общего шаблона
  });

  it("GET отдаёт роли и правила с флагами; PATCH пишет переопределение; роль не может править", async () => {
    db.prepare("INSERT INTO role_rule_explanations(id,text_hash,explanation,created_at) VALUES('A1',?,'Роль пишет кратко.','t')").run(crypto.createHash("sha256").update("- Общее правило").digest("hex"));
    const res = await app.inject({ method: "GET", url: "/api/role-rules", headers: { authorization: `Bearer ${owner}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.roles)).toBe(true);
    const a1 = body.rules.find((r: any) => r.id === "A1");
    expect(a1).toEqual({ id: "A1", text: "- Общее правило", category: "общий шаблон", roles: "all", channels: ["card", "chat"], where: null, active: true, recommended: false, explanation: "Роль пишет кратко.", delivered_uses: expect.any(Number) });
    expect(body.rules.find((r: any) => r.id === "C1").active).toBe(false);

    const p = await app.inject({ method: "PATCH", url: "/api/role-rules/C1", headers: { authorization: `Bearer ${owner}` }, payload: { active: true, roles: ["builder"], recommended: true } });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ id: "C1", active: true, roles: ["builder"], recommended: true });
    expect(ids("builder")).toContain("C1");

    const denied = await app.inject({ method: "PATCH", url: "/api/role-rules/C1", headers: { authorization: `Bearer ${agent}` }, payload: { active: false } });
    expect(denied.statusCode).toBe(403);
    const missing = await app.inject({ method: "PATCH", url: "/api/role-rules/NOPE", headers: { authorization: `Bearer ${owner}` }, payload: { active: true } });
    expect(missing.statusCode).toBe(404);
  });
});
