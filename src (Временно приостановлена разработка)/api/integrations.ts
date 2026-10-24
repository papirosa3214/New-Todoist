import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export interface IntegrationStatus {
  google: {
    configured: boolean;
    connected: boolean;
    email: string | null;
    lastSyncedAt: string | null;
    settings: {
      listId?: string;
      autoSync?: boolean;
    };
  };
}

export interface GoogleTaskList {
  id: string;
  title: string;
  updated?: string;
}

export function useIntegrationsStatus() {
  return useQuery<IntegrationStatus>({
    queryKey: ["integrations-status"],
    queryFn: () => api.get<IntegrationStatus>("/api/integrations/status"),
  });
}

export function useGoogleAuthUrl() {
  return useMutation<{ url: string }, Error, { redirectUri?: string } | void>({
    mutationFn: (vars) =>
      api.get<{ url: string }>(
        `/api/integrations/google/auth-url${vars?.redirectUri ? `?redirect_uri=${encodeURIComponent(vars.redirectUri)}` : ""}`,
      ),
  });
}

export function useGoogleCallback() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; email?: string }, Error, { code: string; redirectUri?: string }>({
    mutationFn: (data) => api.post<{ ok: boolean; email?: string }>("/api/integrations/google/callback", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations-status"] });
    },
  });
}

export function useGoogleLists() {
  return useQuery<{ lists: GoogleTaskList[] }>({
    queryKey: ["google-task-lists"],
    queryFn: () => api.get<{ lists: GoogleTaskList[] }>("/api/integrations/google/lists"),
    retry: false,
  });
}

export function useGoogleSync() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; imported: number; updated: number; totalGoogleTasks: number; syncedAt: string },
    Error,
    { listId?: string } | void
  >({
    mutationFn: (vars) =>
      api.post<{ ok: boolean; imported: number; updated: number; totalGoogleTasks: number; syncedAt: string }>(
        "/api/integrations/google/sync",
        vars || {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations-status"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["today-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["upcoming-tasks"] });
    },
  });
}

export function useDisconnectGoogle() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error>({
    mutationFn: () => api.post<{ ok: boolean }>("/api/integrations/google/disconnect"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations-status"] });
      queryClient.invalidateQueries({ queryKey: ["google-task-lists"] });
    },
  });
}

export function useUpdateIntegrationSettings() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { provider: string; settings: any }>({
    mutationFn: (data) => api.patch<{ ok: boolean }>("/api/integrations/settings", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations-status"] });
    },
  });
}

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
}

export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  calendarTitle: string;
  calendarColor: string;
  location?: string;
}

export function useGoogleCalendars(enabled = true) {
  return useQuery<{ calendars: GoogleCalendarInfo[] }>({
    queryKey: ["google-calendars"],
    queryFn: () => api.get<{ calendars: GoogleCalendarInfo[] }>("/api/integrations/google/calendars"),
    enabled,
    retry: false,
  });
}

export function useGoogleCalendarEvents(dateStr: string, calIds?: string[], enabled = true) {
  return useQuery<{ events: GoogleCalendarEvent[] }>({
    queryKey: ["google-calendar-events", dateStr, calIds],
    queryFn: () =>
      api.get<{ events: GoogleCalendarEvent[] }>(
        `/api/integrations/google/calendar-events?date=${dateStr}${calIds && calIds.length > 0 ? `&calendarIds=${encodeURIComponent(calIds.join(","))}` : ""}`,
      ),
    enabled,
    staleTime: 60_000,
  });
}
