import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../src/db.js";
import { buildApp } from "../src/index.js";

describe("POST /api/agent-service", () => {
  let app: FastifyInstance;
  let token: string;
  let fakeBin: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    fakeBin = mkdtempSync(path.join(tmpdir(), "taskflow-systemctl-"));
    const systemctl = path.join(fakeBin, "systemctl");
    writeFileSync(
      systemctl,
      "#!/bin/sh\n" +
        "if [ \"$2\" = \"show\" ]; then\n" +
        "  printf 'ActiveState=active\\nUnitFileState=enabled\\n'\n" +
        "fi\n" +
        "exit 0\n",
    );
    chmodSync(systemctl, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

    app = await buildApp();
    const email = `agent-service-response-${Date.now()}@test`;
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "AgentServiceOwner", email, password: "password123" },
    });
    expect(registration.statusCode).toBe(200);
    const body = registration.json();
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(body.user.id);
    token = body.token;
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await app.close();
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it("подтверждает мутацию и возвращает актуальное состояние", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agent-service",
      headers: { authorization: `Bearer ${token}` },
      payload: { on: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      active: true,
      enabled: true,
    });
  });
});
