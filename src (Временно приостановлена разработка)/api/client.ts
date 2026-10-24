import { Capacitor } from "@capacitor/core";

// Base URL comes from Vite env (VITE_API_URL). In native iOS (Capacitor),
// defaults to http://192.168.1.110:3001 so the app can reach the backend.
// In browser dev, falls back to same-origin ("" -> relative /api/... URLs).
const DEFAULT_BASE_URL = Capacitor.isNativePlatform()
  ? "http://192.168.1.110:3001"
  : "";

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

// ═══════ Вход без пароля из домашней сети ═══════
//
// Требование Максима 19.08.2026: дома экран входа показываться не должен.
// Сервер отдаёт сессию владельца на POST /api/auth/lan, но только с приватного
// адреса и только при TASKFLOW_LAN_NO_AUTH=1 (см. server/src/auth.ts). Снаружи
// маршрут отвечает 404 — тогда всё работает по-старому, через /login.
//
// Промис кэшируется: при первой загрузке экрана запросы летят пачкой, и без
// кэша каждый завёл бы свою попытку входа.
let lanLoginAttempt: Promise<string | null> | null = null;

export async function tryLanLogin(): Promise<string | null> {
  if (!lanLoginAttempt) {
    lanLoginAttempt = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/lan`, {
          method: "POST",
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data?.token) {
          setToken(data.token);
          return data.token as string;
        }
      } catch {
        // сеть недоступна — обычный путь через /login
      }
      return null;
    })();
  }
  return lanLoginAttempt;
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
  // Токена нет — сначала пробуем домашний вход, и только если сервер его не
  // даёт (мы снаружи или режим выключен), идём дальше как раньше.
  let token = getToken();
  if (!token && !path.startsWith("/api/auth/")) {
    token = await tryLanLogin();
  }
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

  // Передаём выбранный AI Мозг (local, claude, hermes, antigravity, deepseek) и модель
  if (path.includes("/ai/") || path.includes("suggest-subtasks")) {
    try {
      const state = JSON.parse(localStorage.getItem("taskflow-ui") || "{}");
      const provider = state?.state?.aiProvider || "local";
      // 25.08.2026: coder30b-abl:latest роняет Ollama CUDA-ошибкой на любом
      // реальном промпте (см. server/src/routes/ai.ts) — дефолт сменён.
      const localModel =
        state?.state?.localOllamaModel || "qwen3.6-27b-iq4-16k:latest";
      const antigravityModel =
        state?.state?.antigravityModel || "gemini-3.7-flash-high";
      const claudeModel = state?.state?.claudeModel || "claude-3-7-sonnet";
      const hermesModel = state?.state?.hermesModel || "nous-hermes-3-405b";
      const deepseekModel = state?.state?.deepseekModel || "deepseek-r1";

      headers["x-ai-provider"] = provider;
      headers["x-ollama-model"] = localModel;
      if (provider === "antigravity") headers["x-ai-model"] = antigravityModel;
      else if (provider === "claude") headers["x-ai-model"] = claudeModel;
      else if (provider === "hermes") headers["x-ai-model"] = hermesModel;
      else if (provider === "deepseek") headers["x-ai-model"] = deepseekModel;
    } catch {}
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const body = await parseBody(res);

  if (res.status === 401) {
    // A 401 only means "your session is dead" if we actually sent a
    // token. A 401 from /api/auth/login with no token attached is just
    // "wrong password" — that must surface as a normal error, not blow
    // away a (nonexistent) session and bounce to /login.
    if (token) {
      clearToken();
      // Сессия протухла. Дома молча берём новую и повторяем запрос — экран
      // входа не показываем. Снаружи /api/auth/lan вернёт 404, и тогда как
      // раньше: на /login.
      lanLoginAttempt = null;
      const fresh = !path.startsWith("/api/auth/") ? await tryLanLogin() : null;
      if (fresh) {
        return request<T>(path, options);
      }
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
  put: <T>(path: string, data?: unknown): Promise<T> =>
    request<T>(path, {
      method: "PUT",
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
  // Скачать файл (вложение комментария). Отдельно от request<T>: тот
  // разбирает ответ как JSON, а здесь нужны сами байты. Заголовок с токеном
  // ставится так же — без него сервер отдаёт 401, и именно поэтому картинку
  // нельзя показать простым <img src="/api/attachments/…">, см.
  // components/AttachmentView.tsx.
  getBlob: async (path: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new ApiError(res.status, res.statusText);
    }
    return res.blob();
  },
};
