import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// Карточка be9cf712 (Pi = единый runtime, фаза 2). Источник истины —
// Pi: listProviders() идёт через 'pi auth check --json', listModels() —
// через 'pi --list-models'. Подключение провайдеров и редактирование
// routing делаются через POST /providers/:id/auth и PUT /routing/:role
// (owner/service или api-token со scope runtime:auth).

export type ProviderStatus = "connected" | "disconnected" | "expired";
export type AuthType = "oauth" | "api_key" | null;

export interface RuntimeProvider {
  provider: string;
  status: ProviderStatus;
  authType: AuthType;
}

export interface RuntimeModel {
  id: string;
  provider: string;
  runtime_id: string;
  available: boolean;
}

export interface AuthInstruction {
  status: "auth_required";
  provider: string;
  command: string;
  note: string;
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

export function useConnectProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { provider: string; apiKey?: string }) =>
      api.post<RuntimeProvider | AuthInstruction>(
        `/api/runtime/providers/${input.provider}/auth`,
        { apiKey: input.apiKey },
      ),
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
