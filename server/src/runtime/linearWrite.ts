// Узкий транспорт ЗАПИСИ в Linear через OAuth-приложение TaskFlow (карточка
// 20e30338). Отдельно от runtime/linearTransport.ts: тот намеренно разрешает
// только чтение. Здесь тоже нет произвольного GraphQL — наружу торчат ровно
// три фиксированные операции:
//
//   updateIssueState(issueId, stateId)  — сменить статус задачи;
//   createComment(issueId, body)        — добавить комментарий;
//   fetchTeamStates(teamId)             — прочитать статусы workflow команды
//                                          (нужны, чтобы резолвить id по имени).
//
// Учётные данные живут в хранилище (LINEAR_TASKFLOW_CLIENT_ID/SECRET). В
// окружении сервера их нет: токен добывается отдельным helper-процессом
// scripts/linear_oauth.mjs, которого запускает vault-run.py и подставляет
// секреты только ему. Токен кэшируется в памяти процесса; на 401 берём новый.
// Сам токен нигде не печатается и на диск не пишется.

import { spawn } from "node:child_process";
import { EnvHttpProxyAgent } from "undici";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class LinearWriteError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export type LinearTeamState = { id: string; name: string; type: string };

const ENDPOINT = "https://api.linear.app/graphql";
const TOKEN_MARGIN_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function vaultRunScript(): string {
  return process.env.TASKFLOW_VAULT_RUN ?? path.join(os.homedir(), ".claude", "vault-run.py");
}

/** Настроена ли запись: есть чем достать секрет (vault-run.py на месте). */
export function linearWriteConfigured(): boolean {
  return fs.existsSync(vaultRunScript());
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Прочитать строку из helper; секреты в argv/вывод не попадают. */
function runHelper(): Promise<string> {
  const script = path.join(process.cwd(), "scripts", "linear_oauth.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [
      vaultRunScript(),
      "--secret", "LINEAR_CLIENT_ID=LINEAR_TASKFLOW_CLIENT_ID",
      "--secret", "LINEAR_CLIENT_SECRET=LINEAR_TASKFLOW_CLIENT_SECRET",
      "--", process.execPath, script,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "", settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new LinearWriteError("Linear: получение токена не ответило вовремя.")), COMMAND_TIMEOUT_MS);
    child.on("error", () => finish(new LinearWriteError("Linear: не удалось запустить получение токена.")));
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 64 * 1024) finish(new LinearWriteError("Linear: неожиданно большой ответ токена.")); });
    child.on("close", () => finish(undefined, output));
  });
}

async function fetchToken(): Promise<{ value: string; expiresAt: number }> {
  let raw: string;
  try { raw = await runHelper(); }
  catch (error) { throw error instanceof LinearWriteError ? error : new LinearWriteError("Linear: получение токена не удалось."); }
  let parsed: { access_token?: string; expires_in?: number; error?: string };
  try { parsed = JSON.parse(raw.trim()); } catch { throw new LinearWriteError("Linear: некорректный ответ токена."); }
  if (!parsed.access_token) throw new LinearWriteError("Linear: OAuth-приложение не выдало токен. Проверьте ключи LINEAR_TASKFLOW_* в хранилище.");
  return { value: parsed.access_token, expiresAt: Date.now() + Math.max(0, parsed.expires_in ?? 0) * 1000 };
}

async function accessToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cachedToken.value;
  cachedToken = await fetchToken();
  return cachedToken.value;
}

// Прокси — явно на каждый запрос (14.10.2026). В процессе сервера SDK Pi
// ставит свой глобальный перехват, и NODE_USE_ENV_PROXY перестаёт действовать:
// запрос уходил напрямую с .110, а Linear с российского адреса отвечает 403
// «Linear is not available in Russia». Так отправка статусов не прошла ни разу
// с 06.10. Тот же приём, что у погоды в routes/widgets.ts.
let proxyDispatcher: EnvHttpProxyAgent | undefined;
function dispatcher(): EnvHttpProxyAgent | undefined {
  if (proxyDispatcher) return proxyDispatcher;
  if (!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)) return undefined;
  try { proxyDispatcher = new EnvHttpProxyAgent(); return proxyDispatcher; } catch { return undefined; }
}

type GraphqlResponse = { data?: any; errors?: Array<{ message?: string }> };

async function graphql(query: string, variables: Record<string, unknown>, retry = true): Promise<any> {
  const token = await accessToken();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher() ? { dispatcher: dispatcher() } : {}),
    } as RequestInit);
  } catch (error) {
    throw new LinearWriteError(`Linear недоступен: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401 && retry) {
    // Токен отозван или истёк — берём новый и повторяем ровно один раз.
    cachedToken = null;
    await accessToken(true);
    return graphql(query, variables, false);
  }
  if (!response.ok) {
    // Причина отказа — в сообщение: «403» без текста неделю скрывал гео-блок.
    const reason = await response.text().then(t => { try { return JSON.parse(t).error ?? ""; } catch { return ""; } }).catch(() => "");
    throw new LinearWriteError(`Linear отклонил запрос (${response.status})${reason ? ": " + String(reason).slice(0, 200) : "."}`);
  }
  let payload: GraphqlResponse;
  try { payload = await response.json() as GraphqlResponse; } catch { throw new LinearWriteError("Linear вернул некорректный ответ."); }
  if (payload.errors?.length) throw new LinearWriteError(`Linear вернул ошибку: ${payload.errors.map(e => e.message || "без описания").join("; ").slice(0, 300)}`);
  return payload.data;
}

function assertUuid(value: string, what: string): void {
  if (typeof value !== "string" || !UUID.test(value)) throw new LinearWriteError(`Linear: некорректный ${what}.`, 400);
}

/** Статусы workflow команды — только чтение, для резолва id по имени. */
export async function fetchTeamStates(teamId: string): Promise<LinearTeamState[]> {
  assertUuid(teamId, "id команды");
  const data = await graphql(`query TaskFlowTeamStates($teamId: String!) {
    team(id: $teamId) { id states { nodes { id name type } } }
  }`, { teamId });
  const nodes = data?.team?.states?.nodes;
  if (!Array.isArray(nodes)) throw new LinearWriteError("Linear не вернул статусы команды.");
  return nodes.filter((s: any) => typeof s?.id === "string" && typeof s?.name === "string" && typeof s?.type === "string")
    .map((s: any) => ({ id: s.id, name: s.name, type: s.type }));
}

/** Сменить статус задачи. Только эта мутация, произвольный GraphQL не проходит. */
export async function updateIssueState(issueId: string, stateId: string): Promise<void> {
  assertUuid(issueId, "id задачи");
  assertUuid(stateId, "id статуса");
  const data = await graphql(`mutation TaskFlowIssueState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { id name type } } }
  }`, { id: issueId, stateId });
  if (!data?.issueUpdate?.success) throw new LinearWriteError("Linear не подтвердил смену статуса.");
}

/** Добавить комментарий к задаче. */
export async function createComment(issueId: string, body: string): Promise<void> {
  assertUuid(issueId, "id задачи");
  if (typeof body !== "string" || !body.trim() || body.length > 10_000) throw new LinearWriteError("Linear: некорректный текст комментария.", 400);
  const data = await graphql(`mutation TaskFlowIssueComment($id: String!, $body: String!) {
    commentCreate(input: { issueId: $id, body: $body }) { success comment { id } }
  }`, { id: issueId, body });
  if (!data?.commentCreate?.success) throw new LinearWriteError("Linear не подтвердил комментарий.");
}

/** Только для тестов: сбросить кэш токена. */
export function __resetLinearWriteToken(): void {
  cachedToken = null;
}
