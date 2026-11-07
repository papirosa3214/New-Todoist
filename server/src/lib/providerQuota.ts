// Остаток лимита у провайдеров, которые его отдают.
//
// Зачем (владелец 12.10.2026). До этого система узнавала о лимите ТОЛЬКО
// постфактум: запрос упал с 429, кто-то разобрал текст ошибки. Дальше ставилась
// метка «сейчас + 5 часов» — окно вслепую, потому что остаток неизвестен. На
// панели провайдера при этом всё это время было видно точно. Здесь остаток
// читается у провайдера напрямую.
//
// Семантика полей проверена ЖИВЫМ запросом, а не по документации:
//   - minimax: `current_interval_remaining_percent: 0` → реальный HTTP 429;
//     поле именно «осталось в процентах». Сброс — `end_time` (мс).
//   - opencode-go: `/v1/usage` отдаёт `percent: 0` при status "ok", и при этом
//     модель отвечает 200. То есть там percent — НЕ остаток, и трактовать его
//     как лимит нельзя: заблокировали бы живой провайдер. Поэтому у него
//     сигналом лимита считается только status != "ok", сброс — `resetsAt`.
// Любой ответ, который не распознан, даёт known:false — тогда работает старая
// проба настоящим запросом.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvHttpProxyAgent } from "undici";

export type ProviderQuota = {
  /** Разобрали ли ответ. false → сигнала нет, звать обычную пробу. */
  known: boolean;
  /** Провайдер в лимите. Имеет смысл только при known. */
  limited: boolean;
  /** Когда провайдер обещает восстановиться (если говорит). */
  resetAt: Date | null;
  /** Человекочитаемая деталь для причины метки. */
  detail?: string;
};

const TIMEOUT_MS = 15_000;
let proxyDispatcher: EnvHttpProxyAgent | undefined;
function proxyFetchDispatcher(): EnvHttpProxyAgent | undefined {
  if (!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)) {
    return undefined;
  }
  if (!proxyDispatcher) {
    try { proxyDispatcher = new EnvHttpProxyAgent(); } catch { return undefined; }
  }
  return proxyDispatcher;
}
const MINIMAX_REMAINS = "https://www.minimax.io/v1/token_plan/remains";
const OPENCODE_GO_USAGE = "https://opencode.ai/zen/go/v1/usage";

type AuthEntry = { type?: string; key?: string; access?: string };

function providerKey(provider: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, AuthEntry>;
    const entry = auth[provider];
    const key = entry?.key ?? (entry?.type === "oauth" ? entry?.access : undefined);
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

async function getJson(url: string, provider: string): Promise<unknown> {
  const key = providerKey(provider);
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const via = proxyFetchDispatcher();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // opencode.ai отдаёт 403 без User-Agent — проверено живьём.
        "User-Agent": "taskflow-quota-check/1.0",
      },
      signal: controller.signal,
      ...(via ? { dispatcher: via } as RequestInit : {}),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function minimaxQuota(): Promise<ProviderQuota> {
  const data = (await getJson(MINIMAX_REMAINS, "minimax")) as any;
  const row = data?.model_remains?.[0];
  if (!row) return { known: false, limited: false, resetAt: null };
  const remaining = Number(row.current_interval_remaining_percent);
  const resetAt = Number.isFinite(Number(row.end_time)) ? new Date(Number(row.end_time)) : null;
  const limited = Number.isFinite(remaining) && remaining <= 0;
  return {
    known: true,
    limited,
    resetAt: resetAt && resetAt.getTime() > Date.now() ? resetAt : null,
    detail: limited
      ? `MiniMax: остаток 5-часового окна ${remaining}%, сброс ${resetAt ? resetAt.toISOString() : "не указан"}`
      : `MiniMax: остаток окна ${remaining}%`,
  };
}

async function opencodeGoQuota(): Promise<ProviderQuota> {
  const data = (await getJson(OPENCODE_GO_USAGE, "opencode-go")) as any;
  const usage = data?.usage;
  if (!usage) return { known: false, limited: false, resetAt: null };
  const windows = [usage.rolling, usage.weekly].filter(Boolean);
  if (!windows.length) return { known: false, limited: false, resetAt: null };
  // percent здесь — НЕ остаток (проверено живым запросом: percent 0 при работающей
  // модели). Лимитом считаем только явный статус.
  const limitedWindow = windows.find((w: any) => w.status && w.status !== "ok");
  const resets = windows
    .map((w: any) => (w.resetsAt ? new Date(w.resetsAt) : null))
    .filter((d: Date | null): d is Date => !!d && d.getTime() > Date.now())
    .sort((a: Date, b: Date) => a.getTime() - b.getTime());
  const resetAt = limitedWindow
    ? resets[0] ?? null
    : resets.length
      ? resets[resets.length - 1]
      : null;
  return {
    known: true,
    limited: !!limitedWindow,
    resetAt,
    detail: limitedWindow
      ? `OpenCode Go: окно ${limitedWindow.status}, сброс ${limitedWindow.resetsAt ?? "не указан"}`
      : "OpenCode Go: окна в порядке",
  };
}

const XAI_ME = "https://api.x.ai/v1/me";

async function xaiQuota(): Promise<ProviderQuota> {
  // Подписка SuperGrok / X Premium через OAuth: отдельного «остатка %»
  // xAI не отдаёт. /v1/me подтверждает живую подписку и блокировку команды.
  const data = (await getJson(XAI_ME, "xai")) as any;
  if (!data || typeof data !== "object") return { known: false, limited: false, resetAt: null };
  const blocked = data.team_blocked === true;
  return {
    known: true,
    limited: blocked,
    resetAt: null,
    detail: blocked
      ? "xAI: команда заблокирована на стороне подписки"
      : "xAI · подписка, остаток окна API не отдаёт",
  };
}

/** Остаток лимита провайдера. known:false — «не знаю», а не «жив». */
export async function readProviderQuota(provider: string): Promise<ProviderQuota> {
  try {
    if (provider === "minimax") return await minimaxQuota();
    if (provider === "opencode" || provider === "opencode-go") return await opencodeGoQuota();
    if (provider === "xai") return await xaiQuota();
    return { known: false, limited: false, resetAt: null };
  } catch {
    return { known: false, limited: false, resetAt: null };
  }
}