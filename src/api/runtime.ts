import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// Карточка be9cf712 (Pi = единый runtime, фаза 2). Источник истины —
// Pi: список провайдеров — ModelRuntime.getProviders(), модели — каталог Pi.
// Подключение api_key пишется в persistent credential store Pi;
// OAuth идёт через AuthSession (POST /providers/:id/auth → authSessionId,
// затем GET /auth/:id, POST /auth/:id/input, DELETE /auth/:id), потому что
// OAuth-флоу требует действий пользователя и синхронный HTTP здесь даёт
// deadlock.

export type ProviderStatus = "connected" | "disconnected" | "expired";
export type AuthType = "oauth" | "api_key" | null;
export type AuthMethod = "oauth" | "api_key";

export interface RuntimeProvider {
  provider: string;
  name?: string;
  status: ProviderStatus;
  authType: AuthType;
  authMethods?: AuthMethod[];
}

export interface RuntimeModel {
  id: string;
  provider: string;
  runtime_id: string;
  available: boolean;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  thinking?: boolean;
  images?: boolean;
}

export interface RoleRoutingView {
  defaults: Record<string, string>;
  fallbacks: Record<string, string[]>;
  models: Record<string, string>;
}

export interface PutRoutingBody {
  primary: string;
  fallbacks: string[];
}

// === AuthSession ===

export type AuthSessionStatus =
  | "starting"
  | "waiting_user"
  | "processing"
  | "connected"
  | "failed"
  | "cancelled";

export interface AuthPromptRequest {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export interface AuthSessionEvent {
  seq: number;
  at: string;
  type:
    | "auth_url"
    | "device_code"
    | "prompt"
    | "progress"
    | "info"
    | "success"
    | "error"
    | "cancelled";
  data: Record<string, unknown>;
}

export interface AuthSessionView {
  id: string;
  provider: string;
  status: AuthSessionStatus;
  createdAt: string;
  expiresAt: string;
  currentPrompt: AuthPromptRequest | null;
  error: string | null;
  events: AuthSessionEvent[];
}

export interface StartAuthSessionResult {
  authSessionId: string;
  provider: string;
  status: AuthSessionStatus;
}

export function useRuntimeProviders() {
  return useQuery({
    queryKey: ["runtime", "providers"],
    queryFn: () => api.get<{ providers: RuntimeProvider[] }>(
      "/api/runtime/providers",
    ),
  });
}

export function useRuntimeModels() {
  return useQuery({
    queryKey: ["runtime", "models"],
    queryFn: () => api.get<{ models: RuntimeModel[] }>(
      "/api/runtime/models",
    ),
  });
}

export function useRuntimeRouting() {
  return useQuery({
    queryKey: ["runtime", "routing"],
    queryFn: () => api.get<{ routing: RoleRoutingView }>(
      "/api/runtime/routing",
    ),
  });
}

/** api_key: сразу пишет credential (persistent) и возвращает статус. */
export function useConnectProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { provider: string; apiKey?: string }) =>
      api.post<RuntimeProvider>(
        `/api/runtime/providers/${input.provider}/auth`,
        { apiKey: input.apiKey },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime"] });
    },
  });
}

/** OAuth: запускает login в фоне, возвращает authSessionId. */
export function useStartAuthSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: string) =>
      api.post<StartAuthSessionResult>(
        `/api/runtime/providers/${provider}/auth`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime"] });
    },
  });
}

/** Опрос auth-сессии. Пока статус не терминальный — перезапрашиваем раз в
 *  секунду (SSE на сервере есть, но EventSource не умеет слать Bearer). */
export function useAuthSession(id: string | null) {
  return useQuery({
    queryKey: ["runtime", "auth", id],
    queryFn: () => api.get<AuthSessionView>(`/api/runtime/auth/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && ["connected", "failed", "cancelled"].includes(status)) {
        return false;
      }
      return 1000;
    },
  });
}

export function useSubmitAuthInput() {
  return useMutation({
    mutationFn: async (input: { id: string; value: string; type?: string }) =>
      api.post<{ ok: boolean }>(`/api/runtime/auth/${input.id}/input`, {
        type: input.type,
        value: input.value,
      }),
  });
}

export function useCancelAuthSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api.delete<void>(`/api/runtime/auth/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime"] });
    },
  });
}

export function usePutRouting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { role: string; body: PutRoutingBody }) =>
      api.put<{ role: string; primary: string; fallbacks: string[] }>(
        `/api/runtime/routing/${input.role}`,
        input.body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime", "routing"] });
    },
  });
}

export const RUNTIME_PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI (Codex OAuth)",
  minimax: "MiniMax",
};

export const RUNTIME_PROVIDER_DESCRIPTION: Record<string, string> = {
  anthropic: "Claude Sonnet, Opus, Haiku",
  "openai-codex": "GPT-5.x через Codex OAuth",
  minimax: "MiniMax-M3 (default)",
};
