import { execFile, spawn } from "node:child_process";
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

/** ENV для execFile pi. Обёртка /home/maksim/.local/bin/pi выставляет
 *  NODE_USE_ENV_PROXY=1 — без него встроенный fetch игнорирует HTTPS_PROXY
 *  и Anthropic/OpenAI отвечают 403 (гео-блок). При execFile из Node эта
 *  переменная не наследуется автоматически. Плюс прокидываем остальной env,
 *  потому что pi читает VAULT/TOKEN/... из окружения. */
function piExecEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_USE_ENV_PROXY: "1" };
}

/** Прогон `pi --list-models` с таймаутом 15 c. Возвращает сырой stdout.
 *  Если Pi падает — кидает ошибку, вызывающий решает, что делать. */
async function runPiListModels(): Promise<string> {
  const { stdout } = await execFileAsync(
    "pi",
    ["--list-models"],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: piExecEnv() },
  );
  return stdout;
}

/** Сырое состояние провайдера по `pi auth check --json`. */
type PiAuthCheckStatus =
  | "ready"
  | "not_ready"
  | "invalid";

interface PiAuthCheck {
  status: PiAuthCheckStatus;
  provider: string;
  authType?: "oauth" | "api_key";
  reason?: string;
}

async function checkProviderStatus(provider: string): Promise<PiAuthCheck> {
  const args = ["auth", "check", "--provider", provider, "--json", "--no-refresh"];
  const { stdout } = await execFileAsync("pi", args, {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    env: piExecEnv(),
  });
  const parsed = JSON.parse(stdout) as PiAuthCheck;
  return parsed;
}

/** Путь к auth.json — единый для Pi и для TaskFlow. Совпадает с
 *  FileAuthStorageBackend в @earendil-works/pi-coding-agent. */
function getAuthPath(): string {
  return path.join(process.env.HOME ?? ".", ".pi", "agent", "auth.json");
}

interface AuthFile {
  [provider: string]: { type: "api_key" | "oauth"; key?: string; [k: string]: unknown };
}

/** Прочитать auth.json, защищённый lock-файлом. Возвращает {} если файла нет. */
async function readAuthFile(): Promise<AuthFile> {
  const authPath = getAuthPath();
  const lockPath = `${authPath}.lock`;
  for (let i = 0; i < 50; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        // lock взят
        try {
          const raw = fs.readFileSync(authPath, "utf8");
          return JSON.parse(raw) as AuthFile;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
          throw err;
        }
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Кто-то уже держит lock (Pi пишет) — подождём и ретрай.
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`auth.json lock timeout: ${lockPath}`);
}

/** Записать auth.json атомарно (tmp + rename) под lock-файлом. chmod 0o600. */
async function writeAuthFile(content: AuthFile): Promise<void> {
  const authPath = getAuthPath();
  const lockPath = `${authPath}.lock`;
  const tmpPath = `${authPath}.tmp.${process.pid}.${Date.now()}`;

  for (let i = 0; i < 50; i++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        // Запись во временный файл + atomic rename — POSIX rename.
        fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        fs.chmodSync(tmpPath, 0o600);
        fs.renameSync(tmpPath, authPath);
        // ВАЖНО: credential не логируется ни в одном слое. Здесь —
        // ни в переменных, ни в console, ни в error.
        return;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`auth.json lock timeout: ${lockPath}`);
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

/** Маппит статус из `pi auth check --json` в фасадные значения.
 *  ready → connected, not_ready → disconnected,
 *  invalid (Pi не смог прочитать auth.json) → expired. */
function mapPiStatus(
  pi: PiAuthCheck,
): { status: "connected" | "disconnected" | "expired"; authType: "oauth" | "api_key" | null } {
  if (pi.status === "ready") {
    return { status: "connected", authType: pi.authType ?? null };
  }
  if (pi.status === "invalid") {
    return { status: "expired", authType: pi.authType ?? null };
  }
  // not_ready — credentials не сконфигурированы / неизвестный провайдер.
  // Причина `provider_not_found` означает, что Pi про этот провайдер не
  // знает — listProviders() такой записи отбрасывает.
  return { status: "disconnected", authType: pi.authType ?? null };
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
    const results = await Promise.all(
      KNOWN_PROVIDERS.map(async (id) => {
        try {
          const pi = await checkProviderStatus(id);
          if (pi.reason === "provider_not_found") return null;
          const mapped = mapPiStatus(pi);
          return {
            id,
            runtime_id: RUNTIME_ID_PI,
            status: mapped.status,
            authType: mapped.authType,
            managedBy: "pi" as const,
            lastCheckedAt: new Date().toISOString(),
          };
        } catch {
          // pi auth check упал — отдаём как expired, чтобы UI мог хотя бы
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
    // Сначала узнаём тип провайдера. Pi auth check возвращает authType
    // только когда провайдер уже сконфигурирован; для НЕ-сконфигурированных
    // api_key провайдеров (то, что мы хотим подключить) authType не виден.
    // Поэтому если pi не знает authType — определяем по белому списку.
    let pi: PiAuthCheck;
    try {
      pi = await checkProviderStatus(provider);
    } catch {
      throw new Error(`pi auth check failed for ${provider}`);
    }
    const knownApiKey: ReadonlySet<string> = new Set(["minimax"]);
    const isApiKey = pi.authType === "api_key"
      || (!pi.authType && knownApiKey.has(provider));

    if (!isApiKey) {
      // OAuth провайдер: через UI ключи НЕ принимаем. Маршрут /auth
      // должен сначала вызвать authInstruction() и вернуть готовую
      // команду. Эта ветка — safety net на случай прямого вызова.
      throw new Error(
        `provider ${provider} uses OAuth; use authInstruction() and run ` +
        `the command on the owner's interactive Pi session`,
      );
    }

    const apiKey = body.apiKey;
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error(`apiKey required for ${provider}`);
    }
    // credential НЕ логируем — ни здесь, ни дальше. Длина — единственное,
    // что можно показать в случае диагностики.
    const keyLen = apiKey.length;

    const current = await readAuthFile();
    current[provider] = { type: "api_key", key: apiKey };
    await writeAuthFile(current);

    // Инвалидируем кэш моделей: новый провайдер должен сразу появиться.
    invalidateListModelsCache();

    // Проверяем через pi auth check, что Pi действительно увидел ключ.
    let after: PiAuthCheck;
    try {
      after = await checkProviderStatus(provider);
    } catch {
      throw new Error(`pi auth check after write failed for ${provider}`);
    }
    if (after.status !== "ready") {
      throw new Error(
        `api_key for ${provider} written (${keyLen} chars), but pi auth check ` +
        `still returns ${after.status}${after.reason ? ` (${after.reason})` : ""}`,
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
    const model = input.model?.trim() || undefined;

    // cmd для Pi. Подмножество того, что собирает trigger.py — тут
    // минимально, потому что RuntimeAdapter.startRun — это в первую
    // очередь «просто запустить Pi на этой задаче», а не полный
    // конвейер claim/heartbeat/usage, который живёт в trigger.py.
    const piBin = "/home/maksim/.local/bin/pi";
    const cmd: string[] = [piBin, "-p", input.prompt];

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
      runId: `run-${input.taskId.slice(0, 8)}`,
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

/** Сбрасывает кэш listModels. Экспортируется отдельно от RuntimeAdapter,
 *  потому что это внутренний хук реализации, а не часть публичного
 *  контракта. Вызывается из connectProvider() после записи credentials,
 *  чтобы новый провайдер сразу появился в списке моделей. */
export function invalidateListModelsCache(): void {
  listModelsCache = null;
}

/** Множество id моделей, реально доступных в Pi (без провайдера — модель
 *  уникальна по id, не по (provider, id): Pi использует то же имя для
 *  одной и той же модели в разных провайдерах редко). Используется
 *  PUT /api/runtime/routing для валидации — owner не может назначить
 *  роль на модель, которой Pi не знает (422 model_not_available). */
export async function getAvailableModelIds(): Promise<Set<string>> {
  const models = await piRuntime.listModels();
  return new Set(models.map((m) => m.id));
}

/** Проверяет, что модель существует в pi --list-models (по id, без
 *  провайдера). Используется PUT /api/runtime/routing. */
export async function modelExists(id: string): Promise<boolean> {
  const ids = await getAvailableModelIds();
  return ids.has(id);
}
