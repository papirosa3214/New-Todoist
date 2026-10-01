import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { composioCommand, roleComposioPolicy, type ComposioPolicy } from "./composioPolicy.js";

export async function connectRoleComposio(role: string, mode: string, context: string) {
  const policy = roleComposioPolicy(role);
  if (!policy.enabled) return { tools: [], close: async () => {} };
  const command = composioCommand(policy, mode, context);
  const client = new Client({ name: "taskflow-role", version: "1.0.0" });
  const transport = new StdioClientTransport({ ...command, env: { ...process.env, ...command.env } as Record<string, string>, stderr: "ignore" });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error("Composio startup timeout")), 35_000); }),
    ]);
    clearTimeout(startupTimer);
    const listed = await client.listTools();
    return {
      tools: listed.tools.map(tool => ({
        name: "mcp__composio__" + tool.name,
        label: "Composio · " + tool.name,
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
          const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 120_000 });
          if (result.isError) throw new Error("Composio: инструмент завершился с ошибкой");
          return { content: (result.content as Array<{ type: string; text?: string }>).map(item => ({ type: "text" as const, text: item.type === "text" ? item.text ?? "" : JSON.stringify(item) })), details: { source: "Composio", tool: tool.name } };
        },
      })),
      close: () => client.close(),
    };
  } catch {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw new Error("Composio недоступен. Проверьте подключение в настройках роли.");
  } finally {
    clearTimeout(startupTimer);
  }
}

export async function inspectComposio(policy: ComposioPolicy, action: "catalog" | "authorize", search = "") {
  const command = composioCommand(policy, "work", "settings");
  try {
    const result = await promisify(execFile)(command.command, [...command.args, "--" + action], {
      env: { ...process.env, ...command.env, TASKFLOW_COMPOSIO_SEARCH: search, TASKFLOW_COMPOSIO_TOOLKIT: search },
      timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Composio не отвечает или ключ недействителен. Обновите ключ в хранилище и проверьте сеть сервера.");
  }
}
