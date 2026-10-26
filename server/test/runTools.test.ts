import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { registerRunTools } from "../src/runtime/runToolRegistry.js";

const BRIDGE = path.resolve(__dirname, "../scripts/run-mcp-bridge.mjs");
let app: FastifyInstance;
let base = "";
const calls: any[] = [];
const tools = [
  {
    name: "taskflow_subtask_done",
    description: "Сдать шаг",
    parameters: { type: "object", properties: { subtask_id: { type: "string" } }, required: ["subtask_id"] },
    execute: async (_id: string, args: any) => {
      calls.push(args);
      return { content: [{ type: "text", text: `шаг ${args.subtask_id} сдан` }] };
    },
  },
  {
    name: "taskflow_state",
    description: "Состояние",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("нельзя");
    },
  },
];
const token = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ id })}` });

beforeAll(async () => {
  app = await buildApp();
  seedRoleAccounts(db);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
});

describe("операции запуска для внешнего агента: один набор через MCP", () => {
  it("список и вызов — только участнику своего запуска", async () => {
    const off = registerRunTools("run-a", "role_builder", tools as any);
    const list = await app.inject({ method: "GET", url: "/api/runs/run-a/tools", headers: token("role_builder") });
    expect(list.statusCode).toBe(200);
    expect(list.json().tools.map((t: any) => t.name)).toEqual(["taskflow_subtask_done", "taskflow_state"]);
    expect(list.json().tools[0].inputSchema.required).toEqual(["subtask_id"]);

    const ok = await app.inject({
      method: "POST",
      url: "/api/runs/run-a/tools/taskflow_subtask_done",
      headers: token("role_builder"),
      payload: { arguments: { subtask_id: "s1" } },
    });
    expect(ok.json()).toMatchObject({ isError: false, content: [{ type: "text", text: "шаг s1 сдан" }] });

    const failed = await app.inject({ method: "POST", url: "/api/runs/run-a/tools/taskflow_state", headers: token("role_builder"), payload: { arguments: {} } });
    expect(failed.json()).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("нельзя") }] });

    const stranger = await app.inject({ method: "GET", url: "/api/runs/run-a/tools", headers: token("role_qa") });
    expect(stranger.statusCode).toBe(404);
    off();
    const gone = await app.inject({ method: "GET", url: "/api/runs/run-a/tools", headers: token("role_builder") });
    expect(gone.statusCode).toBe(404);
  });

  it("stdio-мост отвечает агенту по MCP: initialize, tools/list, tools/call", async () => {
    const off = registerRunTools("run-b", "role_builder", tools as any);
    const proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, TASKFLOW_API: base, TASKFLOW_RUN_ID: "run-b", TASKFLOW_TOKEN: app.jwt.sign({ id: "role_builder" }) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map<number, any>();
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      }
    });
    const send = async (id: number | null, method: string, params: any = {}) => {
      proc.stdin.write(JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }) + "\n");
      if (id === null) return null;
      for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 20));
      return replies.get(id);
    };
    const init = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.capabilities.tools).toBeDefined();
    await send(null, "notifications/initialized");
    const list = await send(2, "tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toContain("taskflow_subtask_done");
    const call = await send(3, "tools/call", { name: "taskflow_subtask_done", arguments: { subtask_id: "s9" } });
    expect(call.result).toMatchObject({ isError: false, content: [{ type: "text", text: "шаг s9 сдан" }] });
    expect(calls.at(-1)).toEqual({ subtask_id: "s9" });
    proc.kill();
    off();
  });
});
