// MCP-режим моста Composio — это stdio-СЕРВЕР: он должен жить после старта.
// Правка одноразовых режимов не должна его убивать.
//
// Проверка герметична: локальная заглушка API (COMPOSIO_BASE_URL). Сессия
// создаётся, а MCP-эндпоинт заглушки не отвечает — так скрипт «подвешен»
// на подключении, как в жизни. Если правка одноразовых режимов случайно
// заденет MCP-путь, процесс выйдет раньше времени — тест это поймает.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const script = path.join(process.cwd(), "scripts", "composio_mcp.mjs");

let server: http.Server;
let baseUrl: string;

describe("MCP-режим моста Composio", () => {
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url.includes("/mcp")) {
        // MCP-эндпоинт не отвечает: подключение «висит», как в жизни.
        return;
      }
      let payload: unknown = {};
      if (url.includes("connected_accounts")) payload = { items: [] };
      else if (url.includes("tool_router/session")) {
        payload = {
          session_id: "sess_test",
          config: {},
          config_version: 1,
          mcp: { url: `${baseUrl}/mcp`, headers: {} },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("остаётся жив после старта (это stdio-сервер)", async () => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        COMPOSIO_API_KEY: "test-key",
        COMPOSIO_BASE_URL: baseUrl,
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
