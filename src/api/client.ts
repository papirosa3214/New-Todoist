// ═══════════ Fetch wrapper for the TaskFlow API ═══════════
//
// Base URL comes from Vite env (VITE_API_URL). Falls back to same-origin
// ("" → relative /api/... URLs, proxied to the server by vite dev — see
// vite.config.ts) so the app works from any device on the LAN, not only
// from the machine where "localhost" happens to be the server.
const DEFAULT_BASE_URL = "";

export const API_BASE_URL = (
  (import.meta.env.VITE_API_URL as string | undefined)?.trim() ||
  DEFAULT_BASE_URL
).replace(/\/+$/, "");

const TOKEN_KEY = "taskflow_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    // Only declare a JSON content-type when a body is actually going out.
    // Fastify's JSON body parser 400s ("FST_ERR_CTP_EMPTY_JSON_BODY") on a
    // request that sets this header but sends no body — which every
    // bodyless call does: api.delete() always, and the handful of
    // api.post()/api.patch() calls with no `data` argument (e.g.
    // /api/notifications/read-all, /api/notifications/:id/read).
    ...(options.body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const body = await parseBody(res);

  if (res.status === 401) {
    // A 401 only means "your session is dead" if we actually sent a
    // token. A 401 from /api/auth/login with no token attached is just
    // "wrong password" — that must surface as a normal error, not blow
    // away a (nonexistent) session and bounce to /login.
    if (token) {
      clearToken();
      if (!window.location.pathname.startsWith("/login")) {
        window.location.assign("/login");
      }
    }
    throw new ApiError(401, body?.error || "Unauthorized");
  }

  if (!res.ok) {
    throw new ApiError(res.status, body?.error || res.statusText);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, data?: unknown): Promise<T> =>
    request<T>(path, {
      method: "POST",
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  patch: <T>(path: string, data?: unknown): Promise<T> =>
    request<T>(path, {
      method: "PATCH",
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  delete: <T>(path: string): Promise<T> =>
    request<T>(path, { method: "DELETE" }),
};
