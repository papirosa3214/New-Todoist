import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ModelRuntime,
  RpcClient,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import db from "../db.js";
import {
  ROLE_NAMES,
  type RoleName,
  loadRoleRouting,
} from "../roleRouting.js";
import type {
  AgentProfile,
  AgentRun,
  Model,
  ProviderConnection,
  Runtime,
} from "./types.js";
import { RUNTIME_ID_PI } from "./types.js";
import {
  UnsupportedInFacadeError,
  type AuthInteractive,
  type AuthInteractiveEvent,
  type AuthInstruction,
  type ConnectProviderInput,
  type RuntimeAdapter,
  type StartRunInput,
  type StartRunResult,
} from "./RuntimeAdapter.js";

const ROLE_PROMPTS_DIR = process.env.TASKFLOW_ROLE_PROMPTS_DIR
  ?? path.join(process.cwd(), "scripts", "role-prompts");

const ROLE_PROFILES_DIR = process.env.TASKFLOW_ROLE_PROFILES_DIR
  ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");

// 18.09.2026 (правка SDK): вся самописная обвязка вокруг `pi auth check`
// / `pi --list-models` / `~/.pi/agent/auth.json` удалена. Источник
// правды — ModelRuntime из @earendil-works/pi-coding-agent. Кэш моделей
// и credentials тоже на стороне SDK: он сам инвалидирует снимок при
// записи credentials (см. setRuntimeApiKey). TaskFlow просто мапит
// ответы SDK в фасадные типы.
//
// SDK API (из dist/core/model-runtime.d.ts):
//   checkAuth(id)              → { source?: string, type: "api_key"|"oauth" } | undefined
//   getProviderAuthStatus(id)  → { configured: boolean, source?: ..., label?: string }
//   getAvailable(id?)          → readonly Model<Api>[] (полный снимок авторизованных моделей)
//   setRuntimeApiKey(id, key)  → пишет в ~/.pi/agent/auth.json сам SDK
//   getProviders()             → readonly Provider[] (зарегистрированные провайдеры)
//
// Реальные типы AuthCheck/AuthStatus/Model живут в peer-dep
// @earendil-works/pi-ai, который вложен в pi-coding-agent и не
// доступен как top-level зависимость. Описываем нужные поля
// структурно через Awaited<ReturnType<...>>, чтобы не тянуть ещё одну
// зависимость ради одного типа.

type AuthCheck = NonNullable<Awaited<ReturnType<ModelRuntime["checkAuth"]>>>;
type AuthStatus = Awaited<ReturnType<ModelRuntime["getProviderAuthStatus"]>>;
type SdkModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

/** Singleton ModelRuntime. ModelRuntime.create() — асинхронный (поднимает
 *  каталог провайдеров, читает credentials, проверяет доступность
 *  моделей), поэтому держим его в lazy-переменной. */
let modelRuntime: ModelRuntime | null = null;
async function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntime) {
    modelRuntime = await ModelRuntime.create();
  }
  return modelRuntime;
}

/** Маппит AuthStatus.configured в фасадный статус провайдера.
 *  SDK разделяет «есть ли credentials» (configured) и «какой именно
 *  тип credentials есть» (checkAuth().type). Старое CLI `pi auth
 *  check --json` совмещало это в один объект со status="ready"; в
 *  новой модели это два независимых запроса, и configured=true
 *  → connected. */
function mapAuthStatus(s: AuthStatus): "connected" | "disconnected" | "expired" {
  if (s.configured) return "connected";
  // SDK не различает «не сконфигурирован» и «expired» через
  // getProviderAuthStatus — это решает checkAuth() в listProviders()
  // по признаку source. Здесь просто «не подключён».
  return "disconnected";
}

/** Маппит AuthEvent (из SDK AuthInteraction) в фасадный AuthInteractiveEvent.
 *  SDK типы не реэкспортируются из pi-coding-agent (живут в peer-dep
 *  pi-ai), и без них — структурный маппинг через поля. Поле `type`
 *  определяет, какие дополнительные поля присутствуют. */
function mapAuthEvent(
  provider: string,
  raw: unknown,
): AuthInteractiveEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as {
    type?: unknown;
    url?: unknown;
    instructions?: unknown;
    userCode?: unknown;
    verificationUri?: unknown;
    intervalSeconds?: unknown;
    expiresInSeconds?: unknown;
    message?: unknown;
  };
  switch (ev.type) {
    case "auth_url":
      if (typeof ev.url !== "string") return null;
      return {
        kind: "auth_url",
        provider,
        url: ev.url,
        instructions: typeof ev.instructions === "string"
          ? ev.instructions
          : undefined,
      };
    case "device_code":
      if (
        typeof ev.userCode !== "string" ||
        typeof ev.verificationUri !== "string"
      ) {
        return null;
      }
      return {
        kind: "device_code",
        provider,
        userCode: ev.userCode,
        verificationUri: ev.verificationUri,
        intervalSeconds: typeof ev.intervalSeconds === "number"
          ? ev.intervalSeconds
          : undefined,
        expiresInSeconds: typeof ev.expiresInSeconds === "number"
          ? ev.expiresInSeconds
          : undefined,
      };
    case "progress":
      if (typeof ev.message !== "string") return null;
      return { kind: "progress", provider, message: ev.message };
    case "info":
      if (typeof ev.message !== "string") return null;
      return { kind: "info", provider, message: ev.message };
    default:
      return null;
  }
}

/** Запускает OAuth login через ModelRuntime.login + AuthInteraction.
 *  Возвращает AuthInteractive — UI подписывается на events и ждёт
 *  completed. SDK login() пишет credentials в ~/.pi/agent/auth.json
 *  сам (через свой CredentialStore), TaskFlow ничего не пишет на диск.
 *
 *  manual_code/select/text prompt'ы не поддержаны в TaskFlow UI:
 *  prompt() reject'ит их сразу. Это упрощает flow — TaskFlow UI
 *  рассчитан на browser-callback (auth_url) и device-code, без
 *  ручного ввода. Если провайдер требует manual_code — login() упадёт,
 *  и completed реджектится с ошибкой.
 */
async function startProviderLogin(
  rt: ModelRuntime,
  provider: string,
): Promise<AuthInteractive> {
  // Очередь с backpressure. notify() пушит событие; если есть
  // ожидающий next() — резолвит его сразу. Если notify() приходит
  // до next() — кладёт в буфер, next() заберёт при вызове.
  let resolveNext: ((value: IteratorResult<AuthInteractiveEvent>) => void) | null = null;
  const queue: AuthInteractiveEvent[] = [];
  let closed = false;

  function push(item: AuthInteractiveEvent) {
    if (closed) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: item, done: false });
    } else {
      queue.push(item);
    }
  }
  function finish() {
    if (closed) return;
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined, done: true });
    }
  }

  let resolveCompleted!: () => void;
  let rejectCompleted!: (e: Error) => void;
  const completed = new Promise<void>((res, rej) => {
    resolveCompleted = res;
    rejectCompleted = rej;
  });
  let cancelled = false;
  const abort = new AbortController();

  const interaction = {
    signal: abort.signal,
    notify: (event: unknown) => {
      if (cancelled) return;
      const mapped = mapAuthEvent(provider, event);
      if (mapped) push(mapped);
    },
    prompt: (p: unknown) => {
      if (cancelled) {
        return Promise.reject(new Error("Login cancelled"));
      }
      // TaskFlow UI не поддерживает text/secret/select/manual_code:
      // показываем информацию о причине в логе и reject'им prompt, чтобы
      // SDK прервал flow с понятной ошибкой. На auth_url/device_code Pi
      // этот код не вызывается.
      const pp = p as { type?: string; message?: string };
      const kind = pp.type ?? "unknown";
      console.warn(
        `[startProviderLogin:${provider}] prompt(${kind}) не поддержан в TaskFlow UI; реджектим`,
      );
      return Promise.reject(
        new Error(
          `prompt type=${kind} не поддержан в TaskFlow UI ` +
            `(provider ${provider})`,
        ),
      );
    },
  };

  // Запускаем SDK login() в фоне. resolved → completed; rejected → completed
  // реджектится с тем же reason. В обоих случаях закрываем очередь.
  rt.login(provider, "oauth", interaction as never)
    .then(() => {
      if (cancelled) return;
      resolveCompleted();
      finish();
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      rejectCompleted(err instanceof Error ? err : new Error(String(err)));
      finish();
    });

  // AsyncIterable: UI делает `for await (const ev of authInteractive.events)`
  // и получает события по мере прихода. Семантика:
  //   - пока есть элементы в буфере — выдаём по одному;
  //   - иначе ждём push() или finish() (или cancelled/closed);
  //   - cancelled/closed завершают итератор вне зависимости от буфера.
  const iterable: AsyncIterable<AuthInteractiveEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AuthInteractiveEvent>> {
          if (cancelled || closed) {
            // Может остаться буфер — выдаём, потом закрываемся.
            if (queue.length > 0 && !cancelled) {
              return { value: queue.shift() as AuthInteractiveEvent, done: false };
            }
            return { value: undefined, done: true };
          }
          if (queue.length > 0) {
            return { value: queue.shift() as AuthInteractiveEvent, done: false };
          }
          // Ждём нового события или завершения.
          return new Promise<IteratorResult<AuthInteractiveEvent>>((resolve) => {
            resolveNext = (v) => resolve(v);
          });
        },
      };
    },
  };

  return {
    status: "auth_required",
    provider,
    events: iterable,
    completed,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      rejectCompleted(new Error("Login cancelled by user"));
      finish();
    },
  };
}

interface ProfileConfig {
  mcpServers?: {
    taskflow?: {
      env?: Record<string, string>;
    };
  };
}

function readPromptSize(role: RoleName): { source: string; size: number } {
  const file = path.join(ROLE_PROMPTS_DIR, `${role}.md`);
  try {
    const stat = fs.statSync(file);
    return { source: file, size: stat.size };
  } catch {
    return { source: file, size: 0 };
  }
}

function readRoleTools(role: RoleName): string[] {
  const file = path.join(ROLE_PROFILES_DIR, `${role}.json`);
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as ProfileConfig;
    const tools = config.mcpServers?.taskflow?.env?.TASKFLOW_MCP_TOOLS;
    if (!tools) return [];
    return tools.split(",").map((t) => t.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readRoleSkills(role: RoleName) {
  return db
    .prepare(
      `SELECT skill_name, description FROM role_skills WHERE role = ? ORDER BY skill_name`,
    )
    .all(role) as Array<{ skill_name: string; description: string | null }>;
}

function readRoleAccount(role: RoleName) {
  return db
    .prepare(
      `SELECT id, name, permissions, status, last_seen_at
         FROM users WHERE role = ? ORDER BY created_at LIMIT 1`,
    )
    .get(role) as
      | {
          id: string;
          name: string;
          permissions: string | null;
          status: string | null;
          last_seen_at: string | null;
        }
      | undefined;
}

async function piAlive(): Promise<boolean> {
  try {
    const { unitState } = await import("../routes/agent-service.js");
    return (await unitState()).active;
  } catch {
    return false;
  }
}

async function buildProfile(
  role: RoleName,
  alive: boolean,
): Promise<AgentProfile> {
  const routing = loadRoleRouting();
  const account = readRoleAccount(role);
  const skills = readRoleSkills(role).map((s) => ({
    name: s.skill_name,
    description: s.description,
  }));
  const tools = readRoleTools(role);
  const prompt = readPromptSize(role);
  const work = db
    .prepare(
      `SELECT agent_state FROM tasks
        WHERE status = 'active' AND dispatched_role = ?
          AND agent_state IN ('in_progress', 'blocked')
        LIMIT 1`,
    )
    .get(role) as { agent_state: string } | undefined;
  let status: AgentProfile["status"] = "ready";
  if (!account) status = "unavailable";
  else if (!alive) status = "unavailable";
  else if (work?.agent_state === "in_progress") status = "working";
  else if (work?.agent_state === "blocked") status = "blocked";
  return {
    id: role,
    role,
    title: account?.name ?? role,
    account_id: account?.id ?? "",
    runtime_id: RUNTIME_ID_PI,
    prompt,
    skills,
    tools,
    permissions: account?.permissions ?? null,
    modelPolicy: {
      primary: routing.models[role],
      fallbacks: routing.fallbacks[role],
    },
    status,
  };
}

/** Список известных провайдеров. Имена совпадают с тем, как Pi их знает
 *  внутри (см. ~/.pi/agent/auth.json: anthropic, openai-codex, minimax).
 *  Имя "openai-codex" — каноническое для OpenAI через Codex OAuth; "openai"
 *  Pi не знает и вернёт provider_not_found. */
const KNOWN_PROVIDERS = ["anthropic", "openai-codex", "minimax"] as const;

export const piRuntime: RuntimeAdapter = {
  id: RUNTIME_ID_PI,

  async status(): Promise<Runtime> {
    const alive = await piAlive();
    return {
      id: RUNTIME_ID_PI,
      kind: "pi",
      status: alive ? "ready" : "down",
      // Версия — из npm bin или из version-файла Pi. На первом этапе —
      // строка-маркер; реальная версия появится, когда Pi её отдаст.
      version: process.env.PI_VERSION ?? "unknown",
      endpoint: process.env.PI_ENDPOINT ?? "cli",
    };
  },

  async listProfiles(): Promise<AgentProfile[]> {
    const alive = await piAlive();
    return Promise.all(ROLE_NAMES.map((r) => buildProfile(r, alive)));
  },

  async listModels(): Promise<Model[]> {
    try {
      const rt = await getModelRuntime();
      const available = await rt.getAvailable();
      // SDK возвращает {id, provider, ...} — мапим в фасадный Model.
      // Дедупликация не нужна: SDK уже отдаёт уникальные (provider, id).
      const seen = new Set<string>();
      const models: Model[] = [];
      for (const m of available) {
        const sm = m as SdkModel;
        const key = `${sm.provider}:${sm.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({
          id: sm.id,
          provider: sm.provider,
          runtime_id: RUNTIME_ID_PI,
          available: true,
        });
      }
      return models;
    } catch {
      // Pi недоступен / упал — отдаём пустой массив. UI покажет «нет
      // моделей», не 500. Кэшем здесь не управляем — это на стороне
      // ModelRuntime (см. getAvailableSnapshot + refresh()).
      return [];
    }
  },

  async listProviders(): Promise<ProviderConnection[]> {
    const rt = await getModelRuntime();
    const results = await Promise.all(
      KNOWN_PROVIDERS.map(async (id) => {
        try {
          const [check, status] = await Promise.all([
            rt.checkAuth(id),
            Promise.resolve(rt.getProviderAuthStatus(id)),
          ]);
          if (!check) return null; // SDK не знает этот провайдер
          const c = check as AuthCheck;
          const s = status as AuthStatus;
          return {
            id,
            runtime_id: RUNTIME_ID_PI,
            status: mapAuthStatus(s),
            authType: c.type,
            managedBy: "pi" as const,
            lastCheckedAt: new Date().toISOString(),
          };
        } catch {
          // checkAuth упал — отдаём как expired, чтобы UI мог хотя бы
          // показать «не отвечает» и попробовать позже.
          return {
            id,
            runtime_id: RUNTIME_ID_PI,
            status: "expired" as const,
            authType: null,
            managedBy: "pi" as const,
            lastCheckedAt: new Date().toISOString(),
          };
        }
      }),
    );
    return results.filter((p): p is NonNullable<typeof p> => p !== null);
  },

  async connectProvider(
    provider: string,
    body: ConnectProviderInput,
  ): Promise<ProviderConnection | AuthInteractive> {
    const rt = await getModelRuntime();
    // Определяем тип провайдера через SDK. checkAuth() возвращает
    // { type: "api_key"|"oauth" } если credentials уже есть; для
    // НЕ-сконфигурированного api_key провайдера (то, что мы хотим
    // подключить) — undefined. Опираемся на белый список для OAuth.
    const check = await rt.checkAuth(provider);
    const c = check as AuthCheck | undefined;
    const knownOauth: ReadonlySet<string> = new Set(["anthropic", "openai-codex"]);
    const isOauth = c?.type === "oauth" || (c === undefined && knownOauth.has(provider));

    if (isOauth) {
      // OAuth провайдер: вместо записи ключей запускаем
      // ModelRuntime.login() с AuthInteraction. UI получает
      // AuthInteractive — стрим событий (auth_url/device_code/...)
      // + Promise completed. SDK сам пишет credentials после успешного
      // flow в свой CredentialStore.
      return startProviderLogin(rt, provider);
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      throw new Error(`apiKey required for ${provider}`);
    }
    // credential НЕ логируем — ни здесь, ни дальше. Длина — единственное,
    // что можно показать в случае диагностики.
    const keyLen = apiKey.length;

    // SDK сам пишет в ~/.pi/agent/auth.json (через свой
    // CredentialStore), сам инвалидирует кэш моделей и credentials,
    // и не требует от нас lock-файла. Возвращаемый Promise<void>
    // резолвится после успешной записи и обновления снимка.
    await rt.setRuntimeApiKey(provider, apiKey);

    // Проверяем через SDK, что Pi действительно увидел ключ: после
    // записи getProviderAuthStatus должен показать configured=true.
    const status = rt.getProviderAuthStatus(provider) as AuthStatus;
    if (!status.configured) {
      throw new Error(
        `api_key for ${provider} written (${keyLen} chars), but getProviderAuthStatus ` +
        `still returns configured=false${status.source ? ` (source=${status.source})` : ""}`,
      );
    }
    return {
      id: provider,
      runtime_id: RUNTIME_ID_PI,
      status: "connected",
      managedBy: "pi",
      authType: "api_key",
      lastCheckedAt: new Date().toISOString(),
    };
  },

  async authInstruction(
    provider: string,
  ): Promise<AuthInstruction | AuthInteractive> {
    // 18.09.2026 (правка AuthInteraction): старая текстовая команда
    // для интерактивного TUI больше не нужна — TaskFlow UI получает
    // тот же AuthInteractive, что и connectProvider(OAuth).
    // authInstruction оставлен в RuntimeAdapter ради обратной
    // совместимости с уже-собранным UI, который знает про этот метод.
    const rt = await getModelRuntime();
    return startProviderLogin(rt, provider);
  },

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    // 18.09.2026 (правка SDK): startRun идёт через официальный
    // RpcClient из @earendil-works/pi-coding-agent, который спавнит
    // `pi --mode rpc` под капотом. Никакого Python/JSON RPC поверх
    // CLI: SDK берёт на себя протокол, мы только подписываемся на
    // события (session_start → agent_session_id, agent_end →
    // agent_state review/blocked).
    //
    // Поведение сохраняется: возвращаем сразу {runId, status: queued}
    // — реальное обновление БД идёт в background через onEvent.
    const task = db
      .prepare(
        `SELECT id, assignee_id, dispatched_role, role FROM tasks WHERE id = ?`,
      )
      .get(input.taskId) as
      | { id: string; assignee_id: string | null; dispatched_role: string | null; role: string | null }
      | undefined;
    if (!task) {
      throw new Error(`task ${input.taskId} not found`);
    }
    // Намеренно НЕ вычисляем `const model = input.model?.trim() || undefined` —
    // раньше это была впустую, сейчас поля напрямую идут в RpcClient.
    const trimmedProvider = input.provider?.trim();
    const trimmedModel = input.model?.trim();

    const runId = crypto.randomUUID();
    const client = new RpcClient({
      cliPath: "/home/maksim/.local/bin/pi",
      cwd: process.cwd(),
      provider: trimmedProvider,
      model: trimmedModel,
      // NODE_USE_ENV_PROXY=1 — без него Pi встроенный fetch игнорирует
      // HTTPS_PROXY и провайдеры отвечают 403 (гео-блок). Остальной env
      // пробрасываем, потому что Pi читает VAULT/TOKEN/... из окружения.
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    });

    // Подписываемся на события ДО client.start() — к этому моменту
    // события ещё не идут, но onEvent сохранит listener, и первый
    // session_start мы поймаем.
    client.onEvent((event: JsonAgentSessionEvent) => {
      const e = event as { type: string; [k: string]: unknown };
      if (e.type === "session_start") {
        // SDK шлёт session id; кладём в tasks.agent_session_id для
        // последующих getRun() и для UI.
        const sid = (e as { sessionId?: string }).sessionId;
        if (typeof sid === "string" && sid) {
          try {
            db.prepare(
              `UPDATE tasks SET agent_session_id = ?, agent_started_at = datetime('now'),
                       updated_at = datetime('now')
                 WHERE id = ?`,
            ).run(sid, input.taskId);
          } catch { /* задача могла быть удалена */ }
        }
        return;
      }
      if (e.type === "agent_end") {
        // success — флаг в AgentSessionEvent, который JsonAgentSessionEvent
        // наследует. Если не пришёл — считаем попытку неуспешной
        // (безопасный default: blocked, планировщик может ретраить).
        const ok = (e as { success?: boolean }).success ?? false;
        const next: "review" | "blocked" = ok ? "review" : "blocked";
        try {
          db.prepare(
            `UPDATE tasks SET agent_state = ?, agent_finished_at = datetime('now'),
                     updated_at = datetime('now')
               WHERE id = ?`,
          ).run(next, input.taskId);
        } catch { /* ignore */ }
        // Гасим RPC процесс — он сам себя не закрывает после agent_end.
        client.stop().catch(() => { /* процесс уже умер — окей */ });
      }
    });

    // Стартуем процесс и отправляем prompt. start() спавнит `pi --mode
    // rpc`, дожидается handshake'а. prompt() шлёт первое сообщение
    // агенту; далее стрим событий идёт через onEvent.
    try {
      await client.start();
      await client.prompt(input.prompt);
    } catch (err) {
      // Process не поднялся (ENOENT, провайдер не настроен и т.п.) —
      // пишем blocked, чтобы планировщик мог ретраить.
      try {
        db.prepare(
          `UPDATE tasks SET agent_state = 'blocked', updated_at = datetime('now')
             WHERE id = ?`,
        ).run(input.taskId);
      } catch { /* ignore — задача могла быть удалена */ }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[startRun] RpcClient failed for ${input.taskId}: ${msg}`);
      throw err;
    }

    return {
      runId,
      sessionId: "",
      status: "queued",
    };
  },

  async sendMessage(_runId: string, _text: string): Promise<void> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.sendMessage() недоступен: диалог с запущенным " +
        "Pi-заходом ведётся через claim/message API карточки, а не через runtime.",
    );
  },

  async cancelRun(_runId: string): Promise<void> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.cancelRun() недоступен: отмена — через cancel " +
        "на карточке, см. /api/tasks/:id/cancel.",
    );
  },

  async getRun(runId: string): Promise<AgentRun> {
    const task = db
      .prepare(
        `SELECT id, assignee_id, dispatched_role, agent_session_id,
                agent_started_at, agent_finished_at, stop_reason, agent_state
           FROM tasks WHERE id = ?`,
      )
      .get(runId) as
      | {
          id: string;
          assignee_id: string | null;
          dispatched_role: string | null;
          agent_session_id: string | null;
          agent_started_at: string | null;
          agent_finished_at: string | null;
          stop_reason: string | null;
          agent_state: string | null;
        }
      | undefined;
    if (!task) {
      throw new Error(`AgentRun ${runId}: задача не найдена`);
    }
    return {
      id: `run-${task.id.slice(0, 8)}`,
      task_id: task.id,
      agent_id: task.dispatched_role ?? task.assignee_id ?? "",
      runtime_id: RUNTIME_ID_PI,
      provider: null,
      model: null,
      session_id: task.agent_session_id,
      status:
        task.agent_state === "in_progress"
          ? "running"
          : task.agent_state === "review"
          ? "completed"
          : task.agent_state === "blocked"
          ? "failed"
          : "queued",
      started_at: task.agent_started_at ?? new Date().toISOString(),
      finished_at: task.agent_finished_at,
      stop_reason: task.stop_reason,
    };
  },
};

/** Множество id моделей, реально доступных в Pi (без провайдера — модель
 *  уникальна по id, не по (provider, id): Pi использует то же имя для
 *  одной и той же модели в разных провайдерах редко). Используется
 *  PUT /api/runtime/routing для валидации — owner не может назначить
 *  роль на модель, которой Pi не знает (422 model_not_available).
 *
 * 18.09.2026 (правка SDK): идём через ModelRuntime.getAvailable() —
 *  SDK сам держит снимок и не дёргает сеть на каждый вызов.
 *  Самописный listModelsCache удалён, invalidateListModelsCache
 *  больше не нужен: SDK сам инвалидирует снимок при setRuntimeApiKey.
 */
export async function getAvailableModelIds(): Promise<Set<string>> {
  const rt = await getModelRuntime();
  const available = await rt.getAvailable();
  return new Set(available.map((m) => (m as SdkModel).id));
}

/** Проверяет, что модель существует в ModelRuntime (по id, без
 *  провайдера). Используется PUT /api/runtime/routing. */
export async function modelExists(id: string): Promise<boolean> {
  const ids = await getAvailableModelIds();
  return ids.has(id);
}
