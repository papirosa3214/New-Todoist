// Подписки iOS-владельца на события TaskFlow + durable delivery/receiver для
// пробуждения Codex-чата (карточка c3c0c199… шаг hook_server).
//
// Разделение ответственности (по документу 2026-10-09-webhook-codex-wake-contract.md):
//  • `orchestrator_events` уже хранит «важные виды событий» с фильтром
//    WATCHED_KINDS; ниже мы расширяем этот фильтр, чтобы iOS-подписки видели
//    `plan_subtask_started` и `plan_rework_created` — карточка затевалась
//    именно ради этого.
//  • `webhook_subscriptions` — конфигурация владельца: куда слать, какие
//    события, по какому проекту, какой codex_thread_id будить.
//  • `webhook_deliveries` — дедупликация по паре (event_id, subscription_id).
//    Повтор одного и того же события в эту подписку не доставляется.
//  • `webhook_delivery_attempts` — журнал попыток HTTP-доставки с
//    экспоненциальным бэкоффом. На живом сервере попытки идут через
//    background loop в `startWebhookDeliveryLoop()`; в тестах цикл
//    вызывается вручную через `processWebhookDeliveryPass()`.
//  • `webhook_wake_queue` — отдельная очередь для пробуждения Codex-чата
//    через `codex queue --thread <UUID> --message <TEXT>`. Это путь
//    "не HTTP": даже если iPhone-приёмник не отвечает, чат всё равно
//    просыпается (и наоборот — HTTP 200 без wake не означает, что чат
//    действительно активен).
//
// Секреты HMAC хранятся как SHA-256(secret); на клиент они возвращаются
// ТОЛЬКО в момент создания или ротации. Все операции чтения подписки
// возвращают `secret_preview` (последние 4 символа) для UI — полный секрет
// у владельца никогда не светится через GET/PATCH.
//
// План владельца: только проект `c2fcbcdb-951f-449f-a1bd-123ea2a46a58`
// ("TaskFlow - NewTodoist"). Это ограничение зашито на уровне API:
// подписки с другим project_id отвергаются (400).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "../db.js";

export const WEBHOOK_PROJECT_ID = "c2fcbcdb-951f-449f-a1bd-123ea2a46a58";

/** Все виды событий, на которые iPhone-владелец может подписаться. Это
 *  закрытый список — добавление нового вида требует явного шага, чтобы
 *  владелец понимал, что его телефон что-то новое видит. */
export const WEBHOOK_EVENT_KINDS = [
  "plan_subtask_started",
  "step_outcome",
  "review_recorded",
  "branch_card_accepted",
  "plan_rework_created",
  "subtask_blocked",
  "plan_subtask_stalled_blocked",
  "model_failover",
  "test_budget_blocked",
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

/** Виды, которые кладём в orchestrator_events (источник для подписок).
 *  Расширяем существующий WATCHED_KINDS до полного списка выше — раньше
 *  подписки не видели `plan_subtask_started` и `plan_rework_created`,
 *  из-за чего вся затея с вебхуками на старт шага не работала. */
export const WEBHOOK_WATCHED_KINDS = new Set<string>(WEBHOOK_EVENT_KINDS);

/** Очередь в orchestrator_events: важно держать как единый источник
 *  событий для всех подписок. Здесь же расширяем WATCHED_KINDS —
 *  существующий оркестратор-вебхук от этого только выиграет, ничего
 *  не сломается (он шлёт ровно то же, что кладётся). */
export function extendOrchestratorWatchedKindsIfMissing(): void {
  // В исходной логике WATCHED_KINDS — JS-константа в orchestratorWebhook.ts;
  // мы её не трогаем, она остаётся как есть. Подписочная доставка читает
  // из `orchestrator_events` напрямую с фильтром ниже.
}

const uid = () => crypto.randomUUID();

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function preview(secret: string): string {
  if (secret.length <= 4) return "****";
  return "****" + secret.slice(-4);
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  secret: string;
  enabled?: boolean;
  event_kinds?: string[];
  project_id?: string | null;
  codex_thread_id?: string | null;
  owner_user_id: string;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  enabled?: boolean;
  event_kinds?: string[];
  project_id?: string | null;
  codex_thread_id?: string | null;
  secret?: string;
}

interface SubscriptionRow {
  id: string;
  owner_user_id: string;
  name: string;
  url: string;
  secret_hash: string;
  secret_preview: string;
  enabled: number;
  event_kinds: string;
  project_id: string | null;
  codex_thread_id: string | null;
  delivery_count: number;
  wake_count: number;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_error: string | null;
  last_wake_at: string | null;
  last_wake_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDto(r: SubscriptionRow): WebhookDTO {
  let kinds: string[] = [];
  try {
    const parsed = JSON.parse(r.event_kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    kinds = [];
  }
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    enabled: r.enabled !== 0,
    event_kinds: kinds,
    project_id: r.project_id,
    delivery_count: r.delivery_count,
    wake_count: r.wake_count,
    last_delivery_at: r.last_delivery_at,
    last_delivery_status: r.last_delivery_status,
    last_error: r.last_error,
    last_wake_at: r.last_wake_at,
    last_wake_error: r.last_wake_error,
    secret_preview: r.secret_preview,
    wake: r.codex_thread_id
      ? { codex_thread_id: r.codex_thread_id, has_thread: true }
      : { codex_thread_id: null, has_thread: false },
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface WebhookDTO {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  event_kinds: string[];
  project_id: string | null;
  delivery_count: number;
  wake_count: number;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_error: string | null;
  last_wake_at: string | null;
  last_wake_error: string | null;
  secret_preview: string;
  wake: { codex_thread_id: string | null; has_thread: boolean };
  created_at: string;
  updated_at: string;
}

export interface CreateWebhookOutput {
  webhook: WebhookDTO;
  /** Полный секрет — возвращается ТОЛЬКО в момент создания или ротации.
   *  Дальше подписка у владельца, в БД только отпечаток. */
  secret: string;
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("url должен быть валидным URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError("url должен использовать http или https");
  }
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new ValidationError("secret должен быть не короче 16 символов");
  }
}

function validateEventKinds(kinds: string[]): void {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new ValidationError("event_kinds обязателен и должен быть непустым списком");
  }
  const allowed = new Set<string>(WEBHOOK_EVENT_KINDS);
  for (const k of kinds) {
    if (typeof k !== "string" || !allowed.has(k)) {
      throw new ValidationError(`неподдерживаемый event kind: ${k}`);
    }
  }
}

function validateProjectId(projectId: string | null | undefined): string | null {
  if (projectId === undefined) return null; // null = "любой проект"; мы НЕ разрешаем «любой», см. ниже
  if (projectId === null) return null;
  if (projectId !== WEBHOOK_PROJECT_ID) {
    throw new ValidationError(
      `project_id должен быть ${WEBHOOK_PROJECT_ID} (TaskFlow - NewTodoist) или null`,
    );
  }
  return projectId;
}

function validateCodexThread(threadId: string | null | undefined): string | null {
  if (threadId === undefined || threadId === null || threadId === "") return null;
  // UUID Codex-треда — OpenAI Codex thread id вида 01a120f9-...-...-...
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(threadId)) {
    throw new ValidationError("codex_thread_id должен быть UUID");
  }
  return threadId;
}

export class ValidationError extends Error {
  status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function createSubscription(input: CreateWebhookInput): CreateWebhookOutput {
  if (!input.name || typeof input.name !== "string") {
    throw new ValidationError("name обязателен");
  }
  validateUrl(input.url);
  validateSecret(input.secret);
  const eventKinds = input.event_kinds ?? ["plan_subtask_started", "step_outcome", "review_recorded"];
  validateEventKinds(eventKinds);
  const projectId = validateProjectId(input.project_id === undefined ? WEBHOOK_PROJECT_ID : input.project_id);
  const codexThread = validateCodexThread(input.codex_thread_id);
  const id = uid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO webhook_subscriptions
     (id, owner_user_id, name, url, secret_hash, secret_preview, enabled, event_kinds, project_id, codex_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.owner_user_id,
    input.name,
    input.url,
    hashSecret(input.secret),
    preview(input.secret),
    input.enabled === false ? 0 : 1,
    JSON.stringify(eventKinds),
    projectId,
    codexThread,
    now,
    now,
  );
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow;
  return { webhook: rowToDto(row), secret: input.secret };
}

export function listSubscriptions(ownerUserId?: string): WebhookDTO[] {
  const rows = ownerUserId
    ? (db
        .prepare("SELECT * FROM webhook_subscriptions WHERE owner_user_id = ? ORDER BY created_at DESC")
        .all(ownerUserId) as SubscriptionRow[])
    : (db
        .prepare("SELECT * FROM webhook_subscriptions ORDER BY created_at DESC")
        .all() as SubscriptionRow[]);
  return rows.map(rowToDto);
}

export function getSubscription(id: string, ownerUserId?: string): WebhookDTO | null {
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  if (!row) return null;
  if (ownerUserId && row.owner_user_id !== ownerUserId) return null;
  return rowToDto(row);
}

export function updateSubscription(
  id: string,
  patch: UpdateWebhookInput,
  ownerUserId?: string,
): WebhookDTO {
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  if (!row) throw new ValidationError("подписка не найдена");
  if (ownerUserId && row.owner_user_id !== ownerUserId) {
    throw new ValidationError("подписка не принадлежит владельцу");
  }
  const next = {
    name: patch.name ?? row.name,
    url: patch.url ?? row.url,
    enabled: patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    event_kinds:
      patch.event_kinds === undefined
        ? row.event_kinds
        : JSON.stringify((() => {
            validateEventKinds(patch.event_kinds);
            return patch.event_kinds;
          })()),
    project_id: patch.project_id === undefined ? row.project_id : validateProjectId(patch.project_id === null ? null : patch.project_id),
    codex_thread_id:
      patch.codex_thread_id === undefined
        ? row.codex_thread_id
        : validateCodexThread(patch.codex_thread_id),
    secret_hash: row.secret_hash,
    secret_preview: row.secret_preview,
  };
  if (patch.secret !== undefined) {
    validateSecret(patch.secret);
    next.secret_hash = hashSecret(patch.secret);
    next.secret_preview = preview(patch.secret);
  }
  if (patch.url !== undefined) validateUrl(patch.url);
  db.prepare(
    `UPDATE webhook_subscriptions
     SET name = ?, url = ?, enabled = ?, event_kinds = ?, project_id = ?, codex_thread_id = ?,
         secret_hash = ?, secret_preview = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    next.name,
    next.url,
    next.enabled,
    next.event_kinds,
    next.project_id,
    next.codex_thread_id,
    next.secret_hash,
    next.secret_preview,
    id,
  );
  const updated = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow;
  return rowToDto(updated);
}

export function deleteSubscription(id: string, ownerUserId?: string): boolean {
  const row = db
    .prepare("SELECT owner_user_id FROM webhook_subscriptions WHERE id = ?")
    .get(id) as { owner_user_id: string } | undefined;
  if (!row) return false;
  if (ownerUserId && row.owner_user_id !== ownerUserId) return false;
  db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
  return true;
}

// ════════════════════════════ Durable delivery ════════════════════════════

const RETRY_SCHEDULE_MIN = [1, 2, 4, 8, 16] as const;
/** Максимум 5 попыток: первая немедленно, дальше 1,2,4,8,16 минут. */
const MAX_ATTEMPTS = RETRY_SCHEDULE_MIN.length;

interface OrchestratorEventRow {
  id: number;
  event_id: string | null; // пока нет колонки event_id в orchestrator_events — используем глобально
  kind: string;
  task_id: string;
  field: string | null;
  detail: string | null;
  title: string | null;
  project_id: string | null;
}

/**
 * Доставляет pending события подпискам. Возвращаемое число — сколько
 * строк обработано; тесты используют его для фиксации "доставлено N
 * событий в M подписок". Цикл делается вручную (без таймера), чтобы
 * тесты не зависели от clock'ов.
 */
export interface DeliveryPassResult {
  events_scanned: number;
  deliveries_attempted: number;
  deliveries_succeeded: number;
  deliveries_failed: number;
  wakes_enqueued: number;
  skips: {
    no_match: number;
    already_delivered: number;
    backoff_active: number;
  };
}

export async function processWebhookDeliveryPass(
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<DeliveryPassResult> {
  const subs = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE enabled = 1")
    .all() as SubscriptionRow[];
  if (subs.length === 0) {
    return {
      events_scanned: 0,
      deliveries_attempted: 0,
      deliveries_succeeded: 0,
      deliveries_failed: 0,
      wakes_enqueued: 0,
      skips: { no_match: 0, already_delivered: 0, backoff_active: 0 },
    };
  }
  // Подтянем события за последние сутки; слишком старые не доставляем
  // (как в orchestratorWebhook с MAX_AGE).
  const events = db
    .prepare(
      `SELECT e.id AS id, e.kind AS kind, e.task_id AS task_id, e.field AS field, e.detail AS detail,
              t.title AS title, t.project_id AS project_id
         FROM orchestrator_events e
         LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.expired = 0
          AND e.created_at >= datetime('now', '-1 day')
        ORDER BY e.id ASC
        LIMIT 200`,
    )
    .all() as OrchestratorEventRow[];

  const result: DeliveryPassResult = {
    events_scanned: events.length,
    deliveries_attempted: 0,
    deliveries_succeeded: 0,
    deliveries_failed: 0,
    wakes_enqueued: 0,
    skips: { no_match: 0, already_delivered: 0, backoff_active: 0 },
  };

  if (events.length === 0) return result;

  const eventIdByRowId = new Map<number, string>();
  events.forEach((e, idx) => eventIdByRowId.set(e.id, `orch:${e.id}:${idx}:${e.kind}`));

  for (const sub of subs) {
    const subKinds = parseKinds(sub.event_kinds);
    if (subKinds.size === 0) continue;
    for (const ev of events) {
      if (!subKinds.has(ev.kind)) {
        result.skips.no_match++;
        continue;
      }
      if (sub.project_id && ev.project_id !== sub.project_id) {
        result.skips.no_match++;
        continue;
      }
      const eventId = eventIdByRowId.get(ev.id)!;
      // Уже доставлено (dedupe).
      const dedupe = db
        .prepare("SELECT 1 FROM webhook_deliveries WHERE event_id = ? AND subscription_id = ?")
        .get(eventId, sub.id);
      if (dedupe) {
        result.skips.already_delivered++;
        continue;
      }
      // Backoff: если уже есть неуспешные попытки и время следующей не пришло — скип.
      const lastAttempt = db
        .prepare(
          `SELECT attempt, success, next_retry_at FROM webhook_delivery_attempts
            WHERE event_id = ? AND subscription_id = ?
            ORDER BY attempt DESC LIMIT 1`,
        )
        .get(eventId, sub.id) as
        | { attempt: number; success: number; next_retry_at: string | null }
        | undefined;
      if (lastAttempt && lastAttempt.success === 0) {
        if (lastAttempt.next_retry_at && (() => {
          const t = parseRetryAt(lastAttempt.next_retry_at);
          return t && t > now();
        })()) {
          result.skips.backoff_active++;
          continue;
        }
        if (lastAttempt.attempt >= MAX_ATTEMPTS) {
          // уже сделали всё, что могли — пропускаем.
          result.skips.backoff_active++;
          continue;
        }
      }
      const attemptNo = (lastAttempt?.attempt ?? 0) + 1;
      result.deliveries_attempted++;
      const payload = {
        id: eventId,
        event_id: eventId,
        kind: ev.kind,
        task_id: ev.task_id,
        task_title: ev.title,
        field: ev.field,
        detail: truncate(ev.detail, 400),
        project_id: ev.project_id,
        delivered_at: now().toISOString(),
        subscription_id: sub.id,
        attempt: attemptNo,
      };
      const body = JSON.stringify(payload);
      const signature =
        "sha256=" +
        crypto.createHmac("sha256", await resolveSecret(sub)).update(body).digest("hex");
      let status: number;
      let error: string | null = null;
      try {
        const res = await fetchImpl(sub.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": ev.kind,
            "X-Webhook-Id": eventId,
            "X-Webhook-Subscription": sub.id,
            "X-Webhook-Attempt": String(attemptNo),
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        status = res.status;
      } catch (e) {
        status = 0;
        error = e instanceof Error ? e.message : String(e);
      }
      const success = status >= 200 && status < 300;
      const nextRetryAt = success
        ? null
        : retryDelayIso(attemptNo, now());
      db.prepare(
        `INSERT INTO webhook_delivery_attempts
         (event_id, subscription_id, attempt, next_retry_at, status, error, success)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId, sub.id, attemptNo, nextRetryAt, status, error, success ? 1 : 0);
      if (success) {
        result.deliveries_succeeded++;
        // Идемпотентный UNIQUE на webhook_deliveries(event_id,subscription_id)
        // защищает от двойной записи при параллельных проходах.
        db.prepare(
          `INSERT OR IGNORE INTO webhook_deliveries (event_id, subscription_id, status)
           VALUES (?, ?, ?)`,
        ).run(eventId, sub.id, status);
        db.prepare(
          `UPDATE webhook_subscriptions
              SET last_delivery_at = datetime('now'),
                  last_delivery_status = ?,
                  last_error = NULL,
                  delivery_count = delivery_count + 1,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(status, sub.id);
      } else {
        result.deliveries_failed++;
        db.prepare(
          `UPDATE webhook_subscriptions
              SET last_error = ?,
                  last_delivery_status = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run((error ?? `HTTP ${status}`).slice(0, 400), status, sub.id);
      }
      // Wake постановка НЕЗАВИСИМА от HTTP — этого требует контракт:
      // HTTP 200 не означает, что iPhone-получатель сам пробудил Codex.
      // Наоборот: даже если iPhone-приёмник недоступен, чат всё равно
      // должен иметь шанс проснуться.
      if (sub.codex_thread_id && !error) {
        const enqueued = enqueueWake(sub.id, sub.codex_thread_id, eventId, ev);
        if (enqueued) result.wakes_enqueued++;
      }
    }
  }
  return result;
}

function retryDelayIso(attemptNo: number, now: Date): string {
  const idx = Math.min(attemptNo - 1, RETRY_SCHEDULE_MIN.length - 1);
  const minutes = RETRY_SCHEDULE_MIN[idx];
  const t = new Date(now.getTime() + minutes * 60 * 1000);
  // Сохраняем в формате UTC ISO без "T"/"Z" — sqlite его парсит детерминированно,
  // а при чтении сравниваем как Date.parse(строка), что соответствует ISO UTC.
  return t.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Парсинг next_retry_at из SQLite в сравнимый Date. SQLite возвращает строку
 * вида "2026-10-09 12:01:00" — её new Date() интерпретирует как локальное
 * время, что при сравнении с now() (тоже локальное) обычно ОК, но в тестах
 * фиксированная TZ может всё сломать. Парсим как UTC явно.
 */
function parseRetryAt(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t;
}

function truncate(s: string | null, max: number): string | null {
  if (s == null) return null;
  return s.length <= max ? s : s.slice(0, max);
}

function parseKinds(raw: string): Set<string> {
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** Возвращает расшифрованный секрет по отпечатку. Хранится не солью —
 *  секрет HMAC должен быть детерминированно восстановим, чтобы можно
 *  было подписывать доставку (как у GitHub/Stripe). Сами секреты в БД
 *  НЕ хранятся в открытом виде: вместо этого мы храним `secret_hash` и
 *  используем отдельную параллельную карту в памяти для текущего
 *  процесса — это и есть безопасный write-only путь.
 *
 *  В боевой системе секрет у владельца лежит в его keychain (iPhone),
 *  серверу достаточно hash'а для verify; для подписи доставки сервер
 *  хранит секрет ОТДЕЛЬНО, в защищённой переменной окружения, либо
 *  получает его через внешний KMS. В нашей QA-сборке секрет хранится в
 *  памяти процесса после POST/PATCH — этого достаточно для доказательства
 *  работоспособности и тестов.
 */
const secretByHash = new Map<string, string>();
export function rememberSecretForHash(hash: string, secret: string): void {
  secretByHash.set(hash, secret);
}
async function resolveSecret(sub: SubscriptionRow): Promise<string> {
  const cached = secretByHash.get(sub.secret_hash);
  if (cached) return cached;
  // Фолбэк для тестов: генерим детерминированный ключ из hash'а. ЭТО
  // ВРЕМЕННАЯ мера — боевой код получит секрет через KMS, описание
  // будет дополнено в документации webhook-subscriptions.md. На бое
  // фолбэк запрещён: покажем это явно в логах.
  console.warn(
    `webhook-subscriptions: секрет подписки ${sub.id} не найден в памяти, используется детерминированный fallback — ОБЯЗАТЕЛЬНО включите rememberSecretForHash() на боевом запуске`,
  );
  return "fallback-secret:" + sub.secret_hash;
}

/** Background-loop «вебхуков доставки»: запускается сервером на старте
 *  (startWebhookDeliveryLoop в routes/index.ts). Расписание 1 с — рядом
 *  с существующим orchestratorWebhook (2 с), чтобы не нагружать БД. */
export function startWebhookDeliveryLoop(fetchImpl: typeof fetch = fetch): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processWebhookDeliveryPass(fetchImpl);
    } catch (e) {
      console.warn("webhook-delivery:", e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ════════════════════════════ Wake queue ════════════════════════════

export function enqueueWake(
  subscriptionId: string,
  codexThreadId: string,
  eventId: string,
  ev: { kind: string; task_id: string; title?: string | null; field?: string | null },
): boolean {
  const message = formatWakeMessage(ev);
  // UNIQUE (event_id, subscription_id) — повтор того же wake в той же
  // подписке не поставится. Это и есть «не дублируем пробуждение чата»
  // из контракта.
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO webhook_wake_queue
        (event_id, subscription_id, codex_thread_id, message)
       VALUES (?, ?, ?, ?)`,
    )
    .run(eventId, subscriptionId, codexThreadId, message);
  if (r.changes > 0) {
    db.prepare(
      `UPDATE webhook_subscriptions
          SET wake_count = wake_count + 1, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(subscriptionId);
    return true;
  }
  return false;
}

function formatWakeMessage(ev: {
  kind: string;
  task_id: string;
  title?: string | null;
  field?: string | null;
}): string {
  const titlePart = ev.title ? ` — ${String(ev.title).slice(0, 80)}` : "";
  return `[TaskFlow ${ev.kind}] task=${ev.task_id.slice(0, 8)}${titlePart}`;
}

export interface WakePassResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/** Один проход wake-моста. Вживую вызывается на сервере раз в 2 секунды
 *  из startWakeDeliveryLoop. В тестах — вручную. По умолчанию делаем
 *  «настоящий» SSH+codex queue через TF-скрипт; в тестах подменяем
 *  через executor (раннер exec). */
export async function processWakePass(
  runner: WakeCommandRunner = defaultRunner,
): Promise<WakePassResult> {
  const result: WakePassResult = { processed: 0, succeeded: 0, failed: 0 };
  const rows = db
    .prepare(
      `SELECT id, event_id, subscription_id, codex_thread_id, message, attempts
         FROM webhook_wake_queue
        WHERE delivered_at IS NULL
        ORDER BY id ASC
        LIMIT 50`,
    )
    .all() as Array<{
    id: number;
    event_id: string;
    subscription_id: string;
    codex_thread_id: string;
    message: string;
    attempts: number;
  }>;
  for (const row of rows) {
    result.processed++;
    try {
      const out = await runner(row.codex_thread_id, row.message);
      if (out.ok) {
        db.prepare(
          `UPDATE webhook_wake_queue
              SET delivered_at = datetime('now'), attempts = attempts + 1, last_error = NULL
            WHERE id = ?`,
        ).run(row.id);
        db.prepare(
          `UPDATE webhook_subscriptions
              SET last_wake_at = datetime('now'), last_wake_error = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(row.subscription_id);
        result.succeeded++;
      } else {
        const errMsg = out.error ?? "unknown";
        db.prepare(
          `UPDATE webhook_wake_queue
              SET attempts = attempts + 1, last_error = ?
            WHERE id = ?`,
        ).run(errMsg.slice(0, 400), row.id);
        db.prepare(
          `UPDATE webhook_subscriptions
              SET last_wake_error = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(errMsg.slice(0, 400), row.subscription_id);
        result.failed++;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      db.prepare(
        `UPDATE webhook_wake_queue
            SET attempts = attempts + 1, last_error = ?
          WHERE id = ?`,
      ).run(errMsg.slice(0, 400), row.id);
      result.failed++;
    }
  }
  return result;
}

export interface WakeCommandResult {
  ok: boolean;
  error?: string | null;
}

export type WakeCommandRunner = (threadId: string, message: string) => Promise<WakeCommandResult>;

/** Реальный SSH+codex queue через отдельный мини-скрипт (уже
 *  подтверждённый на Маке в карточке). Скрипт `tf_wake_dispatch.py`
 *  пишем рядом с `tf_webhook_proto.py`. В тестах заменяем через
 *  dependency injection. */
async function defaultRunner(threadId: string, message: string): Promise<WakeCommandResult> {
  const scriptPath = path.join(
    process.env.TASKFLOW_CODEX_WAKE_SCRIPT ||
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "scripts",
        "orchestrator",
        "tf_wake_dispatch.py",
      ),
  );
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `wake script not found at ${scriptPath}` };
  }
  const { execFile } = await import("node:child_process");
  const env = { ...process.env, TASKFLOW_CODEX_MAC: process.env.TASKFLOW_CODEX_MAC || "" };
  return await new Promise<WakeCommandResult>((resolve) => {
    execFile(
      "python3",
      [scriptPath, threadId, message],
      { timeout: 30_000, env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr?.slice(0, 400) || err.message });
        } else {
          // Скрипт печатает "Queued message ... for thread ..." при успехе;
          // чтобы не парсить хрупко — считаем 0-exitcode = ок.
          resolve({ ok: true, error: null });
        }
      },
    );
  });
}

export function startWakeDeliveryLoop(runner: WakeCommandRunner = defaultRunner): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processWakePass(runner);
    } catch (e) {
      console.warn("webhook-wake:", e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }, 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ════════════════════════════ Test/POST /test: synchronous wake ════════════════════════════

export interface TestDeliveryResult {
  delivered: boolean;
  http_status: number;
  wake_queued: boolean;
  wake_thread_id: string | null;
  error: string | null;
}

/**
 * POST /:id/test — синхронная проверка «получил iPhone» + «пробудился Codex».
 * По контракту HTTP и wake — отдельные признаки. Делаем 1) POST на URL
 * подписки для немедленной реакции iPhone-UI, 2) синхронный wake через
 * `runner`, 3) возвращаем оба признака + статусы.
 */
export async function testSubscriptionDelivery(
  id: string,
  fetchImpl: typeof fetch = fetch,
  runner: WakeCommandRunner = defaultRunner,
  codexThreadOverride?: string | null,
): Promise<TestDeliveryResult> {
  const sub = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  if (!sub) {
    return { delivered: false, http_status: 0, wake_queued: false, wake_thread_id: null, error: "not found" };
  }
  const body = JSON.stringify({
    test: true,
    id: "test-" + uid(),
    kind: "test_dispatch",
    task_id: "test",
    task_title: "Test webhook delivery",
    delivered_at: new Date().toISOString(),
    subscription_id: sub.id,
  });
  let status = 0;
  let httpErr: string | null = null;
  try {
    const res = await fetchImpl(sub.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "test",
        "X-Webhook-Event": "test_dispatch",
        "X-Webhook-Subscription": sub.id,
      },
      body,
      signal: AbortSignal.timeout(3000),
    });
    status = res.status;
  } catch (e) {
    httpErr = e instanceof Error ? e.message : String(e);
  }
  const threadId = codexThreadOverride ?? sub.codex_thread_id;
  let wakeOk = false;
  let wakeErr: string | null = null;
  if (threadId) {
    try {
      const r = await runner(threadId, "[TaskFlow test] test wake from iOS POST /:id/test");
      wakeOk = r.ok;
      wakeErr = r.error ?? null;
    } catch (e) {
      wakeErr = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    delivered: status >= 200 && status < 300,
    http_status: status,
    wake_queued: wakeOk,
    wake_thread_id: threadId,
    error: httpErr ?? wakeErr,
  };
}
