// Инженер .110 (владелец 14.10.2026): роль заведена миграцией 144, поломки
// «Состояния системы» направляются ей, а не роли, угаданной по тексту.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { allRoles } from "../src/roleRouting.js";

describe("Роль «Инженер .110»", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("роль и её учётка заведены", () => {
    expect(allRoles().some((r) => r.key === "infra_engineer")).toBe(true);
    const user = db.prepare("SELECT name, role_key, type FROM users WHERE id = \x27role_infra_engineer\x27").get() as any;
    expect(user).toEqual({ name: "Инженер .110", role_key: "infra_engineer", type: "ai" });
    const prompt = (db.prepare("SELECT prompt FROM roles WHERE key = \x27infra_engineer\x27").get() as any).prompt as string;
    expect(prompt).toContain("Состояние системы");
    expect(prompt).toContain("mcp__infra__");
    expect(prompt).toContain("taskflow-уведомления");
    expect(prompt).toContain("taskflow_kb_search");
  });
});
