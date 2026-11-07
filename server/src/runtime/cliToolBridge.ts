// Мост инструментов роли для внешнего агента (Claude Code и т. п.).
//
// Внешний CLI получает инструменты TaskFlow по MCP, но наружу ничего не
// выставляется: CLI сам запускает scripts/cli-tool-bridge.mjs как stdio-MCP,
// а тот ходит сюда через unix-сокет в приватной папке (0700) с одноразовым
// ключом. Инструменты исполняются в процессе сервера теми же объектами,
// что у роли на Pi, — права, лента и правила не меняются. Мост живёт ровно
// один заход и закрывается вместе с сессией.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_SERVER_NAME = "taskflow";

const BRIDGE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/cli-tool-bridge.mjs");

export interface BridgeTool {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (id: string, args: any, signal?: AbortSignal) => Promise<any>;
}

export interface ToolBridge {
  /** Путь к JSON для `--mcp-config`. */
  configPath: string;
  close(): Promise<void>;
}

/** Ответ инструмента Pi ({content:[{type:"text",text}]}) → ответ MCP. */
export function toMcpResult(result: any): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).filter(Boolean).join("\n");
  return { content: [{ type: "text", text: text || (typeof result === "string" ? result : JSON.stringify(result ?? null)) }] };
}

export async function startToolBridge(tools: BridgeTool[]): Promise<ToolBridge> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-cli-"));
  fs.chmodSync(dir, 0o700);
  const socketPath = path.join(dir, "bridge.sock");
  const token = crypto.randomBytes(24).toString("hex");
  const byName = new Map(tools.map((t) => [t.name, t]));
  const controller = new AbortController();

  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void handle(line).then((reply) => socket.write(JSON.stringify(reply) + "\n"));
      }
    });
    socket.on("error", () => {});
  });

  async function handle(line: string): Promise<any> {
    let req: any;
    try { req = JSON.parse(line); } catch { return { error: "bad json" }; }
    if (req?.token !== token) return { id: req?.id, error: "forbidden" };
    if (req.op === "list") {
      return {
        id: req.id,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
        })),
      };
    }
    if (req.op === "call") {
      const tool = byName.get(String(req.name));
      if (!tool) return { id: req.id, result: { content: [{ type: "text", text: `инструмента ${req.name} нет у роли` }], isError: true } };
      try {
        const result = await tool.execute(`cli_${crypto.randomUUID()}`, req.args ?? {}, controller.signal);
        return { id: req.id, result: toMcpResult(result) };
      } catch (error) {
        return { id: req.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } };
      }
    }
    return { id: req.id, error: "unknown op" };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  fs.chmodSync(socketPath, 0o600);

  const configPath = path.join(dir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        command: process.execPath,
        args: [BRIDGE_SCRIPT],
        env: { TF_BRIDGE_SOCKET: socketPath, TF_BRIDGE_TOKEN: token },
      },
    },
  }), { mode: 0o600 });

  return {
    configPath,
    async close() {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
