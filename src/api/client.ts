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
    // Only declare a JSON content-type when a body is actually going out
    // AND is actually JSON (a string — every api.post/patch call below
    // passes JSON.stringify(...) as the body). A Blob body (api.postBlob,
    // used for the mic-recording upload — see api/audio.ts) must NOT get
    // this header: it would lie about the payload's real type and, unlike
    // a plain string body, fetch() would still send it verbatim instead of
    // deriving the header from the Blob's own `type`. Bodyless calls
    // (api.delete() always, api.post()/api.patch() with no `data`) must
    // also skip it — Fastify's JSON body parser 400s
    // ("FST_ERR_CTP_EMPTY_JSON_BODY") on a Content-Type: application/json
    // request that carries no body at all.
    ...(typeof options.body === "string"
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
  // Raw binary upload (mic recording → ASR, see api/audio.ts). Explicit
  // Content-Type from the Blob's own `type` (set by MediaRecorder) rather
  // than leaving it to fetch's Blob-body inference — the server's
  // addContentTypeParser(/^audio\//) match needs to see it as a real
  // header either way, explicit is one less "does the browser actually do
  // this" assumption to trust.
  postBlob: <T>(path: string, blob: Blob): Promise<T> =>
    request<T>(path, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": blob.type || "application/octet-stream" },
    }),
};
