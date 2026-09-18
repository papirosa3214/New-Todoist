import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
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
  type RuntimeAdapter,
  type StartRunInput,
  type StartRunResult,
} from "./RuntimeAdapter.js";

const ROLE_PROMPTS_DIR = process.env.TASKFLOW_ROLE_PROMPTS_DIR
  ?? path.join(process.cwd(), "scripts", "role-prompts");

const ROLE_PROFILES_DIR = process.env.TASKFLOW_ROLE_PROFILES_DIR
  ?? path.join(process.env.HOME ?? ".", ".pi", "agent", "taskflow-profiles");

const execFileAsync = promisify(execFile);

/** TTL кэша listModels: 10 с. Достаточно, чтобы UI не дёргал `pi`
 *  на каждый рендер, и при этом изменения в каталоге моделей Pi
 *  подхватываются почти мгновенно. */
const LIST_MODELS_CACHE_TTL_MS = 10_000;

interface PiListModelsCache {
  at: number;
  models: Model[];
}

let listModelsCache: PiListModelsCache | null = null;

/** Парсит TSV-вывод `pi --list-models`. Шапка пропускается. Колонки:
 *  provider / model / context / max-out / thinking / images. Формат
 *  задокументирован в @earendil-works/pi-coding-agent/dist/cli/list-models.js.
 *  Устойчив к разному числу колонок — лишнее игнорируем, недостающее
 *  становится undefined и пропускается при формировании Model. */
export function parsePiListModels(
  output: string,
): Array<{ provider: string; id: string }> {
  const lines = output.split(/\r?\n/);
  const result: Array<{ provider: string; id: string }> = [];
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }
    const cols = line.split(/\s+/);
    const [provider, id] = cols;
    if (!provider || !id) continue;
    result.push({ provider, id });
  }
  return result;
}

/** Прогон `pi --list-models` с таймаутом 15 c. Возвращает сырой stdout.
 *  Если Pi падает — кидает ошибку, вызывающий решает, что делать. */
async function runPiListModels(): Promise<string> {
  const { stdout } = await execFileAsync(
    "pi",
    ["--list-models"],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
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

/** Список известных провайдеров. Реальный auth живёт в Pi/vault; здесь
 *  это просто имена для /api/runtime/providers и connectProvider() (заглушка). */
const KNOWN_PROVIDERS = ["anthropic", "openai", "minimax"] as const;

function providerStatusFromEnv(
  provider: string,
): "connected" | "disconnected" | "expired" {
  // Heuristic: реальный статус приходит из Pi/vault. Здесь — фолбэк
  // для сухого прогона и тестов. Реальная проверка — в connectProvider().
  const envKey = `TASKFLOW_${provider.toUpperCase()}_TOKEN`;
  if (process.env[envKey]) return "connected";
  return "disconnected";
}

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
    const now = Date.now();
    if (listModelsCache && now - listModelsCache.at < LIST_MODELS_CACHE_TTL_MS) {
      return listModelsCache.models;
    }
    let stdout: string;
    try {
      stdout = await runPiListModels();
    } catch {
      // Pi недоступен / упал — кэш не трогаем, отдаём пустой массив.
      // UI покажет «нет моделей», не 500.
      return [];
    }
    const parsed = parsePiListModels(stdout);
    const seen = new Set<string>();
    const models: Model[] = [];
    for (const { provider, id } of parsed) {
      const key = `${provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({
        id,
        provider,
        runtime_id: RUNTIME_ID_PI,
        // available уточняется отдельным вызовом listProviders(); здесь
        // отдаём true по умолчанию, чтобы UI не блокировал выбор.
        available: true,
      });
    }
    listModelsCache = { at: now, models };
    return models;
  },

  async listProviders(): Promise<ProviderConnection[]> {
    return KNOWN_PROVIDERS.map((p) => ({
      id: p,
      runtime_id: RUNTIME_ID_PI,
      status: providerStatusFromEnv(p),
      managedBy: "pi" as const,
      lastCheckedAt: null,
    }));
  },

  async startRun(_input: StartRunInput): Promise<StartRunResult> {
    throw new UnsupportedInFacadeError(
      "PiRuntimeAdapter.startRun() недоступен в этой версии фасада: " +
        "запуск процесса делает server/scripts/trigger.py. " +
        "См. карточку f3108dcc — Task 9.",
    );
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

/** Сбрасывает кэш listModels. Экспортируется отдельно от RuntimeAdapter,
 *  потому что это внутренний хук реализации, а не часть публичного
 *  контракта. Вызывается из connectProvider() после записи credentials,
 *  чтобы новый провайдер сразу появился в списке моделей. */
export function invalidateListModelsCache(): void {
  listModelsCache = null;
}
