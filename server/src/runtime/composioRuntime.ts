import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { composioCommand, roleComposioPolicy, type ComposioPolicy } from "./composioPolicy.js";

/** Строка каталога Composio — ровно та, что отдаёт `session.toolkits`. */
export type ComposioCatalogItem = {
  slug: string;
  name: string | null;
  logo: string | null;
  description: string | null;
  connected: boolean;
  noAuth: boolean;
};

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
        // Плоские действия сервисов (todoist_*) — под своим именем, без префикса моста.
        name: /^todoist_/.test(tool.name) ? tool.name : "mcp__composio__" + tool.name,
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

export async function inspectComposio(
  policy: ComposioPolicy,
  action: "catalog" | "authorize",
  search = "",
  page?: { cursor?: string | null; limit?: number },
) {
  const command = composioCommand(policy, "work", "settings");
  try {
    const result = await promisify(execFile)(command.command, [...command.args, "--" + action], {
      env: {
        ...process.env,
        ...command.env,
        TASKFLOW_COMPOSIO_SEARCH: search,
        TASKFLOW_COMPOSIO_TOOLKIT: search,
        ...(page?.cursor ? { TASKFLOW_COMPOSIO_CURSOR: page.cursor } : {}),
        ...(page?.limit ? { TASKFLOW_COMPOSIO_LIMIT: String(page.limit) } : {}),
      },
      timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Composio не отвечает или ключ недействителен. Обновите ключ в хранилище и проверьте сеть сервера.");
  }
}

/**
 * Состояние подключения нескольких сервисов — одним внешним процессом.
 *
 * Маршрут обзора спрашивает каталог плюс состояние каждого сервиса,
 * разрешённого ролям (замер 30.10.2026 на .110: 8 ключей). Раньше это были
 * 8 отдельных вызовов `inspectComposio` — по внешнему процессу на ключ, со
 * своим запуском Node, импортом SDK и созданием сессии Composio; на пике
 * висело 18 мостов, маршрут отвечал 5,6–6,2 с.
 *
 * Теперь это ОДИН процесс с одной сессией: мост ищет ключи параллельно
 * внутри себя (замер: 1 405 мс вместо 5 600 мс, все 8 ключей найдены).
 */
export async function inspectComposioSlugs(
  policy: ComposioPolicy,
  slugs: string[],
): Promise<{ items: ComposioCatalogItem[] }> {
  const command = composioCommand(policy, "work", "settings");
  const wanted = [...new Set(slugs.filter(slug => typeof slug === "string" && slug))];
  if (!wanted.length) return { items: [] };
  try {
    const result = await promisify(execFile)(command.command, [...command.args, "--slugs"], {
      env: {
        ...process.env,
        ...command.env,
        TASKFLOW_COMPOSIO_SLUGS: JSON.stringify(wanted),
      },
      timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
    });
    const raw = JSON.parse(result.stdout);
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return {
      items: items
        .map((item: any) => ({
          slug: String(item?.slug ?? ""),
          name: item?.name == null ? null : String(item.name),
          logo: typeof item?.logo === "string" && /^https:\/\//.test(item.logo) ? item.logo : null,
          description: typeof item?.description === "string" && item.description ? item.description : null,
          connected: !!item?.connected,
          noAuth: !!item?.noAuth,
        }))
        .filter((item: ComposioCatalogItem) => !!item.slug),
    };
  } catch {
    throw new Error("Composio не отвечает или ключ недействителен. Обновите ключ в хранилище и проверьте сеть сервера.");
  }
}
