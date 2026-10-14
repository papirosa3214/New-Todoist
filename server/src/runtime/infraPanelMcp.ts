import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

// Инженер .110 (владелец 14.10.2026) — дежурный по серверу, отвечает за
// «Состояние системы». Видит инфраструктуру через MCP инфрапанели: тот же
// сервер, что у агентов на маке (`~/bin/mcp-run.py infra-panel` берёт команду
// и ключи из ~/.claude.json на .110). Все инструменты панели только читают.
export const INFRA_ENGINEER_ROLE = "infra_engineer";

const empty = () => ({ tools: [] as any[], close: async () => {} });

export async function connectInfraPanel(role: string) {
  if (role !== INFRA_ENGINEER_ROLE) return empty();
  const client = new Client({ name: "taskflow-infra-engineer", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "python3",
    args: [path.join(os.homedir(), "bin", "mcp-run.py"), "infra-panel"],
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Инфрапанель MCP: время подключения истекло")), 20_000); }),
    ]);
    const listed = await client.listTools();
    const tools: any[] = listed.tools.map((t) => ({
      name: "mcp__infra__" + t.name,
      label: "Инфрапанель · " + t.name,
      description: t.description ?? t.name,
      parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema),
      execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await client.callTool({ name: t.name, arguments: args }, undefined, { signal, timeout: 120_000 });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return { content: result.content, details: { source: "infra-panel", tool: t.name } };
      },
    }));
    return { tools, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
