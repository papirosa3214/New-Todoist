// ═══════════ Fetch wrapper for the TaskFlow API ═══════════
//
// Base URL comes from Vite env (VITE_API_URL). Falls back to the server's
// own dev default (server/src/index.ts: PORT ?? 3001) so the app works
// out of the box against `npm run dev` in server/ with no .env needed.
const DEFAULT_BASE_URL = "http://localhost:3001";

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
    "Content-Type": "application/json",
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
