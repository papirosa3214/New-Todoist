// Чтение плана, зависимостей, дочерних и состава команды — всем ролям (14.10.2026).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { setInProcessApp, taskflowTools } from "../src/runtime/inProcessRun.js";
import { teamReadTools } from "../src/runtime/teamReadTools.js";
import { refreshRoles } from "../src/roleRouting.js";
import { orchestratorTools } from "../src/runtime/orchestratorTools.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

describe("Инструменты чтения для всех ролей", () => {
  let app: any;
  const parent = "team-read-parent", child = "team-read-child";
  const factory = (name: string, _d: string, parameters: any, run: any) => ({ name, run, parameters });
  beforeAll(async () => {
    app = await buildApp(); setInProcessApp(app);
    // Учётки role_* в свежей тестовой БД не заводятся миграциями, а
    // tasks.assignee_id на них ссылается: без сида INSERT задачи падает на
    // внешнем ключе.
    seedRoleAccounts(db);
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,?,?,?)").run("tr-owner", "Owner", "tr-owner@test", "hash", "owner", "human");
    db.prepare("INSERT INTO tasks(id,title,creator_id,status,assignee_id) VALUES(?,?,?,?,?)").run(parent, "Родитель", "tr-owner", "active", "role_builder");
    db.prepare("INSERT INTO tasks(id,title,creator_id,status,parent_id,assignee_id) VALUES(?,?,?,?,?,?)").run(child, "Дочерняя", "tr-owner", "active", parent, "role_builder");
    // Оркестратора заводят миграциями? Нет: роль и учётку role_<ключ> создаёт
    // владелец через POST /api/roles (см. orchestratorTools.test.ts). Без них
    // isOrchestrator(roleUserId("code_orchestrator")) вернёт false и проверка
    // «у оркестратора нет дублей» проверяла бы пустоту, а не поведение.
    db.prepare("INSERT OR IGNORE INTO roles(key,title,summary,enabled,position,prompt) VALUES(?,?,?,?,?,?)").run("code_orchestrator", "Оркестратор", "lead", 1, 20, "coordinate");
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,role_key,type,is_system_bot,permissions) VALUES(?,?,?,?,?,?,?,?,?)").run("role_code_orchestrator", "Оркестратор", "orch-tr@taskflow.local", "!no-login", "agent", "code_orchestrator", "ai", 1, JSON.stringify({ orchestrate: true }));
    refreshRoles();
  });
  afterAll(async () => { await app.close(); });

  it("рабочая роль получает четыре инструмента чтения и читает без отказа", async () => {
    const tools = teamReadTools("builder", factory);
    expect(tools.map((t) => t.name).sort()).toEqual(["taskflow_children", "taskflow_dependencies", "taskflow_plan_read", "taskflow_team_read"]);
    const run = (n: string, p: any) => tools.find((t) => t.name === n)!.run(p);
    expect(Array.isArray((await run("taskflow_team_read", {})).roles)).toBe(true);
    const plan = await run("taskflow_plan_read", { task_id: parent });
    expect(Array.isArray(plan.plans)).toBe(true);
    await run("taskflow_dependencies", { task_id: parent });
    const kids = await run("taskflow_children", { task_id: parent });
    expect(kids).toHaveLength(1);
  });
  it("у Оркестратора свои инструменты, без дублей имён", () => {
    expect(orchestratorTools("code_orchestrator", factory).length).toBeGreaterThan(0);
    expect(teamReadTools("code_orchestrator", factory)).toEqual([]);
    const names = taskflowTools("builder", null).map((t: any) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("taskflow_plan_read");
    expect(orchestratorTools("builder", factory)).toEqual([]);
  });
});