// Оценщик JEV (TypeSafe) — отдельная категория, не провайдер моделей ролей.
// Владелец 16.10.2026: «внедрим отдельной категорией, чтобы я мог API ключ
// вставить … первый коннект — по выбору планов».
//
// Протокол снят с исходника @typesafe-ai/sdk 0.6.0 (так его зовёт Ekko
// Studio), SDK не тянем — это один POST:
//   POST {base}/v1/systemone   Authorization: Bearer <key>
//   body  { model, state, questions: { <имя>: { type:"choice"|"score"|"noul",
//           instructions, criteria } } }
//   ответ { model, answers: { <имя>: { type:"choice", choice, confidence,
//           probabilities } | { type:"score", score, confidence, … }
//           | { type:"noul", noul } }, usage }
//   GET  {base}/v1/models  → { models: [...] } — проверка ключа.
//
// ГЛАВНОЕ ПРАВИЛО: улучшение никогда не ломает основу. Выключен, нет ключа,
// тайм-аут, ошибка провайдера, кривой ответ — всё это `null`, и вызывающий
// идёт своей прежней дорогой. Исключения отсюда наружу не летят.
import db from "../db.js";
import { encryptWebhookSecret, decryptWebhookSecret } from "./secretBox.js";

export type JevQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | { type: "score"; instructions: string; criteria: string[] }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string } | null;
    };

export type JevAnswer =
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: "noul"; noul: number };

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

interface JevRow {
  base_url: string;
  model: string;
  timeout_ms: number;
  api_key_enc: Buffer | null;
  plan_profile_enabled: number;
  plan_profile_min_confidence: number;
  updated_at: string;
}

/** То, что видит экран настроек: без ключа, только признак его наличия. */
export interface JevPublicSettings {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
  planProfileEnabled: boolean;
  planProfileMinConfidence: number;
  updatedAt: string;
}

function row(): JevRow {
  return db.prepare("SELECT * FROM jev_settings WHERE id = 1").get() as JevRow;
}

export function getJevSettings(): JevPublicSettings {
  const r = row();
  return {
    baseUrl: r.base_url,
    model: r.model,
    timeoutMs: r.timeout_ms,
    hasApiKey: Boolean(r.api_key_enc),
    planProfileEnabled: Boolean(r.plan_profile_enabled),
    planProfileMinConfidence: r.plan_profile_min_confidence,
    updatedAt: r.updated_at,
  };
}

export class JevSettingsError extends Error {}

/** Сохранить настройки. Пустой/отсутствующий apiKey ключ НЕ стирает —
 *  как у Ekko: поле ключа на экране всегда пустое, и сохранение остальных
 *  полей не должно молча отключать подключение. */
export function saveJevSettings(input: {
  baseUrl?: unknown;
  model?: unknown;
  timeoutMs?: unknown;
  apiKey?: unknown;
  planProfileEnabled?: unknown;
  planProfileMinConfidence?: unknown;
}): JevPublicSettings {
  const cur = row();
  const baseUrl =
    input.baseUrl === undefined
      ? cur.base_url
      : String(input.baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl))
    throw new JevSettingsError(
      "Адрес API должен начинаться с http:// или https://",
    );
  if (/\/v1$/.test(baseUrl))
    throw new JevSettingsError(
      "Адрес API указывается без /v1 — его добавляет сервер",
    );
  const model =
    input.model === undefined ? cur.model : String(input.model).trim();
  if (!model) throw new JevSettingsError("Модель не может быть пустой");
  const timeoutMs =
    input.timeoutMs === undefined ? cur.timeout_ms : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000)
    throw new JevSettingsError("Тайм-аут — целое от 500 до 60000 мс");
  const minConf =
    input.planProfileMinConfidence === undefined
      ? cur.plan_profile_min_confidence
      : Number(input.planProfileMinConfidence);
  if (!Number.isFinite(minConf) || minConf < 0 || minConf > 1)
    throw new JevSettingsError("Порог уверенности — от 0 до 1");
  const enabled =
    input.planProfileEnabled === undefined
      ? cur.plan_profile_enabled
      : input.planProfileEnabled === true
        ? 1
        : 0;

  const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const keyEnc = key ? encryptWebhookSecret(key) : cur.api_key_enc;

  db.prepare(
    `UPDATE jev_settings SET base_url=?, model=?, timeout_ms=?, api_key_enc=?,
       plan_profile_enabled=?, plan_profile_min_confidence=?, updated_at=datetime('now') WHERE id=1`,
  ).run(baseUrl, model, timeoutMs, keyEnc, enabled, minConf);
  return getJevSettings();
}

/** Удалить ключ и сбросить всё к умолчаниям. */
export function resetJevSettings(): JevPublicSettings {
  db.prepare("DELETE FROM jev_settings WHERE id = 1").run();
  db.prepare("INSERT INTO jev_settings (id) VALUES (1)").run();
  return getJevSettings();
}

function apiKey(r: JevRow): string | null {
  if (!r.api_key_enc) return null;
  try {
    return decryptWebhookSecret(r.api_key_enc);
  } catch (err: any) {
    console.warn("JEV: ключ не расшифровался:", err?.message || err);
    return null;
  }
}

async function call(
  r: JevRow,
  key: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${r.base_url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(r.timeout_ms),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* оставляем текстом */
  }
  if (!res.ok) {
    // Тело ошибки провайдера наружу не отдаём целиком — только статус и
    // короткое сообщение: в нём может оказаться эхо запроса.
    const msg =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.message === "string"
          ? parsed.message
          : "";
    throw new Error(`HTTP ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ""}`);
  }
  return parsed;
}

/** Кнопка «Проверить подключение»: живой запрос списка моделей. */
export async function testJevConnection(): Promise<
  { ok: true; models: string[]; ms: number } | { ok: false; error: string }
> {
  const r = row();
  const key = apiKey(r);
  if (!key) return { ok: false, error: "Ключ API не задан" };
  const t0 = Date.now();
  try {
    const out = await call(r, key, "GET", "/v1/models");
    if (!Array.isArray(out?.models))
      return { ok: false, error: "Неожиданный ответ сервера JEV" };
    return {
      ok: true,
      models: out.models.map((m: any) => String(m?.name ?? m)),
      ms: Date.now() - t0,
    };
  } catch (err: any) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      error: timeout
        ? `Нет ответа за ${r.timeout_ms} мс`
        : String(err?.message || err),
    };
  }
}

/**
 * Один запрос к JEV. null — оценки нет (выключено снаружи решает вызывающий,
 * здесь: нет ключа, тайм-аут, ошибка, кривой ответ). Не бросает.
 */
export async function evaluateJev(
  state: string | Record<string, unknown>,
  questions: Record<string, JevQuestion>,
): Promise<JevResult | null> {
  const r = row();
  const key = apiKey(r);
  if (!key) return null;
  try {
    const out = await call(r, key, "POST", "/v1/systemone", {
      model: r.model,
      state,
      questions,
    });
    if (
      !out ||
      typeof out !== "object" ||
      !out.answers ||
      typeof out.answers !== "object"
    )
      return null;
    return out as JevResult;
  } catch (err: any) {
    console.warn("JEV: оценка не получена:", err?.message || err);
    return null;
  }
}

/** Только для сценариев: включён ли выбор плана и есть ли чем его делать. */
export function jevPlanProfileConfig(): { minConfidence: number } | null {
  const r = row();
  if (!r.plan_profile_enabled || !r.api_key_enc) return null;
  return { minConfidence: r.plan_profile_min_confidence };
}
