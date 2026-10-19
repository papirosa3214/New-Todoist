import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { asRole, setInProcessApp } from "../src/runtime/inProcessRun.js";
import * as catalogModule from "../src/runtime/roleToolCatalog.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { runVoiceTool, voiceToolManifest } from "../src/lib/secretaryVoiceTools.js";
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

  it("голос публикует ровно тот универсальный taskflow, который собирает каталог чата", async () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "work", runId: "secretary-parity" });
    const universal = catalog.customTools.find((tool) => tool.name === "taskflow");
    expect(universal).toBeDefined();
    expect(catalog.operations.some((tool) => tool.name === "taskflow_slot_status")).toBe(true);
    expect(catalog.operations.some((tool) => tool.name === "taskflow_archive")).toBe(true);

    const manifest = await voiceToolManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].name).toBe("taskflow");
    expect(manifest[0].description).toBe(universal!.description);
    expect(manifest[0].parameters.properties.action).toEqual({ type: "string", enum: ["discover", "describe", "invoke"] });
    expect(manifest[0].parameters.properties.request_id).toMatchObject({ type: "string" });
    expect(manifest[0].parameters.properties.arguments).toMatchObject({ type: "string" });
  });

  it("голос передаёт вызов в универсальный execute и сохраняет его error envelope и request_id", async () => {
    const ownerId = "u-secretary";
    const requestId = "voice-contract-probe-20261019";
    const response = await runVoiceTool(ownerId, "taskflow", {
      action: "invoke", operation: "taskflow_task", version: 1,
      arguments: "{\"id\":\"voice-contract-missing-task\"}", request_id: requestId,
    });
    expect(response.ok).toBe(true);
    const envelope = JSON.parse(response.result);
    expect(envelope).toMatchObject({
      ok: false,
      operation: "taskflow_task",
      request_id: requestId,
      error: { code: "OPERATION_FAILED", hint: expect.any(String) },
    });
  });

  it("не обрезает большой JSON общего инструмента на границе 12000 символов", async () => {
    const payload = { ok: true, data: { notes: "x".repeat(15000) } };
    const spy = vi.spyOn(catalogModule, "buildRoleToolCatalog").mockReturnValue({
      customTools: [{ name: "taskflow", execute: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }) }],
    } as any);
    try {
      const response = await runVoiceTool("u-secretary", "taskflow", { action: "invoke" });
      expect(JSON.parse(response.result)).toEqual(payload);
    } finally { spy.mockRestore(); }
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
