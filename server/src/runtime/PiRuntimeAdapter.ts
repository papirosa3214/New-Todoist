import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  ): Promise<ProviderConnection> {
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
      // OAuth провайдер: через UI ключи НЕ принимаем. Маршрут /auth
      // должен сначала вызвать authInstruction() и вернуть готовую
      // команду. Эта ветка — safety net на случай прямого вызова.
      throw new Error(
        `provider ${provider} uses OAuth; use authInstruction() and run ` +
        `the command on the owner's interactive Pi session`,
      );
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
      lastCheckedAt: new Date().toISOString(),
    };
  },

  async authInstruction(provider: string): Promise<AuthInstruction> {
    // Любая модель этого провайдера подойдёт — Pi сам откроет OAuth-браузер
    // и проведёт flow. Берём первую попавшуюся через listModels(); если
    // моделей нет (провайдер не сконфигурирован), даём универсальную
    // команду — Pi по `--provider` всё равно поднимет flow.
    let modelPattern = "<model>";
    try {
      const models = await piRuntime.listModels();
      const candidate = models.find((m) => m.provider === provider);
      if (candidate) modelPattern = candidate.id;
    } catch {
      /* listModels может упасть — окей, отдаём общую команду */
    }
    return {
      status: "auth_required",
      provider,
      command:
        `pi --provider ${provider} --model ${modelPattern} "ping"`,
      note:
        "Запустите команду на машине с интерактивным Pi. Pi откроет " +
        "OAuth-браузер, после успешного входа вернитесь сюда и нажмите " +
        "«Переподключить».",
    };
  },

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    // Формируем spec для launcher'а. Задача загружается из БД; роль,
    // модель, prompt берутся из input. cmd собирается здесь, потому что
    // это бизнес-логика (какие флаги Pi получает для роли), а не
    // механика запуска (которая в launcher).
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
    const role: string | undefined = task.dispatched_role ?? task.role ?? input.agentId;
    // 18.09.2026 (правка startRun): input.model и input.provider
    // передаются в Pi явно, без промежуточного `const model = ...`,
    // который раньше вычислялся, но в cmd не попадал. Если поля не
    // заданы — соответствующий флаг не добавляется.
    const trimmedProvider = input.provider?.trim();
    const trimmedModel = input.model?.trim();

    // cmd для Pi. Подмножество того, что собирает trigger.py — тут
    // минимально, потому что RuntimeAdapter.startRun — это в первую
    // очередь «просто запустить Pi на этой задаче», а не полный
    // конвейер claim/heartbeat/usage, который живёт в trigger.py.
    const piBin = "/home/maksim/.local/bin/pi";
    const cmd: string[] = [piBin];
    if (trimmedProvider) cmd.push("--provider", trimmedProvider);
    if (trimmedModel) cmd.push("--model", trimmedModel);
    cmd.push("-p", input.prompt);

    const spec = {
      cmd,
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      cwd: process.cwd(),
      timeout: 3600,
      agent_label: `runtime:${role ?? "unknown"}`,
      usage_path: undefined as string | undefined,
      kill_event: undefined as unknown, // Node EventEmitter для kill не пробрасываем (см. ниже)
    };

    // spawn python3 с start_agent_run.py, JSON stdin → JSON stdout.
    // Возвращаем сразу {runId, status: 'queued'} — реальный результат
    // придёт через getRun(runId), когда launcher закончит (см. ниже
    // фоновый обработчик stdout).
    const proc = spawn(
      "python3",
      [path.join(process.cwd(), "server", "scripts", "start_agent_run.py")],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    proc.stdin.end(JSON.stringify(spec));

    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      // spawn не смог стартовать (ENOENT и т.п.) — пишем в agent_state,
      // чтобы планировщик мог ретраить.
      try {
        db.prepare(
          `UPDATE tasks SET agent_state = 'blocked', updated_at = datetime('now')
             WHERE id = ?`,
        ).run(input.taskId);
      } catch { /* ignore — задача могла быть удалена */ }
      console.error(`[startRun] spawn error for ${input.taskId}: ${err.message}`);
    });
    proc.on("close", () => {
      // Парсим stdout как JSON. credential/log НЕ логируем. stderr
      // пишем только если там что-то есть (диагностика для разработчика).
      let result: { status: string; returncode: number | null; output_tail: string;
        usage: unknown; error: string | null } | null = null;
      try {
        if (stdout.trim()) result = JSON.parse(stdout);
      } catch (e) {
        console.error(`[startRun] bad JSON from launcher for ${input.taskId}: ${(e as Error).message}`);
        console.error(`[startRun] stderr: ${stderr.slice(0, 500)}`);
      }
      if (!result) return;

      // Обновляем agent_state по результату.
      let nextState: "review" | "blocked" | "in_progress" = "in_progress";
      if (result.status === "ok" && result.returncode === 0) nextState = "review";
      else if (result.status !== "ok") nextState = "blocked";
      try {
        db.prepare(
          `UPDATE tasks SET agent_state = ?, agent_finished_at = datetime('now'),
                   updated_at = datetime('now')
             WHERE id = ?`,
        ).run(nextState, input.taskId);
      } catch { /* ignore */ }
      if (stderr.trim()) {
        console.log(`[startRun:${input.taskId.slice(0, 8)}] ${stderr.slice(0, 500)}`);
      }
    });

    return {
      runId: crypto.randomUUID(),
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
