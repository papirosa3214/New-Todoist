// Одноразовый режим моста Composio (scripts/composio_mcp.mjs) обязан умирать
// сразу после ответа.
//
// Замер 30.10.2026 на .110: работа SDK — 1,1 с, а процесс жил ещё до 10,6 с,
// потому что после ответа остаётся открытый keep-alive сокет (TLS к
// Composio). Сервер ждёт именно выход процесса, и каталог упирался в свой
// таймаут — пустой список сервисов и «Composio не ответил вовремя», а на
// телефоне «Сеть недоступна».
//
// Проверка герметична: локальная заглушка API (COMPOSIO_BASE_URL) вместо
// живого Composio, а «висящий сокет» имитируется preload-модулем с таймером:
// пока в цикле событий есть таймер, процесс не умирает сам — ровно то
// состояние, из-за которого каталог не доезжал.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const script = path.join(process.cwd(), "scripts", "composio_mcp.mjs");
// Preload-модуль держит цикл событий. Кладём его во временный каталог, чтобы
// в дереве репозитория не оставалось мусора.
const holdPath = path.join(os.tmpdir(), `composio-hold-${process.pid}.cjs`);

const requests: string[] = [];

let server: http.Server;
let baseUrl: string;

/**
 * Ответы заглушки API Composio. SDK проверяет форму ответов, поэтому поля
 * повторяют настоящие: сессия, список сервисов, аккаунты, удаление сессии.
 */
function answerFor(url: string, method: string): unknown {
  // Порядок важен: URL каталога содержит и "tool_router/session", и "toolkits".
  if (url.includes("/toolkits")) {
    return {
      items: [
        { name: "Gmail", slug: "gmail", meta: {}, isLocalToolkit: false, is_no_auth: false },
      ],
      cursor: null,
      total_pages: 1,
    };
  }
  if (url.includes("connected_accounts")) return { items: [] };
  if (method === "DELETE") return { session_id: "sess_test", deleted: true };
  if (url.includes("tool_router/session")) {
    return {
      session_id: "sess_test",
      config: {},
      config_version: 1,
      mcp: { url: `${baseUrl}/mcp`, headers: {} },
    };
  }
  return {};
}

describe("Одноразовый режим моста Composio", () => {
  beforeAll(async () => {
    // Таймер в цикле событий не даёт процессу умереть самому — как keep-alive
    // сокет SDK в живой выкладке.
    writeFileSync(
      holdPath,
      "// Держит цикл событий: процесс не завершится, пока активен таймер.\nsetInterval(() => {}, 1000);\n",
    );
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answerFor(req.url ?? "", req.method ?? "")));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { rmSync(holdPath); } catch { /* временный файл — не важно */ }
  });

  it("печатает каталог и выходит сразу, не дожидаясь закрытия сокета", async () => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, "--catalog"], {
      env: {
        ...process.env,
        COMPOSIO_API_KEY: "test-key",
        COMPOSIO_BASE_URL: baseUrl,
        TASKFLOW_COMPOSIO_USER_ID: "taskflow:test",
        TASKFLOW_COMPOSIO_OPTIONS: JSON.stringify({ mcp: true }),
        TASKFLOW_COMPOSIO_SEARCH: "",
        NODE_USE_ENV_PROXY: "0",
        NODE_OPTIONS: `--require ${holdPath}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let error = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (error += chunk));

    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    // Без явного выхода процесс ждёт, пока закроется сокет: раньше это были
    // ~10 с, и сервер успевал обрезать ответ по своему таймауту.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`процесс не вышел за 8 с: ${error}`)), 8000),
    );
    const code = await Promise.race([exited, timeout]);
    const elapsed = Date.now() - started;

    expect(code).toBe(0);
    const payload = JSON.parse(output);
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items[0].slug).toBe("gmail");
    // Ответ пришёл сразу — процесс не ждал закрытия сокета.
    expect(elapsed).toBeLessThan(8000);
    expect(requests.some(url => url.includes("toolkits"))).toBe(true);
  }, 15000);
});
