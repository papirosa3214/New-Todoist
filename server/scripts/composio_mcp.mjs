import { Composio } from "@composio/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
let phase = "configuration";

// This process alone receives the vault credential. MCP replies never include it.
export function planningToolAllowed(tool) {
  return ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_GET_TOOL_SCHEMAS"].includes(tool.name);
}

/** Владелец 20.10.2026: действия этих сервисов — отдельные операции роли
 *  (todoist_create_task {...}) вместо COMPOSIO_MULTI_EXECUTE_TOOL → tools[] →
 *  tool_slug → arguments. Берём основные (important) и не устаревшие; в режиме
 *  плана — только чтение. Сбой каталога не роняет мост: остаются мета-инструменты. */
export const FLAT_TOOLKITS = ["todoist"];
export function flatToolAllowed(tool, plan) {
  const tags = tool.tags ?? [];
  return tags.includes("important") && !tags.includes("deprecated") && (!plan || tags.includes("readOnlyHint"));
}
export async function flatToolkitTools(composio, options, plan) {
  const enabled = options?.toolkits?.enable ?? [];
  const out = [];
  for (const toolkit of FLAT_TOOLKITS.filter(t => enabled.includes(t))) {
    try {
      const raw = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 200 });
      for (const t of raw) {
        if (!flatToolAllowed(t, plan)) continue;
        out.push({
          name: String(t.slug).toLowerCase(), slug: t.slug, version: t.version,
          description: String(t.description ?? t.slug).slice(0, 1500),
          inputSchema: t.inputParameters && typeof t.inputParameters === "object" ? t.inputParameters : { type: "object", properties: {} },
          annotations: { readOnlyHint: (t.tags ?? []).includes("readOnlyHint") },
        });
      }
    } catch { /* остаются мета-инструменты Composio */ }
  }
  return out;
}

// Аккаунт, подключённый по своему ключу (Exa и подобные — у Composio для них
// нет управляемой авторизации), сессия сама не находит: без явной привязки
// authConfigs сервис в ней числится неподключённым. Подставляем свои
// настройки подключения из активных аккаунтов владельца.
// Описания сервисов по-русски: Composio отдаёт их только на английском,
// перевод лежит словарём slug → текст рядом с сервером.
let russianDescriptions;
export async function russianDescription(slug) {
  if (russianDescriptions === undefined) {
    try {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "composio-toolkits-ru.json");
      russianDescriptions = JSON.parse(await fs.readFile(file, "utf8"));
    } catch { russianDescriptions = {}; }
  }
  return russianDescriptions[slug] ?? null;
}

export async function withOwnAuthConfigs(composio, userId, options) {
  const accounts = (await composio.connectedAccounts.list({ userIds: [userId], statuses: ["ACTIVE"], limit: 100 })).items;
  // Только для сервисов, включённых у роли: ключ невключённого Composio
  // отклоняет всю сессию (400 «not in the enabled list»), 28.10.2026.
  const enabled = options.toolkits?.enable ? new Set(options.toolkits.enable) : null;
  const own = {};
  for (const account of accounts) {
    const slug = account.toolkit?.slug;
    const config = account.authConfig;
    if (enabled && !enabled.has(slug)) continue;
    if (slug && config?.id && !config.isComposioManaged && !own[slug]) own[slug] = config.id;
  }
  if (!Object.keys(own).length) return options;
  return { ...options, authConfigs: { ...own, ...(options.authConfigs ?? {}) } };
}

export async function openComposioSession(composio, options, userId, cacheFile) {
  let session;
  if (cacheFile) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      session = await composio.use(cached.sessionId, { mcp: true });
    } catch (error) {
      if (error.code !== "ENOENT" && error.status !== 404 && error.statusCode !== 404) throw error;
    }
  }
  if (!session) {
    session = await composio.create(userId, options);
    if (cacheFile) {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      const temporary = cacheFile + "." + process.pid;
      await fs.writeFile(temporary, JSON.stringify({ sessionId: session.sessionId }), { mode: 0o600 });
      await fs.rename(temporary, cacheFile);
    }
  }
  return session;
}

export async function readLinearComposio(composio, userId, input) {
    if (!/^\s*query\s/.test(input.query) || /\b(mutation|subscription)\b/.test(input.query)) throw new Error("read_only_query_required");
    const accounts = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ["linear"], statuses: ["ACTIVE"], limit: 2 });
    if (accounts.items.length !== 1) {
      return { error: accounts.items.length ? "multiple_accounts" : "not_connected" };
    }
    const result = await composio.tools.execute("LINEAR_RUN_QUERY_OR_MUTATION", {
      userId, connectedAccountId: accounts.items[0].id, version: "20260924_00",
      arguments: { query_or_mutation: input.query, variables: input.variables ?? {} },
    });
    // Never forward SDK error details, credentials, headers or account metadata.
    if (!result.successful || result.error || result.data?.errors?.length || !result.data?.data) {
      return { error: "query_failed" };
    } else { return { data: result.data.data }; }
}

async function readJsonInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("input_too_large");
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

// Аккаунты одного сервиса у владельца: список, ссылка на новый, удаление, письмо.
// Токены и прочие данные подключения наружу не отдаются.
export async function manageAccounts(composio, userId, toolkit, action, input) {
  if (!/^[a-z0-9_\-]{1,100}$/.test(toolkit ?? "")) throw new Error("invalid_toolkit");
  const all = async () => (await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: [toolkit], limit: 50 })).items;
  const address = a => (/@/.test(String(a.data?.displayName ?? "")) ? String(a.data.displayName) : null);
  const view = a => ({ id: a.id, address: address(a), alias: a.alias ?? null, status: a.status, created_at: a.createdAt ?? null });
  if (action === "accounts") return { items: (await all()).map(view) };
  if (action === "account-link") {
    const alias = typeof input.alias === "string" && input.alias.trim() ? input.alias.trim().slice(0, 100) : undefined;
    const configs = await composio.authConfigs.list({ toolkit });
    const config = configs.items.find(c => c.status === "ENABLED") ?? configs.items[0];
    if (!config) {
      const session = await composio.create(userId, { mcp: true, manageConnections: { enable: false } });
      return { url: (await session.authorize(toolkit)).redirectUrl };
    }
    try {
      const request = await composio.connectedAccounts.link(userId, config.id, alias ? { alias } : {});
      return { url: request.redirectUrl, id: request.id ?? null };
    } catch (error) {
      if (alias && /alias/i.test(String(error?.message ?? ""))) return { error: "alias_taken" };
      throw error;
    }
  }
  if (action === "account-delete") {
    if (!(await all()).some(a => a.id === input.id)) return { error: "not_found" };
    await composio.connectedAccounts.delete(input.id);
    return { ok: true };
  }
  // Почта: только перечисленные операции. Удаления, пересылки, ответов и отправки
  // посторонним здесь нет, и добавлять их нельзя без решения владельца.
  if (action.startsWith("mail-")) {
    const active = (await all()).filter(a => a.status === "ACTIVE");
    if (!active.length) return { error: "not_connected" };
    const names = a => [a.id, a.alias, address(a)].filter(Boolean).map(v => String(v).toLowerCase());
    const own = [...new Set(active.flatMap(a => [a.alias, address(a)]).filter(v => v && /@/.test(v)).map(v => String(v).toLowerCase()))];
    const wanted = String(input.account ?? "").trim().toLowerCase();
    const account = wanted ? active.find(a => names(a).includes(wanted)) : active[0];
    if (!account) return { error: "account_not_found", accounts: own };
    const run = async (slug, args) => {
      const result = await composio.tools.execute(slug, { userId, connectedAccountId: account.id, version: "20261010_00", arguments: args });
      return result.successful && !result.error ? result.data ?? {} : null;
    };
    const used = address(account) ?? account.alias;
    const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    const brief = m => ({ id: m.messageId ?? m.id ?? null, thread_id: m.threadId ?? null, from: clip(m.sender ?? m.from, 200), to: clip(m.to, 200),
      subject: clip(m.subject ?? m.preview?.subject, 300), date: m.messageTimestamp ?? m.date ?? null, labels: m.labelIds ?? [] });
    if (action === "mail-list") {
      const data = await run("GMAIL_FETCH_EMAILS", { query: clip(input.query, 300) || "in:inbox", max_results: Math.max(1, Math.min(20, Number(input.limit) || 10)), include_payload: true, verbose: false });
      if (!data) return { error: "mail_failed" };
      return { account: used, own, messages: (data.messages ?? []).map(m => ({ ...brief(m), preview: clip(m.preview?.body ?? m.messageText, 300) })) };
    }
    if (action === "mail-read") {
      const data = await run("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: String(input.message_id ?? ""), format: "full" });
      if (!data) return { error: "mail_failed" };
      return { account: used, own, attachments: (data.attachmentList ?? []).map(a => ({ id: a.attachmentId, name: clip(a.filename, 200), type: clip(a.mimeType, 100) })), message: { ...brief(data), text: String(data.messageText ?? data.preview?.body ?? "").slice(0, 20_000) } };
    }
    if (action === "mail-attachment") {
      // Кому можно отдавать вложение, решает сервер (белый список); здесь только скачивание.
      const data = await run("GMAIL_GET_ATTACHMENT", { message_id: String(input.message_id ?? ""), attachment_id: String(input.attachment_id ?? ""), file_name: String(input.name ?? "attachment") });
      const url = data?.file?.s3url;
      if (!url) return { error: "mail_failed" };
      const response = await fetch(url);
      if (!response.ok) return { error: "mail_failed" };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 15 * 1024 * 1024) return { error: "attachment_too_large" };
      const dir = path.join(os.homedir(), ".local", "state", "taskflow", "mail-attachments");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const safe = String(input.name ?? data.file.name ?? "attachment").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-120) || "attachment";
      const file = path.join(dir, Date.now() + "-" + safe);
      await fs.writeFile(file, bytes, { mode: 0o600 });
      return { ok: true, account: used, path: file, name: safe, type: clip(data.file.mimetype, 100), size: bytes.length };
    }
    if (action === "mail-draft") {
      const data = await run("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: clip(input.to, 320), subject: clip(input.subject, 300), body: String(input.body ?? "").slice(0, 50_000),
        ...(input.thread_id ? { thread_id: String(input.thread_id) } : {}) });
      return data ? { ok: true, account: used, draft_id: data.id ?? data.draft?.id ?? null } : { error: "mail_failed" };
    }
    if (action === "mail-archive" || action === "mail-spam") {
      const data = await run("GMAIL_ADD_LABEL_TO_EMAIL", { message_id: String(input.message_id ?? ""),
        ...(action === "mail-spam" ? { add_label_ids: ["SPAM"], remove_label_ids: ["INBOX"] } : { remove_label_ids: ["INBOX"] }) });
      return data ? { ok: true, account: used } : { error: "mail_failed" };
    }
    if (action === "mail-send") {
      const to = String(input.to ?? "").trim().toLowerCase();
      if (!own.includes(to)) return { error: "recipient_not_allowed", allowed: own };
      const data = await run("GMAIL_SEND_EMAIL", { recipient_email: to, subject: clip(input.subject, 300), body: String(input.body ?? "").slice(0, 50_000) });
      return data ? { ok: true, account: used, to } : { error: "mail_failed" };
    }
  }
  throw new Error("unknown_action");
}

/**
 * Одноразовый режим: напечатать ответ и выйти.
 *
 * SDK Composio держит открытым keep-alive сокет, поэтому после записи в
 * stdout процесс сам не завершается — под node 22 он живёт ещё ~10 с
 * (замер 30.10.2026: работа 1,1 с, выход на 10,6 с). Сервер ждёт именно
 * выход процесса, и каталог упирался в свой таймаут: пустой список
 * сервисов и «Composio не ответил вовремя», а на телефоне — «Сеть
 * недоступна». Поэтому ответ пишем и уходим сразу, дожидаясь сброса
 * stdout: иначе процесс обрежет вывод на середине.
 */
function writeOut(payload) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(payload), (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Одноразовый вызов (--catalog, --authorize, аккаунты, почта) — ответ уже
 * напечатан, и процесс должен уйти. Режим MCP — это stdio-сервер, он
 * должен жить дальше, поэтому флаг ставится только в одноразовых ветках.
 */
let oneShot = false;

/**
 * Поиск сервисов по списку ключей — за одну сессию Composio.
 *
 * Маршрут обзора спрашивает каталог плюс состояние подключения каждого
 * сервиса, разрешённого ролям (замер 30.10.2026 на .110: 8 ключей). Раньше
 * это было 8 отдельных внешних процессов — по одному на ключ, каждый со
 * своим запуском Node, импортом SDK и созданием сессии Composio. На пике
 * висело 18 мостов одновременно, маршрут отвечал 5,6–6,2 с.
 *
 * Теперь это ОДИН процесс с ОДНОЙ сессией: внутри идут поиски по ключам
 * параллельно (замер: 1 405 мс вместо 5 600 мс, все 8 ключей найдены).
 * Ключи ищутся поиском, а не постраничным обходом каталога: в каталоге
 * 35 страниц, обход 12 страниц занял 3,5 с и не нашёл `github_mcp` вовсе.
 */
async function toolkitsBySlugs(composio, userId, options, slugs) {
  const session = await composio.create(userId, { ...options, toolkits: undefined });
  try {
    const wanted = [...new Set(slugs.filter(slug => typeof slug === "string" && slug))];
    const results = await Promise.all(wanted.map(async slug => {
      const result = await session.toolkits({ limit: 50, search: slug });
      return result.items.find(item => item.slug === slug) ?? null;
    }));
    const items = results.filter(Boolean).map(t => ({
      slug: t.slug,
      name: t.name,
      logo: t.logo ?? null,
      description: null,
      connected: !!t.connection?.isActive,
      noAuth: t.isNoAuth,
    }));
    // Русские описания подставляем здесь, а не в мосте: поиск по ключу
    // возвращает один сервис, а словарь читается один раз на весь ответ.
    for (const item of items) item.description = await russianDescription(item.slug);
    return items;
  } finally { await session.delete(); }
}

export async function main() {
  const userId = process.env.TASKFLOW_COMPOSIO_USER_ID;
  if (!userId || !process.env.COMPOSIO_API_KEY) throw new Error("credential_missing");
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, logLevel: "silent", allowTracking: false });
  const options = await withOwnAuthConfigs(composio, userId, JSON.parse(process.env.TASKFLOW_COMPOSIO_OPTIONS ?? "{}"));
  phase = "session";
  if (process.argv.includes("--slugs")) {
    const slugs = JSON.parse(process.env.TASKFLOW_COMPOSIO_SLUGS ?? "[]");
    const items = await toolkitsBySlugs(composio, userId, options, Array.isArray(slugs) ? slugs : []);
    await writeOut({ items });
    oneShot = true;
    return;
  }
  if (process.argv.includes("--catalog")) {
    const session = await composio.create(userId, { ...options, toolkits: undefined });
    try {
      // Каталог постраничный: страницу задаёт сервер (cursor приходит с
      // прошлой страницы), иначе видны только первые 50 сервисов.
      const limit = Math.min(100, Math.max(1, Number(process.env.TASKFLOW_COMPOSIO_LIMIT) || 50));
      const cursor = process.env.TASKFLOW_COMPOSIO_CURSOR || undefined;
      const result = await session.toolkits({ limit, cursor, search: process.env.TASKFLOW_COMPOSIO_SEARCH || undefined });
      await writeOut({ items: await Promise.all(result.items.map(async t => ({ slug: t.slug, name: t.name, logo: t.logo ?? null, description: await russianDescription(t.slug), connected: !!t.connection?.isActive, noAuth: t.isNoAuth }))), cursor: result.cursor ?? null, totalPages: result.totalPages ?? null });
      oneShot = true;
    } finally { await session.delete(); }
    return;
  }
  if (process.argv.includes("--authorize")) {
    // Keep the session alive while the owner completes the redirect flow.
    const session = await composio.create(userId, { ...options, toolkits: undefined });
    const connection = await session.authorize(process.env.TASKFLOW_COMPOSIO_TOOLKIT);
    await writeOut({ url: connection.redirectUrl });
    oneShot = true;
    return;
  }
  for (const action of ["accounts", "account-link", "account-delete", "mail-list", "mail-read", "mail-attachment", "mail-draft", "mail-archive", "mail-spam", "mail-send"]) {
    if (!process.argv.includes("--" + action)) continue;
    await writeOut(await manageAccounts(composio, userId, process.env.TASKFLOW_COMPOSIO_TOOLKIT, action, await readJsonInput()));
    oneShot = true;
    return;
  }
  if (process.argv.includes("--linear-read")) {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 100_000) throw new Error("input_too_large");
    }
    const input = JSON.parse(raw);
    await writeOut(await readLinearComposio(composio, userId, input));
    oneShot = true;
    return;
  }
  const hash = process.env.TASKFLOW_COMPOSIO_CACHE_KEY;
  if (!/^[a-f0-9]{64}$/.test(hash ?? "")) throw new Error("invalid_context");
  // Свои настройки подключения входят в ключ кэша: появился новый аккаунт по
  // ключу — нужна новая сессия, старая о нём не знает.
  const own = options.authConfigs ? "-" + createHash("sha256").update(JSON.stringify(options.authConfigs)).digest("hex").slice(0, 12) : "";
  const cacheFile = path.join(process.env.TASKFLOW_COMPOSIO_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "taskflow", "composio"), hash + own + ".json");
  const session = await openComposioSession(composio, options, userId, cacheFile);
  phase = "mcp_connection";
  const endpoint = new URL(session.mcp.url);
  const guardedFetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== endpoint.origin) throw new Error("MCP destination changed");
    return fetch(input, { ...init, redirect: "error" });
  };
  const remote = new Client({ name: "taskflow-composio", version: "1.0.0" });
  await remote.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: session.mcp.headers }, fetch: guardedFetch }));
  phase = "tool_catalog";
  const listed = await remote.listTools();
  const plan = process.env.TASKFLOW_COMPOSIO_MODE === "plan";
  const flat = await flatToolkitTools(composio, options, plan);
  const tools = [...(plan ? listed.tools.filter(planningToolAllowed) : listed.tools), ...flat.map(({ slug, version, ...tool }) => tool)];
  const server = new Server({ name: "taskflow-composio", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const direct = flat.find(t => t.name === request.params.name);
    if (direct) {
      const result = await composio.tools.execute(direct.slug, { userId, version: direct.version, arguments: request.params.arguments ?? {} });
      const ok = result.successful && !result.error;
      return { content: [{ type: "text", text: JSON.stringify(ok ? result.data ?? {} : { error: String(result.error ?? "operation_failed").slice(0, 2000) }) }], isError: !ok };
    }
    if (!tools.some(t => t.name === request.params.name)) throw new Error("Tool not allowed in this mode");
    return remote.callTool(request.params, undefined, { signal: extra.signal, timeout: 120_000 });
  });
  server.onclose = () => { void remote.close(); };
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => { if (oneShot) process.exit(0); })
    .catch(error => {
    // Never echo SDK request config, headers, or raw exception text.
    const status = error.status ?? error.statusCode ?? error.cause?.status;
    process.stderr.write(`Composio unavailable (${phase})` + (Number.isInteger(status) ? ` (HTTP ${status})` : "") + "\n");
    process.exitCode = 1;
  });
}
