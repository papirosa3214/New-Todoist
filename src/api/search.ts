import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { ApiTask, ApiProject, ApiLabel } from "./types";

export interface SearchResults {
  tasks: ApiTask[];
  projects: ApiProject[];
  labels: ApiLabel[];
}

// GET /api/search?q=<строка> — задачи/проекты/метки, scoped to the caller
// (see server/src/routes/search.ts). Caller passes an already-debounced,
// trimmed string; an empty one just disables the query rather than
// round-tripping for the `{tasks:[],projects:[],labels:[]}` the server
// would return anyway.
export function useSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["search", q],
    queryFn: () =>
      api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    // A stale query key never gets reused (no keepPreviousData), so a
    // retry only delays isError — same call as useTask in tasks.ts.
    retry: false,
  });
}
