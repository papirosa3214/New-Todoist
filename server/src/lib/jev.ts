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
import { startObservation, finishObservation, keyIdentity } from "./contextObservability.js";
import db from "../db.js";
import { ProxyAgent } from "undici";

// Existing Xray Claude HTTP inbound; scoped to TypeSafe, never global fetch.
const typesafeProxy = new ProxyAgent("http://127.0.0.1:10812");
import { encryptWebhookSecret, decryptWebhookSecret } from "./secretBox.js";

/** instructions — строка или объект: вопрос в одном поле, данные, на которые
 *  он ссылается (`имя` в обратных кавычках), — в других (docs: API reference). */
export type JevInstructions = string | Record<string, unknown>;

export type JevQuestion =
  | {
      type: "choice";
      instructions: JevInstructions;
      criteria: Record<string, string | null>;
    }
  | { type: "score"; instructions: JevInstructions; criteria: string[] }
  | {
      type: "noul";
      instructions: JevInstructions;
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
  /** Internal correlation; never sent to the provider. */
  observationId?: string | null;
}

/** Сценарии JEV: колонка-галочка, колонка-порог (если есть) и имена полей
 *  наружу. Одна таблица вместо копий кода на каждый сценарий: новый
 *  сценарий — новая строка здесь и колонки в миграции. */
const SCENARIOS = [
  {
    flag: "plan_profile_enabled",
    conf: "plan_profile_min_confidence",
    key: "planProfile",
  },
  {
    flag: "subtask_role_enabled",
    conf: "subtask_role_min_confidence",
    key: "subtaskRole",
  },
  {
    flag: "memory_recall_enabled",
    conf: "memory_recall_min_confidence",
    key: "memoryRecall",
  },
  {
    flag: "memory_write_enabled",
    conf: "memory_write_min_confidence",
    key: "memoryWrite",
  },
  { flag: "skills_enabled", conf: null, key: "skills" },
  { flag: "report_review_enabled", conf: null, key: "reportReview" },
  { flag: "chat_intent_enabled", conf: "chat_intent_min_confidence", key: "chatIntent" },
] as const;

type ScenarioKey = (typeof SCENARIOS)[number]["key"];

interface JevRow {
  base_url: string;
  model: string;
  timeout_ms: number;
  api_key_enc: Buffer | null;
  updated_at: string;
  [column: string]: unknown;
}

/** То, что видит экран настроек: без ключа, только признак его наличия.
 *  По сценарию — `<key>Enabled` и, где есть порог, `<key>MinConfidence`. */
export type JevPublicSettings = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasApiKey: boolean;
  updatedAt: string;
} & { [K in `${ScenarioKey}Enabled`]: boolean } & {
  [K in `${Exclude<ScenarioKey, "skills" | "reportReview">}MinConfidence`]: number;
};

function row(): JevRow {
  return db.prepare("SELECT * FROM jev_settings WHERE id = 1").get() as JevRow;
}

export function getJevSettings(): JevPublicSettings {
  const r = row();
  const out: Record<string, unknown> = {
    baseUrl: r.base_url,
    model: r.model,
    timeoutMs: r.timeout_ms,
    hasApiKey: Boolean(r.api_key_enc),
    updatedAt: r.updated_at,
  };
  for (const sc of SCENARIOS) {
    out[`${sc.key}Enabled`] = Boolean(r[sc.flag]);
    if (sc.conf) out[`${sc.key}MinConfidence`] = r[sc.conf];
  }
  return out as JevPublicSettings;
}

export class JevSettingsError extends Error {}

/** Сохранить настройки. Пустой/отсутствующий apiKey ключ НЕ стирает —
 *  как у Ekko: поле ключа на экране всегда пустое, и сохранение остальных
 *  полей не должно молча отключать подключение. Поля, которых нет во
 *  входе, остаются как были. */
export function saveJevSettings(
  input: Record<string, unknown>,
): JevPublicSettings {
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

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const sc of SCENARIOS) {
    const flag = input[`${sc.key}Enabled`];
    if (flag !== undefined) {
      sets.push(`${sc.flag}=?`);
      values.push(flag === true ? 1 : 0);
    }
    const conf = sc.conf ? input[`${sc.key}MinConfidence`] : undefined;
    if (sc.conf && conf !== undefined) {
      const n = Number(conf);
      if (!Number.isFinite(n) || n < 0 || n > 1)
        throw new JevSettingsError("Порог уверенности — от 0 до 1");
      sets.push(`${sc.conf}=?`);
      values.push(n);
    }
  }

  const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const keyEnc = key ? encryptWebhookSecret(key) : cur.api_key_enc;

  db.prepare(
    `UPDATE jev_settings SET base_url=?, model=?, timeout_ms=?, api_key_enc=?,
       ${sets.map((x) => x + ", ").join("")}updated_at=datetime('now') WHERE id=1`,
  ).run(baseUrl, model, timeoutMs, keyEnc, ...values);
  return getJevSettings();
}

/** Сценарий включён и есть ключ — его порог (или 0, если порога нет);
 *  иначе null: вызывающий идёт прежней дорогой. */
export function jevScenario(
  key: ScenarioKey,
): { minConfidence: number } | null {
  const r = row();
  const sc = SCENARIOS.find((x) => x.key === key)!;
  if (!r[sc.flag] || !r.api_key_enc) return null;
  return { minConfidence: sc.conf ? Number(r[sc.conf]) : 0 };
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
  timeoutMs?: number,
): Promise<any> {
  const controller = new AbortController();
  const budget = timeoutMs ?? r.timeout_ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("JEV deadline exceeded", "TimeoutError"));
    }, budget);
  });
  const request = (async () => {
  const res = await fetch(`${r.base_url}${path}`, {
    method,
    ...(new URL(r.base_url).hostname === "api.typesafe.ai" ? { dispatcher: typesafeProxy } : {}),
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: controller.signal,
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
  })();
  try { return await Promise.race([request, expired]); }
  finally { clearTimeout(timer); }
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Partial answers are allowed; consumers retain their fallback for missing questions. */
function validAnswer(answer: any, question: JevQuestion): boolean {
  if (!answer || answer.type !== question.type) return false;
  if (question.type === "noul") return probability(answer.noul);
  if (!probability(answer.confidence) || !answer.probabilities ||
      typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities) ||
      !Object.keys(answer.probabilities).length || !Object.values(answer.probabilities).every(probability)) return false;
  if (question.type === "choice") return typeof answer.choice === "string" &&
    Object.hasOwn(question.criteria, answer.choice) &&
    Object.keys(answer.probabilities).every(key => Object.hasOwn(question.criteria, key));
  return typeof answer.score === "number" && Number.isFinite(answer.score);
}

/**
 * Два шлюза к одной модели JEV, различаются адресом (владелец 16.10.2026
 * прислал ключ `jev_…` от jevai.org):
 *   - TypeSafe (api.typesafe.ai): POST /v1/systemone → { model, answers, usage };
 *     проверка — GET /v1/models.
 *   - jevai.org (https://www.jevai.org/docs): POST /api/v1/decisions с тем же
 *     { model?, state, questions } → { code, message, data: { answers, … } },
 *     code 0 — успех. Списка моделей нет — проверка одним маленьким вопросом.
 */
function isJevai(r: JevRow): boolean {
  return /(^|\.)jevai\.org$/i.test(new URL(r.base_url).hostname);
}

/** Тело jevai: { code, message, data }. code≠0 — отказ с текстом. */
function unwrapJevai(out: any): any {
  if (!out || typeof out !== "object" || out.code !== 0) {
    throw new Error(
      typeof out?.message === "string"
        ? out.message.slice(0, 200)
        : "Неожиданный ответ jevai.org",
    );
  }
  return out.data;
}

/** Кнопка «Проверить подключение»: живой запрос к выбранному шлюзу. */
export async function testJevConnection(): Promise<
  { ok: true; models: string[]; ms: number } | { ok: false; error: string }
> {
  const r = row();
  const key = apiKey(r);
  if (!key) return { ok: false, error: "Ключ API не задан" };
  const t0 = Date.now();
  const connectionOp=isJevai(r)?startObservation("jev","connectionTest",{keyId:keyIdentity(r.base_url,key)}):null;
  try {
    if (isJevai(r)) {
      const data = unwrapJevai(await call(r,key,"POST","/api/v1/decisions",{model:r.model,state:"Проверка подключения TaskFlow.",questions:{ping:{type:"noul",instructions:"Это проверочный запрос?"}}}));
      finishObservation(connectionOp,{status:data?.answers?.ping?"ok":"error",reason:data?.answers?.ping?undefined:"invalid_response",usage:data?.usage});
      if (!data?.answers?.ping)
        return { ok: false, error: "Неожиданный ответ jevai.org" };
      return { ok: true, models: [r.model], ms: Date.now() - t0 };
    }
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
    finishObservation(connectionOp,{status:timeout?"timeout":"error",reason:timeout?"timeout":"provider_error"});
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
  /** Свой предел ожидания (не больше общего тайм-аута подключения): память
   *  подбирается на каждом ходу роли, и ждать там 10 с нельзя. */
  opts: { timeoutMs?: number; scenario?: string } = {},
): Promise<JevResult | null> {
  const r = row();
  const key = apiKey(r);
  const observationId=startObservation("jev",opts.scenario??"unspecified",{keyId:key?keyIdentity(r.base_url,key):undefined});
  if (!key) { finishObservation(observationId,{status:"skipped",reason:"no_key"});return null; }
  try {
    const body = { model: r.model, state, questions };
    const limit = opts.timeoutMs
      ? Math.min(opts.timeoutMs, r.timeout_ms)
      : undefined;
    const out = isJevai(r)
      ? unwrapJevai(
          await call(r, key, "POST", "/api/v1/decisions", body, limit),
        )
      : await call(r, key, "POST", "/v1/systemone", body, limit);
    if (
      !out ||
      typeof out !== "object" ||
      !out.answers ||
      typeof out.answers !== "object" || Array.isArray(out.answers) ||
      !Object.entries(questions).every(([name, question]) =>
        out.answers[name] === undefined || validAnswer(out.answers[name], question))
    )
      {finishObservation(observationId,{status:"error",reason:"invalid_response",usage:out?.usage});return null;}
    finishObservation(observationId,{status:"ok",inputCount:Object.keys(questions).length,outputCount:Object.keys(out.answers).length,usage:out.usage,details:typeof out.model==="string" && /^[a-zA-Z0-9._-]{1,80}$/.test(out.model)?["model: "+out.model]:[]});
    return {...out,observationId} as JevResult;
  } catch (err: any) {
    const timeout=err?.name==="TimeoutError"||err?.name==="AbortError";
    finishObservation(observationId,{status:timeout?"timeout":"error",reason:timeout?"timeout":"provider_error"});
    console.warn("JEV: оценка не получена",timeout?"timeout":"provider_error");
    return null;
  }
}

export function jevSkipReason(scenario:string):string {const r=row(),entry=SCENARIOS.find(s=>s.key===scenario);return !apiKey(r)?"no_key":entry&&!r[entry.flag]?"disabled":"not_required";}

export function currentJevKeyIdentity():string|null {const r=row(),key=apiKey(r);return key?keyIdentity(r.base_url,key):null;}

/** Только для сценариев: включён ли выбор плана и есть ли чем его делать. */
export function jevPlanProfileConfig(): { minConfidence: number } | null {
  return jevScenario("planProfile");
}

/** Только для сценариев: включён ли подбор ролей для подзадач и есть ли ключ. */
export function jevSubtaskRoleConfig(): { minConfidence: number } | null {
  return jevScenario("subtaskRole");
}
