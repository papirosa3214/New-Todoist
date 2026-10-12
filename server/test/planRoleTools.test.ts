import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { taskflowTools } from "../src/runtime/inProcessRun.js";

// Достройка плана в рабочем runtime (09.10.2026): каждый слот роли получает
// taskflow_plan_request, и план-запрос привязан к своему subtask_id, а не
// к произвольному чужому. Прежде эти проверки падали на `no such table:
// users` в isOrchestrator(roleUserId(role)) — taskflowTools ходит в
// orchestratorTools ради orchestrator-gated тулзов даже для обычных ролей.
//
// `synthesizer` с 23.09.2026 упразднён как бизнес-роль (его нет в `roles`
// и триггер users_role_key_*_guard запрещает заводить `role_synthesizer`),
// но taskflowTools как чистая функция продолжает работать — тест просто
// проверяет, что для неё тоже выдаётся taskflow_plan_request. Регистрировать
// учётку `role_synthesizer` под schema_triggers нельзя, поэтому
// orchestratorTools и callerOf для неё вернутся через «нет пользователя»
// — этого достаточно для проверки тулсета.
describe("достройка плана в рабочем runtime", () => {
  beforeAll(() => {
    migrate();
    runMigrations();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, password_hash, role, role_key, type, is_system_bot)
       VALUES (?, ?, ?, '!', 'agent', ?, 'ai', 1)`,
    );
    for (const key of [
      "analyst", "architect", "builder", "designer", "researcher",
      "qa", "critic_verifier",
    ]) {
      ins.run(`role_${key}`, `Role ${key}`, `role-${key}@plan-tools.test`, key);
    }
  });

  it.each(["analyst", "architect", "builder", "designer", "researcher", "qa", "critic_verifier", "synthesizer"])("%s получает инструмент в собственном слоте", role => {
    const tools = taskflowTools(role, null, "task", "step");
    expect(tools.map(t => t.name)).toContain("taskflow_plan_request");
    expect(tools.map(t => t.name)).not.toContain("taskflow_claim");
  });
  it("инструмент привязан к текущему слоту, даже если другая подзадача той же роли", async () => {
    const tool = taskflowTools("builder", null, "task", "own").find(t => t.name === "taskflow_plan_request")!;
    await expect(tool.execute("foreign", { subtask_id: "foreign", kind: "add_step", reason: "x", role: "qa", expected_result: "x" })).rejects.toThrow("текущего слота");
  });
});
