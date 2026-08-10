import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiUser } from "./types";

// GET /api/agents returns every user in the system (not scoped to the
// caller's team — the server has no team/workspace concept yet).
export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<ApiUser[]>("/api/agents"),
  });
}
