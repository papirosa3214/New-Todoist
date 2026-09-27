// GET /api/roles — единый фасад над профилями ролей (раздел 5 спецификации
// от 14.09.2026) и их рабочий статус (раздел 9).
//
// Ручка отдавала только навыки, инструменты и модель. Экран «Команда» не мог
// показать ни промпта, ни учётки роли, ни того, занята ли роль прямо сейчас,
// — и любая карточка роли в интерфейсе показывала бы не то, с чем реально
// стартует исполнитель.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// Каталог профилей Pi подменяем на временный ДО импорта приложения: путь
// читается на уровне модуля. Так тест не зависит от того, что лежит в
// ~/.pi на конкретной машине, и может ломать профиль без риска для рабочих
// файлов владельца.
const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-roles-"));
process.env.TASKFLOW_ROLE_PROFILES_DIR = profilesDir;

const ROLES = [
  "researcher",
  "analyst",
  "critic_verifier",
  "architect",
  "builder",
  "qa",
  "designer",
] as const;

for (const role of ROLES) {
  fs.writeFileSync(
    path.join(profilesDir, `${role}.json`),
    JSON.stringify({
      mcpServers: {
        taskflow: {
          env: { TASKFLOW_MCP_TOOLS: "taskflow_task,taskflow_claim" },
        },
      },
    }),
  );
}

const { buildApp } = await import("../src/index.js");
const { default: db } = await import("../src/db.js");

describe("Профили ролей для экрана «Команда»", () => {
  let app: FastifyInstance;
  let auth: string;
  let ownerId: string;

  const uid = () => crypto.randomUUID();

  const fetchRoles = async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/roles",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    return res.json().roles as any[];
  };

  beforeAll(async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "RolesOwner",
        email: `roles-owner-${Date.now()}@test`,
        password: "password123",
      },
    });
    ownerId = res.json().user.id;
    auth = `Bearer ${res.json().token}`;
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(ownerId);
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(profilesDir, { recursive: true, force: true });
  });

  it("отдаёт ровно восемь ролей с собранным профилем", async () => {
    const roles = await fetchRoles();
    // Восемь с 25.09.2026: миграция 063 включила Секретаря.
    expect(roles).toHaveLength(8);

    for (const r of roles) {
      // Экрану нужно, чем роль подписать и кого ставить исполнителем.
      expect(r.title).toBeTruthy();
      expect(r.role).toBeTruthy();
      // И собранная конфигурация, а не её половина.
      expect(Array.isArray(r.tools)).toBe(true);
      expect(Array.isArray(r.skills)).toBe(true);
      expect(Array.isArray(r.attempt_policy)).toBe(true);
      expect(r).toHaveProperty("prompt");
      expect(r).toHaveProperty("model");
      expect(r).toHaveProperty("permissions");
      expect(r).toHaveProperty("current_task");
      expect(["ready", "working", "blocked", "unavailable"]).toContain(
        r.status,
      );
      // Статус подписан по-русски — владелец читает его как есть.
      expect(r.status_title).toBeTruthy();
    }
  });

  it("остановленный исполнитель не считается проблемой каждой роли", async () => {
    // Причина одна на все восемь. Размноженная по строкам, она читается
    // как восемь разных поломок, и экран краснеет целиком там, где чинить
    // надо ровно одно и в другом месте. Поэтому живость исполнителя —
    // отдельное поле, а problems описывают только саму роль.
    const roles = await fetchRoles();
    for (const r of roles) {
      expect(r).toHaveProperty("runtime_ready");
      expect(
        (r.problems as string[]).some((p) => p.includes("исполнитель")),
      ).toBe(false);
    }

    // При этом роль без работающего исполнителя честно недоступна: врать
    // «Готова» и оставить владельца ждать работу, которая не начнётся,
    // нельзя.
    const остановлен = roles.filter((r) => !r.runtime_ready);
    for (const r of остановлен) {
      expect(r.status).toBe("unavailable");
    }
  });

  it("имя роли берётся из учётки, а не из словаря в коде", async () => {
    // Владелец переименует роль в одном месте — экран подхватит.
    const roles = await fetchRoles();
    const designer = roles.find((r) => r.role === "designer");
    const account = db
      .prepare("SELECT name FROM users WHERE role_key = 'designer' LIMIT 1")
      .get() as { name: string } | undefined;
    if (account) expect(designer.title).toBe(account.name);
  });

  it("сломанный профиль одной роли не роняет остальные семь", async () => {
    // Раньше отсутствие файла профиля обрушивало ручку целиком, и экран
    // «Команда» оставался пустым вместо одной проблемной строки.
    const broken = path.join(profilesDir, "qa.json");
    const backup = fs.readFileSync(broken, "utf8");
    // Испорченный, а не удалённый: профиля может не быть вовсе у роли,
    // заведённой с экрана «Команда», — это не поломка.
    fs.writeFileSync(broken, "{}");
    try {
      const roles = await fetchRoles();
      expect(roles).toHaveLength(8);

      const qa = roles.find((r) => r.role === "qa");
      expect(qa.status).toBe("unavailable");
      expect(qa.problems.join(" ")).toContain("MCP-профиль");

      // Остальные не пострадали и видны на экране.
      const другие = roles.filter((r) => r.role !== "qa");
      expect(другие).toHaveLength(7);
      for (const r of другие) {
        // Сверяем сам текст: toContain с матчером на массиве строк
        // проходит всегда и проверял бы ничего.
        expect(
          (r.problems as string[]).some((p) => p.includes("MCP-профиль")),
        ).toBe(false);
        // И конфигурация у них осталась собранной.
        expect(r.tools.length).toBeGreaterThan(0);
      }
    } finally {
      fs.writeFileSync(broken, backup);
    }
  });

  it("роль показывает карточку, которой занята прямо сейчас", async () => {
    // Статус читается по dispatched_role — колонке, которую заполняет
    // диспетчер. По assignee_id его не определить: исполнитель у всех
    // восьми ролей один и тот же Pi.
    const taskId = uid();
    db.prepare(
      `INSERT INTO tasks (id, title, status, creator_id, dispatched_role, agent_state)
       VALUES (?, 'Занятая карточка', 'active', ?, 'builder', 'in_progress')`,
    ).run(taskId, ownerId);

    try {
      const roles = await fetchRoles();
      const builder = roles.find((r) => r.role === "builder");
      expect(builder.current_task?.id).toBe(taskId);
      expect(builder.current_task?.title).toBe("Занятая карточка");

      // Статус «Работает» — только когда исполнитель вообще жив. Если
      // служба автономки остановлена, роль честно недоступна, и это не
      // повод показывать её занятой.
      expect(["working", "unavailable"]).toContain(builder.status);
    } finally {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    }
  });
});
