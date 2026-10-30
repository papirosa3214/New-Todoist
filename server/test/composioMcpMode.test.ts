// MCP-режим моста Composio — это stdio-СЕРВЕР: он должен жить после старта.
// Правка одноразовых режимов не должна его убивать.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";

const script = path.join(process.cwd(), "scripts", "composio_mcp.mjs");

describe("MCP-режим моста Composio", () => {
  it("остаётся жив после старта (это stdio-сервер)", async () => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        COMPOSIO_API_KEY: "test-key",
        TASKFLOW_COMPOSIO_USER_ID: "taskflow:test",
        TASKFLOW_COMPOSIO_OPTIONS: JSON.stringify({ mcp: true }),
        TASKFLOW_COMPOSIO_MODE: "work",
        // Хеш контекста: без него скрипт бросает invalid_context.
        TASKFLOW_COMPOSIO_CACHE_KEY: "a".repeat(64),
        NODE_USE_ENV_PROXY: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", chunk => (stderr += chunk));

    const exitedEarly = new Promise<string>(resolve => child.once("exit", code => resolve(`вышел с кодом ${code}: ${stderr}`)));
    const alive = new Promise<string>(resolve => setTimeout(() => resolve("жив"), 2500));
    const verdict = await Promise.race([exitedEarly, alive]);

    try {
      expect(verdict).toBe("жив");
    } finally {
      child.kill("SIGTERM");
    }
  }, 15000);
});
