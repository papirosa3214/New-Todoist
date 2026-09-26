// GET /api/mcp/manifest — что получает сторонний агент (Гермес, Claude Code,
// DSH…), подключившись к TaskFlow по MCP: инструкция из `initialize` и
// список инструментов из `tools/list`. Берём прямо из scripts/mcp_server.py,
// а не копией в коде: иначе экран «Сервер MCP» в приложении разъедется с тем,
// что клиент реально получает. Роли TaskFlow сюда не относятся — их запускает
// сервер со своим, более широким набором.
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import type { FastifyInstance } from "fastify";
import { authOrApiToken } from "../auth.js";

const run = promisify(execFile);
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");
const PY = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import mcp_server as m",
  "init = m.handle({'method': 'initialize', 'id': 1})['result']",
  "tools = [{'name': t['name'], 'description': t['description']} for t in m.public_tools()]",
  "print(json.dumps({'instructions': init.get('instructions', ''), 'tools': tools}, ensure_ascii=False))",
].join("\n");

type Manifest = { instructions: string; tools: { name: string; description: string }[] };
let cache: { at: number; data: Manifest } | null = null;
const TTL_MS = 60_000;

async function readManifest(): Promise<Manifest> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  // TASKFLOW_MCP_TOOLS очищаем: показываем полный сетевой набор, а не
  // профиль, случайно доставшийся процессу сервера из окружения.
  const env = { ...process.env, TASKFLOW_MCP_TOOLS: "" };
  const { stdout } = await run("python3", ["-c", PY, SCRIPTS_DIR], { env, timeout: 15_000 });
  const data = JSON.parse(stdout) as Manifest;
  cache = { at: Date.now(), data };
  return data;
}

export function registerMcpManifestRoutes(app: FastifyInstance): void {
  app.get("/api/mcp/manifest", { preHandler: authOrApiToken }, async (_req, reply) => {
    try {
      return await readManifest();
    } catch (e) {
      return reply.code(503).send({ error: `не удалось прочитать MCP-сервер: ${(e as Error).message}` });
    }
  });
}
