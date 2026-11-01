import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { demoteSeededOwner, seedRoleAccounts } from "./helpers/seedOwner.js";
import { roleHome } from "../src/runtime/roleHome.js";

// Навыки миссии (владелец 01.11.2026): реестр + срок жизни.
// Механика «роль пишет навык» уже есть (roleHome.ts), не хватало учёта:
// чей навык, зачем и когда его снять — иначе навык одной задачи навсегда
// остаётся в папке роли и влияет на все её будущие задачи.
describe("навыки миссии: реестр и срок жизни", () => {
  let app: FastifyInstance;
  let ownerAuth: string;
  let taskId: string;
  const role = "analyst";
  const name = `test-mission-skill-${crypto.randomUUID().slice(0, 8)}`;
  const skillDir = path.join(roleHome(role).skills, name);

  beforeAll(async () => {
    app = await buildApp();
    demoteSeededOwner(db);
    seedRoleAccounts(db);
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Skills owner", email: `skills-${Date.now()}@test`, password: "password123" } });
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(reg.json().user.id);
    ownerAuth = `Bearer ${reg.json().token}`;
    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { authorization: ownerAuth }, payload: { title: "Навыки миссии " + crypto.randomUUID() } });
    taskId = created.json().task.id as string;
  });

  afterAll(async () => {
    // Уборка: навык не должен остаться в живой папке роли.
    try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch { /* уже убран */ }
    await app.close();
  });

  it("навык миссии записывается в папку роли и попадает в реестр", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth },
      payload: { role, name, description: "Приёмка результата по контракту ассерций. Применяй, когда проверяешь ассерции миссии. Не применяй, если проверку ведёт критик.", body: "# Порядок проверки\n1. Открыть сценарий.\n2. Сверить с ассерцией." },
    });
    expect(res.statusCode).toBe(201);
    const skill = res.json().skill;
    expect(skill.name).toBe(name);
    expect(skill.role).toBe(role);
    expect(skill.released_at).toBeNull();

    // Файл навыка — в папке роли, шапка в формате SKILL-FORMAT.md.
    const file = path.join(skillDir, "SKILL.md");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("---")).toBe(true);
    expect(text).toContain(`name: ${name}`);
    expect(text).toContain("description:");

    const listed = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth } })).json().skills;
    expect(listed.map((s: { name: string }) => s.name)).toEqual([name]);
  });

  it("кривое имя или пустое описание отклоняются", async () => {
    const bad = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth }, payload: { role, name: "Плохое Имя", description: "х" } });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth }, payload: { role, name: "ok-name", description: "" } });
    expect(empty.statusCode).toBe(400);
  });

  it("снятие навыка убирает его из папки роли и помечает в реестре", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth }, payload: { role, name } });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(skillDir)).toBe(false);
    const row = db.prepare("SELECT released_at FROM mission_skills WHERE task_id = ? AND role = ? AND name = ?").get(taskId, role, name) as { released_at: string | null };
    expect(row.released_at).toBeTruthy();
    const listed = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}/mission-skills`, headers: { authorization: ownerAuth } })).json().skills;
    expect(listed).toEqual([]);
  });
});
