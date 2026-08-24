import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken, setToken } from "./client";
import type { ApiUser } from "./types";

interface AuthResponse {
  token: string;
  user: ApiUser;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api.get<{ user: ApiUser }>("/api/auth/me").then((r) => r.user),
    enabled: !!getToken(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api.post<AuthResponse>("/api/auth/login", body),
    onSuccess: (data) => {
      setToken(data.token);
      qc.setQueryData(["me"], data.user);
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; email: string; password: string }) =>
      api.post<AuthResponse>("/api/auth/register", body),
    onSuccess: (data) => {
      setToken(data.token);
      qc.setQueryData(["me"], data.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return () => {
    clearToken();
    qc.clear();
    window.location.assign("/login");
  };
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name?: string;
      email?: string;
      password?: string;
      currentPassword?: string;
    }) => api.put<AuthResponse>("/api/auth/profile", body),
    onSuccess: (data) => {
      if (data.token) {
        setToken(data.token);
      }
      qc.setQueryData(["me"], data.user);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

