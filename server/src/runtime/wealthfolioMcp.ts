import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

/**
 * Финансовый трекер владельца (Wealthfolio) для Помощника владельца
 * (владелец 08.11.2026).
 *
 * Почему напрямую, а не через шлюз мака: MCP стоит на том же .110, что и
 * сервер TaskFlow, — звено в виде мака добавило бы отказ на ровном месте.
 *
 * Почему не HTTPS: по loopback TLS не нужен, а сертификат finance.lan Node на
 * .110 не знает (проверено 08.11.2026: fetch падает с "fetch failed").
 *
 * Кому: только secretary. Это личный помощник владельца — тот же принцип, что
 * у почты (secretaryMailTools) и Things 3: личные финансы не дело всей команды.
 */

export const WEALTHFOLIO_ROLE = "secretary";
export const WEALTHFOLIO_PREFIX = "wealthfolio_";

const DEFAULT_URL = "http://127.0.0.1:8095/mcp";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

const empty = () => ({ tools: [] as any[], close: async () => {} });

/** Имя инструмента в наборе роли. Префикс — не косметика: по нему загрузчик
 *  по требованию (ON_DEMAND_PREFIXES) решает, что в каждый запрос не уходит. */
export const wealthfolioToolName = (name: string): string => WEALTHFOLIO_PREFIX + name;

export const wealthfolioRoleAllowed = (role: string): boolean => role === WEALTHFOLIO_ROLE;

export function wealthfolioUrl(): string {
  return process.env.TASKFLOW_WEALTHFOLIO_MCP_URL ?? DEFAULT_URL;
}

/** Токен лежит в хранилище .110, не в коде и не в env. Читается один раз за
 *  жизнь процесса: разблокировка хранилища ключом age не бесплатна. */
let cachedToken: string | undefined;

export async function wealthfolioToken(): Promise<string> {
  const direct = process.env.TASKFLOW_WEALTHFOLIO_TOKEN;
  if (direct) return direct;
  if (cachedToken) return cachedToken;
  const key = process.env.TASKFLOW_WEALTHFOLIO_VAULT_KEY ?? "wealthfolio_mcp_token";
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

/** Подключение к MCP трекера. Сбой не должен лишать роль остальных серверов:
 *  вызывающий ловит ошибку так же, как для инфрапанели и графа. */
export async function connectWealthfolio(role: string) {
  if (!wealthfolioRoleAllowed(role)) return empty();

  const url = wealthfolioUrl();
  const token = await wealthfolioToken();
  const client = new Client({ name: "taskflow-secretary-wealthfolio", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Wealthfolio MCP: время подключения истекло (${url})`)),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
    const listed = await client.listTools();
    // Ответ трекера уже содержит схемы в форме MCP: отдаём их как есть, чтобы
    // не разойтись с сервером при добавлении аргументов.
    const tools: any[] = listed.tools.map((t) => ({
      name: wealthfolioToolName(t.name),
      label: "Финансы · " + t.name,
      description: t.description ?? t.name,
      parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema),
      execute: async (_id: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await client.callTool(
          { name: t.name, arguments: args },
          undefined,
          { signal, timeout: CALL_TIMEOUT_MS },
        );
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return { content: result.content, details: { source: "wealthfolio", tool: t.name } };
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
 *  соединение при каждом открытии. Ключ кеша — адрес: сменили адрес, кеш не врёт. */
export type WealthfolioStatus = {
  connected: boolean;
  url: string;
  toolCount: number;
  error?: string;
};

let statusCache: { at: number; payload: WealthfolioStatus } | undefined;

export async function wealthfolioStatus(maxAgeMs = 60_000): Promise<WealthfolioStatus> {
  const url = wealthfolioUrl();
  const now = Date.now();
  if (statusCache && now - statusCache.at < maxAgeMs && statusCache.payload.url === url) {
    return statusCache.payload;
  }
  let payload: WealthfolioStatus;
  try {
    const connected = await connectWealthfolio(WEALTHFOLIO_ROLE);
    payload = { connected: true, url, toolCount: connected.tools.length };
    await connected.close().catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    payload = { connected: false, url, toolCount: 0, error: message.slice(0, 200) };
  }
  statusCache = { at: now, payload };
  return payload;
}
