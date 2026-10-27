import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {isOwner,isSecretary} from "../src/access.js";
import { asRole, setInProcessApp } from "../src/runtime/inProcessRun.js";
import { buildRoleToolCatalog } from "../src/runtime/roleToolCatalog.js";
import { voiceToolManifest, runVoiceTool, plainVoiceSchema, decodeVoiceArguments, closeAllVoiceTools } from "../src/lib/secretaryVoiceTools.js";
vi.mock("../src/runtime/composioRuntime.js",()=>({connectRoleComposio:async()=>({tools:[],close:async()=>{}})}));
vi.mock("../src/runtime/graftMcp.js",()=>({connectRoleMcp:async()=>({tools:[],close:async()=>{}})}));
describe("voice native tool parity",()=>{
 let app:Awaited<ReturnType<typeof buildApp>>;
 beforeAll(async()=>{app=await buildApp();setInProcessApp(app);});
 afterAll(async()=>{await closeAllVoiceTools();await app.close();});
 it("publishes the chat core and loader, without the universal gateway",async()=>{
  const chat=buildRoleToolCatalog({role:"secretary",mode:"work",runId:"parity",executionMode:"chat"});
  const manifest=await voiceToolManifest();
  expect(manifest.map(t=>t.name).sort()).toEqual([...chat.activeNames].sort());
  expect(manifest.some(t=>t.name==="taskflow")).toBe(false);
  expect(manifest.find(t=>t.name==="taskflow_task")!.parameters.properties.id.type).toBe("string");
 });
 it("loads an operation and returns its callable schema for the next voice turn",async()=>{
  const result=await runVoiceTool("u1","taskflow_tools",{names:["taskflow_archive"]},{sessionId:"loader-test"} as any);
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.result).activated).toContain("taskflow_archive");
  expect((result as any).tools.some((t:any)=>t.name==="taskflow_archive")).toBe(true);
 });
 it("executes native arguments directly and propagates a real missing-task refusal",async()=>{
  await expect(runVoiceTool("u1","taskflow_task",{id:"voice-missing-task"},{sessionId:"read-test"} as any)).rejects.toThrow();
 });
 it("rejects the old universal tool instead of advertising a different protocol",async()=>{
  await expect(runVoiceTool("u1","taskflow",{action:"discover"})).rejects.toThrow();
 });
 it("does not execute calls by non-owners",async()=>{
  await expect(runVoiceTool("not-owner","taskflow_tools",{})).rejects.toThrow("владелец");
 });
 it("rejects invalid native parameters before execution",async()=>{
  await expect(runVoiceTool("u1","taskflow_task",{id:123})).rejects.toThrow("INVALID_ARGUMENTS");
 });

 it("retains loaded tools in the next request of the same call",async()=>{
  const context={sessionId:"persist-test"};
  await runVoiceTool("u1","taskflow_tools",{names:["taskflow_archive"]},context);
  expect((await voiceToolManifest("u1",context)).some(t=>t.name==="taskflow_archive")).toBe(true);
 });
 it("cannot load card-only operations in chat mode",async()=>{
  const result=await runVoiceTool("u1","taskflow_tools",{names:["taskflow_create_task"]},{sessionId:"chat-mode"});
  expect(JSON.parse(result.result).unknown).toContain("taskflow_create_task");
  await expect(runVoiceTool("u1","taskflow_create_task",{}, {sessionId:"chat-mode"})).rejects.toThrow();
 });
 it("keeps structured records and arrays through Gemini transport",()=>{
  const schema={type:"object",required:["items","headers"],properties:{
   items:{type:"array",items:{type:"object",properties:{id:{type:"integer"}},required:["id"]}},
   headers:{type:"object",additionalProperties:{type:"string"}},
   count:{type:"integer",minimum:1,maximum:20},
  }};
  const wire=plainVoiceSchema(schema);
  expect(wire.required).toEqual(["items","headers"]);
  expect(wire.properties.items.items.properties.id.type).toBe("integer");
  expect(wire.properties.headers.type).toBe("string");
  expect(wire.properties.count).toMatchObject({minimum:1,maximum:20});
  expect(decodeVoiceArguments(schema,{items:[{id:7}],headers:'{"key":"value"}',count:2})).toEqual({items:[{id:7}],headers:{key:"value"},count:2});
 });
  it("секретарь распознаётся как помощник владельца, не как обычный агент", () => {
    expect(isSecretary("u-secretary")).toBe(true);
    expect(isOwner("u-secretary")).toBe(true);
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
