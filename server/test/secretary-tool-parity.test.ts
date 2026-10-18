import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { asRole, setInProcessApp, taskflowTools } from "../src/runtime/inProcessRun.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { voiceToolManifest, runVoiceTool } from "../src/lib/secretaryVoiceTools.js";
import { isOwner, isSecretary } from "../src/access.js";
import db from "../src/db.js";

describe("Помощник владельца — единые инструменты чата, голоса и задач", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    setInProcessApp(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it("секретарь распознаётся как помощник владельца, не как обычный агент", () => {
    expect(isSecretary("u-secretary")).toBe(true);
    expect(isOwner("u-secretary")).toBe(true);
  });

  it("общий каталог и голос включают инструменты слотов и архивирования", async () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "chat", runId: "secretary-parity" });
    const chatNames = new Set(catalog.operations.map((tool) => tool.name));
    expect(chatNames.has("taskflow_slot_status")).toBe(true);
    expect(chatNames.has("taskflow_slot_reset")).toBe(true);
    expect(chatNames.has("taskflow_archive")).toBe(true);

    const taskNames = new Set(taskflowTools("secretary", null).map((tool) => tool.name));
    expect(taskNames.has("taskflow_slot_status")).toBe(true);
    expect(taskNames.has("taskflow_archive")).toBe(true);

    // Голос получает один инструмент taskflow; доступность операций проверяется через него.
    const manifest = await voiceToolManifest();
    expect(manifest.map((tool) => tool.name)).toEqual(["taskflow"]);
    const discover = async (query: string) =>
      JSON.parse((await runVoiceTool("u-secretary", "taskflow", { action: "discover", query, limit: 20 })).result as string);
    for (const operation of ["taskflow_slot_status", "taskflow_slot_reset", "taskflow_archive"]) {
      const found = (await discover(operation)).data.operations.filter((entry: { operation: string }) => entry.operation === operation);
      expect(found).toHaveLength(1);
      expect(found[0].available).toBe(true);
    }
  });

  it("слоты и архивные действия доходят до серверных маршрутов; физическое удаление закрыто", async () => {
    await expect(asRole("secretary", "GET", "/api/subtasks/not-a-real-slot/slot-status")).rejects.toThrow("404");

    const ownerId = (db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string }).id;
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    db.prepare("INSERT INTO projects(id,name,owner_id) VALUES(?,?,?)").run(projectId, "Secretary archive test", ownerId);
    db.prepare("INSERT INTO tasks(id,title,creator_id,project_id,status) VALUES(?,?,?,?,?)").run(taskId, "Secretary archive test", ownerId, projectId, "active");

    await asRole("secretary", "POST", "/api/tasks/" + taskId + "/archive", {});
    expect((db.prepare("SELECT archived_at FROM tasks WHERE id=?").get(taskId) as { archived_at: string | null }).archived_at).not.toBeNull();

    await asRole("secretary", "DELETE", "/api/projects/" + projectId);
    expect((db.prepare("SELECT archived_at FROM projects WHERE id=?").get(projectId) as { archived_at: string | null }).archived_at).not.toBeNull();

    await expect(asRole("secretary", "DELETE", "/api/projects/" + projectId + "/purge")).rejects.toThrow("403");
    await expect(asRole("secretary", "DELETE", "/api/tasks/" + taskId)).rejects.toThrow("403");
  });
});
