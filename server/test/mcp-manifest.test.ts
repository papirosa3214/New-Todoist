import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

describe("GET /api/mcp/manifest — что получает MCP-клиент при подключении", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "McpViewer", email: "mcp@manifest.test", password: "password123" },
    });
    token = reg.json().token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("отдаёт инструкцию и инструменты из mcp_server.py", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/manifest",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instructions).toContain("taskflow_claim");
    expect(body.tools.length).toBeGreaterThan(10);
    const claim = body.tools.find((t: { name: string }) => t.name === "taskflow_claim");
    expect(typeof claim.description).toBe("string");
    expect(claim.inputSchema).toBeUndefined();
  });

  it("без входа — 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mcp/manifest" });
    expect(res.statusCode).toBe(401);
  });
});
