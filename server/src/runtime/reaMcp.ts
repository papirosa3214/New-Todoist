import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

/**
 * REA — Reverse Engineer Anything (владелец 12.11.2026).
 *
 * Зачем обёртка, а не расширение Pi: роли с 23.09.2026 исполняются внутри
 * процесса сервера, расширения Pi там не загружаются вовсе
 * (`inProcessRun.ts`, комментарий про `resourceLoader.getExtensions()`).
 * Единственный живой путь внешнего MCP к роли — такая обёртка плюс строка в
 * `connectRoleMcp`.
 *
 * Почему через мак: REA требует macOS и Hopper Disassembler — на .110
 * (Linux) он не запускается. Поэтому stdio-процесс поднимается по ssh на
 * маке: `npx -y @morluto/rea mcp`. Пути к бинарям REA понимает относительно
 * своего cwd, поэтому рабочая папка задаётся локально на маке.
 *
 * Без Hopper сервер поднимается, но анализ не идёт (`rea doctor` →
 * healthy:false). Это не повод молча выключать доступ: инструменты видны,
 * а роль на ошибке Hopper честно скажет владельцу.
 */

export const REA_PREFIX = "rea_";

/** Кому доступно: разбор чужих бинарников — исследовательская работа, поэтому
 *  researcher и infra_engineer; остальным не нужен и только тратит контекст. */
export const REA_ROLES = ["researcher", "infra_engineer"] as const;

const DEFAULT_MAC_HOST = "maksim@192.168.1.102";
const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 180_000;

const empty = () => ({ tools: [] as any[], close: async () => {} });

/** Имя инструмента в наборе роли. Префикс нужен загрузчику по требованию
 *  (ON_DEMAND_PREFIXES): 42 схем REA иначе уезжали бы в каждый запрос. */
export const reaToolName = (name: string): string => REA_PREFIX + name;

export const reaRoleAllowed = (role: string): boolean =>
  (REA_ROLES as readonly string[]).includes(role);

/** Хост мака: env перекрывает, по умолчанию — тот же, что у XcodeBuildMCP. */
export function reaMacHost(): string {
  return process.env.TASKFLOW_REA_SSH_HOST ?? DEFAULT_MAC_HOST;
}

/** Рабочая папка на маке: REA открывает бинарники по относительным путям. */
export function reaRemoteWorkdir(): string {
  return process.env.TASKFLOW_REA_WORKDIR ?? "~";
}

export async function connectRea(role: string) {
  if (!reaRoleAllowed(role)) return empty();

  const host = reaMacHost();
  const client = new Client({ name: "taskflow-role-rea", version: "1.0.0" });
  // stdio-процесс — ssh; REA живёт на другой стороне канала и говорит
  // обычным MCP по stdio, так что транспорт тот же.
  const transport = new StdioClientTransport({
    command: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      host,
      `zsh -lc 'cd ${reaRemoteWorkdir()} && exec npx -y @morluto/rea mcp'`,
    ],
    stderr: "ignore",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`REA MCP на ${host}: время подключения истекло`)),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
    const listed = await client.listTools();
    const tools: any[] = listed.tools.map((t) => ({
      name: reaToolName(t.name),
      label: "REA · " + t.name,
      description: t.description ?? t.name,
      parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema),
      execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await client.callTool(
          { name: t.name, arguments: args },
          undefined,
          { signal, timeout: CALL_TIMEOUT_MS },
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return { content: result.content, details: { source: "rea", tool: t.name } };
      },
    }));

    return {
      tools,
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ReaStatus = {
  connected: boolean;
  host: string;
  toolCount: number;
  error?: string;
};

/** Снимок для «Интеграций»: состояние держим 60 с, чтобы экран не поднимал
 *  ssh при каждом открытии. */
let statusCache: { at: number; host: string; payload: ReaStatus } | undefined;

export async function reaStatus(maxAgeMs = 60_000): Promise<ReaStatus> {
  const host = reaMacHost();
  const now = Date.now();
  if (statusCache && now - statusCache.at < maxAgeMs && statusCache.payload.host === host) {
    return statusCache.payload;
  }
  let payload: ReaStatus;
  try {
    const connected = await connectRea(REA_ROLES[0]);
    payload = { connected: true, host, toolCount: connected.tools.length };
    await connected.close().catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    payload = { connected: false, host, toolCount: 0, error: message.slice(0, 200) };
  }
  statusCache = { at: now, host, payload };
  return payload;
}
