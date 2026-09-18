// Фасадные типы рантайма. Источники правды остаются прежними:
// users, role-routing.yaml, role-prompts/, vault, taskflow-profiles/.
// Этот модуль — только терминология и валидаторы для API.

/** Канонический id единственного рантайма — Pi. Жёсткое ограничение
 *  первого этапа: расширение (ClaudeCode, Codex) отложено, см. спек
 *  docs/superpowers/specs/2026-09-18-pi-runtime-facade.md. */
export const RUNTIME_ID_PI = "runtime:pi" as const;
export type RuntimeId = typeof RUNTIME_ID_PI;
export type RuntimeKind = "pi";

export interface Runtime {
  id: RuntimeId;
  kind: RuntimeKind;
  status: "ready" | "starting" | "down";
  version: string;
  endpoint: string;
}

export interface AgentProfile {
  id: string;
  role: string;
  title: string;
  account_id: string;
  runtime_id: RuntimeId;
  prompt: { source: string; size: number };
  skills: Array<{ name: string; description: string | null }>;
  tools: string[];
  permissions: string | null;
  modelPolicy: {
    primary: string;
    fallbacks: string[];
  };
  status: "ready" | "working" | "blocked" | "unavailable";
}

export interface Model {
  id: string;
  provider: string;
  runtime_id: RuntimeId;
  available: boolean;
  /** Человекочитаемое имя из каталога Pi (Model.name). */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Умеет ли модель thinking (Model.reasoning). */
  thinking?: boolean;
  /** Принимает ли модель изображения (Model.input includes "image"). */
  images?: boolean;
}

/** Способы авторизации, которые провайдер объявляет в Pi. UI показывает
 *  обе кнопки, если доступны оба: OAuth и ввод api key. */
export type AuthMethod = "api_key" | "oauth";

export interface ProviderConnection {
  id: string;
  runtime_id: RuntimeId;
  status: "connected" | "disconnected" | "expired";
  managedBy: "pi";
  lastCheckedAt: string | null;
  /** Человекочитаемое имя провайдера из Pi (Provider.name). */
  name?: string;
  /** Тип ТЕКУЩИХ credentials: api_key или oauth. null = credentials нет. */
  authType?: "api_key" | "oauth" | null;
  /** Какие способы авторизации вообще поддерживает провайдер в Pi. */
  authMethods?: AuthMethod[];
}

/** Один attempt (попытка) внутри AgentRun/задачи. История unknown →
 *  completed не переписывается: при fallback создаётся новый attempt с
 *  своей моделью, старый навсегда сохраняет первоначальную (спека §12). */
export interface AgentAttempt {
  id: string;
  model: string | null;
  provider: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  outcome: string | null;
  started_at: string;
  finished_at: string | null;
  reason: string | null;
}

export interface AgentRun {
  id: string;
  task_id: string;
  agent_id: string;
  runtime_id: RuntimeId;
  provider: string | null;
  model: string | null;
  session_id: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  finished_at: string | null;
  stop_reason: string | null;
  /** История попыток задачи в порядке старта (attempt #1, #2, …). */
  attempts?: AgentAttempt[];
}

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === RUNTIME_ID_PI;
}

export function isAgentProfile(value: unknown): value is AgentProfile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.role === "string" &&
    typeof v.title === "string" &&
    typeof v.account_id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.prompt === "object" &&
    v.prompt !== null &&
    Array.isArray(v.skills) &&
    Array.isArray(v.tools) &&
    typeof v.modelPolicy === "object" &&
    v.modelPolicy !== null &&
    typeof v.status === "string"
  );
}

export function isModel(value: unknown): value is Model {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.provider === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.available === "boolean"
  );
}

export function isProviderConnection(value: unknown): value is ProviderConnection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.status === "string" &&
    v.managedBy === "pi"
  );
}

export function isAgentRun(value: unknown): value is AgentRun {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.task_id === "string" &&
    typeof v.agent_id === "string" &&
    v.runtime_id === RUNTIME_ID_PI &&
    typeof v.status === "string" &&
    typeof v.started_at === "string"
  );
}
