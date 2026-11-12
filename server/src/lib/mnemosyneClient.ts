// Клиент Mnemosyne по MCP (streamable-http) — единственная память TaskFlow
// (владелец 08.11.2026: «надо, чтобы всё записывалось в этой Mnemosyne и
// пользовались им, а не своими какими-то файлами с папками»).
//
// Почему MCP, а не запись в SQLite банка: у Mnemosyne своя логика —
// эмбеддинги, гибридный поиск, дедупликация, сжатие (sleep). Полезть в её
// базу напрямую значит получить «память», которую она сама не находит.
//
// Адрес и ключ: `MNEMOSYNE_MCP_URL` (по умолчанию 127.0.0.1:8108/mcp —
// streamable-http инстанс), ключ — `MNEMOSYNE_MCP_TOKEN` из окружения или,
// если его там нет, из хранилища (`~/.claude/vault-get.py --raw`), тем же
// приёмом, что у остальных служб .110 (§4: в конфигах только имя ключа).
//
// Сессия MCP живёт между вызовами; если сервер её забыл (перезапуск,
// 404 на POST) — один повтор с новой сессией. Любая неудача возвращается
// исключением с причиной: тихий пустой ответ выдал бы поломку за «память
// пуста», а это ровно то, что владелец и застал 08.11.2026.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = Number(process.env.MNEMOSYNE_TIMEOUT_MS ?? 15_000);

export class MnemosyneError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "MnemosyneError";
  }
}

function endpoint(): string {
  return process.env.MNEMOSYNE_MCP_URL ?? "http://127.0.0.1:8108/mcp";
}

let tokenCache: string | null = null;

function token(): string {
  if (process.env.MNEMOSYNE_MCP_TOKEN) return process.env.MNEMOSYNE_MCP_TOKEN;
  if (tokenCache) return tokenCache;
  try {
    const raw = execFileSync(
      "/usr/bin/python3",
      [path.join(homedir(), ".claude/vault-get.py"), "--raw", "MNEMOSYNE_MCP_TOKEN"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    if (!raw) throw new Error("хранилище вернуло пустой ключ");
    tokenCache = raw;
    return raw;
  } catch (err) {
    throw new MnemosyneError(
      "нет ключа Mnemosyne в окружении и в хранилище",
      err instanceof Error ? err.message : String(err),
    );
  }
}

interface Session {
  id: string;
}

let session: Session | null = null;
let opening: Promise<Session> | null = null;
/** Растущий id запроса: по нему MCP-сервер отличает ответы. */
let nextId = 2;
/** Очередь вызовов: соединение одно, и ответ приходит только на свой запрос. */
let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function parseBody(text: string, contentType: string): unknown {
  const body = text.trim();
  if (!body) throw new MnemosyneError("Mnemosyne ответила пустым телом");
  if (contentType.includes("text/event-stream") || body.startsWith("event:")) {
    const payloads = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean);
    const last = payloads[payloads.length - 1];
    if (!last) throw new MnemosyneError("в SSE-ответе Mnemosyne нет данных");
    return JSON.parse(last);
  }
  return JSON.parse(body);
}

async function post(message: unknown, sessionId?: string): Promise<{ json: unknown; sessionId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MnemosyneError(
        `Mnemosyne ответила ${res.status}`,
        text.slice(0, 400),
      );
    }
    return { json: parseBody(text, res.headers.get("content-type") ?? ""), sessionId: res.headers.get("mcp-session-id") };
  } finally {
    clearTimeout(timer);
  }
}

async function openSession(): Promise<Session> {
  if (opening) return opening;
  opening = (async () => {
    const { json, sessionId } = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "taskflow-server", version: "1" },
      },
    });
    const answer = json as { result?: unknown; error?: { message?: string } };
    if (answer.error) throw new MnemosyneError("Mnemosyne не открыла сессию", answer.error.message ?? "");
    if (!answer.result) throw new MnemosyneError("Mnemosyne не ответила на initialize");
    if (!sessionId) throw new MnemosyneError("Mnemosyne не выдала Mcp-Session-Id");
    session = { id: sessionId };
    return session;
  })().finally(() => {
    opening = null;
  });
  return opening;
}

async function rpc(method: string, params: unknown, retry = true): Promise<unknown> {
  const current = session ?? (await openSession());
  let answer: { json: unknown };
  try {
    nextId += 1;
    answer = await post({ jsonrpc: "2.0", id: nextId, method, params }, current.id);
  } catch (err) {
    session = null;
    if (retry) return withLock(() => rpc(method, params, false));
    throw err;
  }
  const body = answer.json as { result?: unknown; error?: { message?: string; code?: number } };
  if (body.error) throw new MnemosyneError(`Mnemosyne: ${method}`, body.error.message ?? String(body.error.code ?? ""));
  return body.result;
}

function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return withLock(async () => {
    try {
      return await callToolUnlocked<T>(name, args);
    } catch (err) {
      // После перезапуска службы сессия мертва: первая операция памяти иначе
      // проваливается, а успешной становится только следующая.
      if (!(err instanceof MnemosyneError) || !/сесси|session|404|410/i.test(err.message + err.detail)) throw err;
      session = null;
      return callToolUnlocked<T>(name, args);
    }
  });
}

async function callToolUnlocked<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await rpc("tools/call", { name, arguments: args }, false)) as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((c) => typeof c.text === "string")?.text ?? "";
  if (result.isError) throw new MnemosyneError(`инструмент ${name} вернул ошибку`, text.slice(0, 400));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MnemosyneError(`ответ ${name} не разобрать`, text.slice(0, 400));
  }
}

export interface MnemosyneHit {
  id: string;
  content: string;
  source?: string;
  scope?: string;
  importance?: number;
  score?: number;
  timestamp?: string;
  truncated?: boolean;
}

export interface MnemosyneRememberResult {
  status?: string;
  id?: string;
  memory_id?: string;
  duplicate?: boolean;
  similar_to?: string;
  [key: string]: unknown;
}

/** Найти в памяти Mnemosyne. Пустой банк — законный пустой ответ. */
export async function mnemoRecall(query: string, limit = 8, bank?: string): Promise<MnemosyneHit[]> {
  const data = await callTool<{ status?: string; results?: MnemosyneHit[] }>("mnemosyne_recall", {
    query,
    limit,
    ...(bank ? { bank } : {}),
  });
  const hits = Array.isArray(data.results) ? data.results : [];
  // Короткие записи Mnemosyne отдаёт целиком; обрезанные дозапрашиваем,
  // иначе роль получает огрызок вместо урока.
  return Promise.all(
    hits.map(async (hit) =>
      hit.truncated ? { ...hit, ...(await mnemoGet(hit.id, bank).catch(() => ({}))) } : hit,
    ),
  );
}

/** Записать в память Mnemosyne. Возвращает id записи. */
export async function mnemoRemember(input: {
  content: string;
  importance?: number;
  source?: string;
  scope?: "global" | "session";
  veracity?: "stated" | "inferred" | "tool" | "imported" | "unknown";
  metadata?: Record<string, unknown>;
  bank?: string;
}): Promise<MnemosyneRememberResult> {
  const data = await callTool<MnemosyneRememberResult>("mnemosyne_remember", {
    content: input.content,
    importance: input.importance ?? 0.6,
    source: input.source ?? "taskflow",
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.veracity ? { veracity: input.veracity } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.bank ? { bank: input.bank } : {}),
  });
  return data;
}

export async function mnemoGet(
  memoryId: string,
  bank?: string,
): Promise<{ content: string; [key: string]: unknown }> {
  return callTool<{ content: string }>("mnemosyne_get", {
    memory_id: memoryId,
    ...(bank ? { bank } : {}),
  });
}

export async function mnemoUpdate(
  memoryId: string,
  input: { content?: string; importance?: number; bank?: string },
): Promise<unknown> {
  return callTool("mnemosyne_update", {
    memory_id: memoryId,
    ...(input.bank ? { bank: input.bank } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
  });
}

export async function mnemoForget(memoryId: string, bank?: string): Promise<unknown> {
  return callTool("mnemosyne_forget", { memory_id: memoryId, ...(bank ? { bank } : {}) });
}

export async function mnemoInvalidate(memoryId: string, replacementId = ""): Promise<unknown> {
  return callTool("mnemosyne_invalidate", { memory_id: memoryId, replacement_id: replacementId });
}

/** Жива ли память: используется сторожем, чтобы поломка не была тихой. */
export async function mnemoAlive(): Promise<{ ok: boolean; detail: string }> {
  try {
    await mnemoRecall("проверка связи", 1);
    return { ok: true, detail: `Mnemosyne на связи (${endpoint()})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? `${err.message}: ${(err as MnemosyneError).detail ?? ""}` : String(err) };
  }
}
