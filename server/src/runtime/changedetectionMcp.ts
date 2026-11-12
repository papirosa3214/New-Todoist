import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

/**
 * Слежение за страницами (changedetection.io) — всем ролям (владелец 09.11.2026).
 *
 * Зачем всем, а не только Помощнику: «что изменилось на странице», «когда
 * поднялась цена», «проверь конкурента» — работа любой роли, от аналитика до
 * разработчика. Поэтому, в отличие от финансов и почты, доступ не сужен.
 *
 * MCP у changedetection с 0.70.1 встроенный: POST /mcp/v1, JSON-RPC, токен
 * в заголовке Authorization. Стоит на том же .110, что и сервер, поэтому
 * ходим по loopback, без TLS и без шлюза мака.
 */

export const CHANGEDETECTION_PREFIX = "changedetection_";

const DEFAULT_URL = "http://127.0.0.1:5000/mcp/v1";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

const empty = () => ({ tools: [] as any[], close: async () => {} });

/** Имя инструмента в наборе роли. Префикс нужен загрузчику по требованию:
 *  без него 28 инструментов уезжали бы в каждый запрос. */
export const changedetectionToolName = (name: string): string => CHANGEDETECTION_PREFIX + name;

/** Доступно любой роли — включая внешних агентов. */
export const changedetectionRoleAllowed = (_role: string): boolean => true;

export function changedetectionUrl(): string {
  return process.env.TASKFLOW_CHANGEDETECTION_MCP_URL ?? DEFAULT_URL;
}

/** Токен лежит в хранилище .110, не в коде и не в env. Читается один раз за
 *  жизнь процесса: разблокировка хранилища ключом age не бесплатна. */
let cachedToken: string | undefined;

export async function changedetectionToken(): Promise<string> {
  const direct = process.env.TASKFLOW_CHANGEDETECTION_TOKEN;
  if (direct) return direct;
  if (cachedToken) return cachedToken;
  const key = process.env.TASKFLOW_CHANGEDETECTION_VAULT_KEY ?? "changedetection_mcp_token";
  const script = process.env.TASKFLOW_VAULT_GET ?? path.join(os.homedir(), ".claude", "vault-get.py");
  const token = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", [script, "--raw", key], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const value = out.trim();
      if (code === 0 && value) resolve(value);
      else reject(new Error(`хранилище не отдало ключ ${key} (код ${code})${err ? ": " + err.trim().slice(0, 200) : ""}`));
    });
  });
  cachedToken = token;
  return token;
}

/** Подключение к MCP слежения. Сбой не должен лишать роль остальных серверов:
 *  вызывающий ловит ошибку так же, как для инфрапанели и графа. */
export async function connectChangedetection(role: string) {
  if (!changedetectionRoleAllowed(role)) return empty();

  const url = changedetectionUrl();
  const token = await changedetectionToken();
  const client = new Client({ name: "taskflow-changedetection", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`changedetection MCP: время подключения истекло (${url})`)),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
    const listed = await client.listTools();
    // Схемы аргументов отдаём как есть, чтобы не разойтись с сервером.
    const tools: any[] = listed.tools.map((t) => ({
      name: changedetectionToolName(t.name),
      label: "Страницы · " + t.name,
      description: t.description ?? t.name,
      parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema),
      execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await client.callTool(
          { name: t.name, arguments: args },
          undefined,
          { signal, timeout: CALL_TIMEOUT_MS },
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return { content: result.content, details: { source: "changedetection", tool: t.name } };
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

/** Снимок состояния для «Интеграций». Живёт 60 с: экран не должен поднимать
 *  соединение при каждом открытии. */
export type ChangedetectionStatus = {
  connected: boolean;
  url: string;
  toolCount: number;
  error?: string;
};

let statusCache: { at: number; payload: ChangedetectionStatus } | undefined;

export async function changedetectionStatus(maxAgeMs = 60_000): Promise<ChangedetectionStatus> {
  const url = changedetectionUrl();
  const now = Date.now();
  if (statusCache && now - statusCache.at < maxAgeMs && statusCache.payload.url === url) {
    return statusCache.payload;
  }
  let payload: ChangedetectionStatus;
  try {
    const connected = await connectChangedetection("secretary");
    payload = { connected: true, url, toolCount: connected.tools.length };
    await connected.close().catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    payload = { connected: false, url, toolCount: 0, error: message.slice(0, 200) };
  }
  statusCache = { at: now, payload };
  return payload;
}
