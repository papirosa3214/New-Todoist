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
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  getWebhookSecretBoxKey,
  warnMissingKeyOnce,
} from "./secretBox.js";

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
  secret_encrypted: Buffer | null;
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

interface WakeQueueRow {
  codex_followup_id: string | null;
  wake_acked_at: string | null;
  wake_acked_kind: string | null;
}

/** Самая свежая строка wake-очереди для подписки (по `id DESC LIMIT 1`).
 *  Колонки webhook_subscriptions под подтверждение ack не заведены — данные
 *  лежат в webhook_wake_queue, поэтому DTO подписки подтягивает их оттуда.
 *  Возвращает null, если для подписки ещё не было wake (новая подписка
 *  без codex_thread_id, либо очередь пуста).
 *
 *  Statement готовится лениво: в момент импорта модуля таблица
 *  webhook_wake_queue может ещё не существовать (in-memory SQLite для
 *  тестов, поэтапные миграции), а migration 128_webhook_durable_secret_and_wake_ack
 *  поднимает её до первого обращения через rowToDto. */
function latestWakeForSubscription(subscriptionId: string): WakeQueueRow | null {
  const row = db
    .prepare(
      `SELECT codex_followup_id, wake_acked_at, wake_acked_kind
         FROM webhook_wake_queue
        WHERE subscription_id = ?
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(subscriptionId) as WakeQueueRow | undefined;
  return row ?? null;
}

function rowToDto(r: SubscriptionRow): WebhookDTO {
  let kinds: string[] = [];
  try {
    const parsed = JSON.parse(r.event_kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    kinds = [];
  }
  // D-5 DTO (rework 2026-10-10): last_wake_ack подтягивается из
  // webhook_wake_queue, а не из webhook_subscriptions — поля
  // `last_wake_followup_id` там нет. Если для подписки ещё нет строк
  // в очереди (новая подписка, либо wake ещё не проходил), DTO
  // возвращает полностью «нейтральный» ack: codex_followup_id/acked_at/
  // kind все null, acked=false. Это согласовано с контрактом V2:
  // queued ≠ acked, ack выставляется только через /_wake_ack или
  // будущий turn_started callback.
  const wake = latestWakeForSubscription(r.id);
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
    last_wake_ack: {
      codex_followup_id: wake?.codex_followup_id ?? null,
      acked: wake?.wake_acked_at != null,
      acked_at: wake?.wake_acked_at ?? null,
      kind: wake?.wake_acked_kind ?? null,
    },
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
  /**
   * Последний подтверждённый wake этой подписки. `acked: false` означает,
   * что wake ещё не подтверждён независимо (queued≠acked, уточнение
   * ведущего 2026-10-10). Конкретный `acked: true` ставится только при
   * реальном turn-started/callback.
   */
  last_wake_ack: {
    codex_followup_id: string | null;
    acked: boolean;
    acked_at: string | null;
    kind: string | null;
  };
  created_at: string;
  updated_at: string;
}

export interface CreateWebhookOutput {
  webhook: WebhookDTO;
  /**
   * Секрет НЕ возвращается ни в одном ответе API — write-only контракт
   * (уточнение ведущего 2026-10-10: «секрет строго write-only во ВСЕХ
   * ответах POST/PATCH/GET/test, включая ротацию»). Владелец держит
   * секрет у себя в keychain; на сервере он шифруется ключом
   * TASKFLOW_WEBHOOK_SECRET_KEY и не покидает процесс.
   */
}

/**
 * Внутренние адреса, куда доставке вебхука ходить нельзя.
 *
 * Зачем (24.10.2026, аудит безопасности): validateUrl проверял только схему,
 * поэтому подписку можно было завести на `http://127.0.0.1:3001/...` или
 * `http://169.254.169.254/` (метаданные облака). Тест-ручка возвращает
 * http_status ответа — то есть работает как oracle для сканирования
 * внутренней сети: «есть ли на порту N HTTP-сервис» и «как он отвечает».
 *
 * Публичные адреса пропускаем. Явно разрешённые внутренние — из
 * TASKFLOW_WEBHOOK_ALLOW_INTERNAL (через запятую): по умолчанию пусто.
 */
function внутреннийАдрес(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  // IPv4: приватные диапазоны, loopback, link-local (169.254), 0.0.0.0
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6: ::1, fe80::/10, fc00::/7
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) {
    return true;
  }
  return false;
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
  // Внутренние адреса — только если владелец разрешил их явно.
  const разрешены = (process.env.TASKFLOW_WEBHOOK_ALLOW_INTERNAL || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (внутреннийАдрес(parsed.hostname) && !разрешены.includes(parsed.hostname.toLowerCase())) {
    throw new ValidationError(
      "url не должен указывать на внутренний адрес (localhost, приватная сеть, link-local)",
    );
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
  let encrypted: Buffer;
  try {
    encrypted = encryptWebhookSecret(input.secret);
  } catch (e) {
    // Fail-closed: без ключа подписку НЕ создаём. Это и был D-1: на
    // restart сервер должен уметь подписать доставку тем же ключом, а
    // без ключа — не должен создавать заведомо неверифицируемую запись.
    warnMissingKeyOnce();
    throw new ValidationError(
      `шифрование секрета недоступно: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  db.prepare(
    `INSERT INTO webhook_subscriptions
     (id, owner_user_id, name, url, secret_hash, secret_preview, secret_encrypted, enabled, event_kinds, project_id, codex_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.owner_user_id,
    input.name,
    input.url,
    hashSecret(input.secret),
    preview(input.secret),
    encrypted,
    input.enabled === false ? 0 : 1,
    JSON.stringify(eventKinds),
    projectId,
    codexThread,
    now,
    now,
  );
  // Заодно прогреваем кеш — на том же ключе сразу сможем подписывать.
  secretByHash.set(hashSecret(input.secret), input.secret);
  const row = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow;
  return { webhook: rowToDto(row) };
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
  const next: {
    name: string;
    url: string;
    enabled: number;
    event_kinds: string;
    project_id: string | null;
    codex_thread_id: string | null;
    secret_hash: string;
    secret_preview: string;
    secret_encrypted: Buffer | null;
  } = {
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
    secret_encrypted: row.secret_encrypted ?? null,
  };
  if (patch.secret !== undefined) {
    validateSecret(patch.secret);
    const newHash = hashSecret(patch.secret);
    let encrypted: Buffer;
    try {
      encrypted = encryptWebhookSecret(patch.secret);
    } catch (e) {
      warnMissingKeyOnce();
      throw new ValidationError(
        `ротация секрета недоступна: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    next.secret_hash = newHash;
    next.secret_preview = preview(patch.secret);
    next.secret_encrypted = encrypted;
    // Прежний кеш по старому hash становится бесполезен: подписка
    // теперь подписывается новым ключом.
    secretByHash.delete(row.secret_hash);
    secretByHash.set(newHash, patch.secret);
  }
  if (patch.url !== undefined) validateUrl(patch.url);
  db.prepare(
    `UPDATE webhook_subscriptions
     SET name = ?, url = ?, enabled = ?, event_kinds = ?, project_id = ?, codex_thread_id = ?,
         secret_hash = ?, secret_preview = ?, secret_encrypted = ?, updated_at = datetime('now')
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
    next.secret_encrypted,
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

// Rotate through bounded pages, revisiting earlier pages for backoff retries.
// This is only a scan cursor; durable delivery/attempt rows remain authoritative.
let webhookScanAfterId = 0;

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
  const eventPage = db
    .prepare(
      `SELECT e.id AS id, e.kind AS kind, e.task_id AS task_id, e.field AS field, e.detail AS detail,
              t.title AS title, t.project_id AS project_id
         FROM orchestrator_events e
         LEFT JOIN tasks t ON t.id = e.task_id
        WHERE e.expired = 0
          AND e.created_at >= datetime('now', '-1 day')
          AND e.id > ?
        ORDER BY e.id ASC
        LIMIT 200`,
    );
  let events = eventPage.all(webhookScanAfterId) as OrchestratorEventRow[];
  if (events.length === 0 && webhookScanAfterId !== 0) {
    webhookScanAfterId = 0;
    events = eventPage.all(0) as OrchestratorEventRow[];
  }

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
  events.forEach((e) => eventIdByRowId.set(e.id, `orch:${e.id}:${e.kind}`));

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
      let eventId = eventIdByRowId.get(ev.id)!;
      // Older servers used a page-relative index in the key. Match those
      // records too, or rollout itself would resend already delivered events.
      const legacyPattern = `orch:${ev.id}:*:${ev.kind}`;
      // Bound compatibility lookups to one event using the existing index.
      const eventPrefix = `orch:${ev.id}:`;
      const eventPrefixEnd = `orch:${ev.id};`;
      // Уже доставлено (dedupe).
      const dedupe = db
        .prepare("SELECT 1 FROM webhook_deliveries WHERE event_id >= ? AND event_id < ? AND subscription_id = ? AND (event_id = ? OR event_id GLOB ?)")
        .get(eventPrefix, eventPrefixEnd, sub.id, eventId, legacyPattern);
      if (dedupe) {
        result.skips.already_delivered++;
        continue;
      }
      // Backoff: если уже есть неуспешные попытки и время следующей не пришло — скип.
      const lastAttempt = db
        .prepare(
          `SELECT event_id, attempt, success, next_retry_at FROM webhook_delivery_attempts
            WHERE event_id >= ? AND event_id < ? AND subscription_id = ? AND (event_id = ? OR event_id GLOB ?)
            ORDER BY attempt DESC LIMIT 1`,
        )
        .get(eventPrefix, eventPrefixEnd, sub.id, eventId, legacyPattern) as
        | { event_id: string; attempt: number; success: number; next_retry_at: string | null }
        | undefined;
      // Retries keep the original receiver-visible id and its attempt budget.
      if (lastAttempt) eventId = lastAttempt.event_id;
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
      let signature: string;
      try {
        signature =
          "sha256=" +
          crypto.createHmac("sha256", await resolveSecret(sub)).update(body).digest("hex");
      } catch (e) {
        // D-1 fail-closed: без ключа конкретная подписка не подписывается,
        // ошибка пишется в last_error, остальные подписки продолжают работу.
        const errMsg = e instanceof Error ? e.message : String(e);
        result.deliveries_failed++;
        db.prepare(
          `INSERT INTO webhook_delivery_attempts
           (event_id, subscription_id, attempt, next_retry_at, status, error, success)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(eventId, sub.id, attemptNo, retryDelayIso(attemptNo, now()), 0, errMsg.slice(0, 400), 0);
        db.prepare(
          `UPDATE webhook_subscriptions
              SET last_error = ?, last_delivery_status = 0, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(errMsg.slice(0, 400), sub.id);
        continue;
      }
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
      // должен иметь шанс проснуться. Условие — просто наличие
      // codex_thread_id, без оглядки на HTTP.
      if (sub.codex_thread_id) {
        const enqueued = enqueueWake(sub.id, sub.codex_thread_id, eventId, ev);
        if (enqueued) result.wakes_enqueued++;
      }
    }
  }
  webhookScanAfterId = events[events.length - 1].id;
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

/**
 * Кеш расшифрованных секретов на текущий процесс. После bootstrap
 * сюда попадает всё, что есть в `webhook_subscriptions.secret_encrypted`;
 * подписка на bootstrap делается в `bootstrapSecrets()`, который зовёт
 * `startWebhookDeliveryLoop()` в `index.ts`.
 */
const secretByHash = new Map<string, string>();

export function rememberSecretForHash(hash: string, secret: string): void {
  secretByHash.set(hash, secret);
}

/** Только для тестов: сброс in-process кеша секретов, чтобы имитировать
 *  cold restart (забытый Map) без перезапуска процесса. */
export function __testOnlyClearSecretCache(): void {
  secretByHash.clear();
}

/**
 * Прогревает кеш секретов из БД. Вызывать один раз при старте сервера
 * (в `index.ts` рядом со `startWebhookDeliveryLoop`). Если ключа нет — мы
 * НЕ падаем: предупреждение в логе, дальнейшие подписи будут fail-closed
 * по подписке (resolveSecret бросит ошибку, конкретная доставка уйдёт
 * в `last_error`, остальные подписки продолжают работать). Это и есть
 * уточнение ведущего 2026-10-10: «отсутствие ключа не должно валить весь
 * TaskFlow при отсутствии подписок; отказ ограничить конкретной
 * операцией, fail closed, без fallback».
 *
 * Возвращает количество подписок, чьи секреты удалось прогреть. Подписки
 * без `secret_encrypted` (старые записи до миграции 128, либо
 * зашифрованные без ключа) пропускаются — resolveSecret для них тоже
 * fail-closed.
 */
export function bootstrapSecrets(): { loaded: number; skipped: number; reason?: string } {
  let loaded = 0;
  let skipped = 0;
  let reason: string | undefined;
  let keyOk = true;
  try {
    getWebhookSecretBoxKey();
  } catch (e) {
    keyOk = false;
    reason = e instanceof Error ? e.message : String(e);
    warnMissingKeyOnce();
  }
  const rows = db
    .prepare(
      `SELECT id, secret_hash, secret_encrypted FROM webhook_subscriptions WHERE secret_encrypted IS NOT NULL`,
    )
    .all() as Array<{ id: string; secret_hash: string; secret_encrypted: Buffer | null }>;
  if (!keyOk) {
    return { loaded: 0, skipped: rows.length, reason };
  }
  for (const r of rows) {
    try {
      const buf = r.secret_encrypted as unknown as Buffer;
      const plain = decryptWebhookSecret(buf);
      secretByHash.set(r.secret_hash, plain);
      loaded++;
    } catch (e) {
      skipped++;
      console.warn(
        `[webhook-subscriptions] секрет подписки ${r.id} не расшифровался: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { loaded, skipped };
}

/**
 * Возвращает секрет для подписи доставки. Fail-closed: если секрет не
 * прогрет (bootstrap не запускался, ключа нет, blob повреждён) — бросает
 * ошибку, которая превращается в конкретный `last_error` для этой
 * подписки. Никакого `fallback-secret:` — это и был D-1.
 */
export class WebhookSecretUnavailableError extends Error {
  status = 503 as const;
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretUnavailableError";
  }
}

export async function resolveSecret(sub: SubscriptionRow): Promise<string> {
  const cached = secretByHash.get(sub.secret_hash);
  if (cached) return cached;
  // Холодный старт единичной подписки: возможно, ключ есть, просто bootstrap
  // не успел/не запускался. Пробуем расшифровать на лету.
  if (sub.secret_encrypted) {
    try {
      const plain = decryptWebhookSecret(sub.secret_encrypted as unknown as Buffer);
      secretByHash.set(sub.secret_hash, plain);
      return plain;
    } catch (e) {
      throw new WebhookSecretUnavailableError(
        `секрет подписки ${sub.id} не расшифровался: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  throw new WebhookSecretUnavailableError(
    `секрет подписки ${sub.id} отсутствует в БД (secret_encrypted IS NULL) — POST с секретом обязателен`,
  );
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
  /** Количество wake, для которых runner вернул конкретный codex_followup_id. */
  with_followup: number;
}

/** Один проход wake-моста. Вживую вызывается на сервере раз в 2 секунды
 *  из startWakeDeliveryLoop. В тестах — вручную. По умолчанию делаем
 *  «настоящий» SSH+codex queue через TF-скрипт; в тестах подменяем
 *  через executor (раннер exec). */
export async function processWakePass(
  runner: WakeCommandRunner = wakeRunner(),
): Promise<WakePassResult> {
  const result: WakePassResult = { processed: 0, succeeded: 0, failed: 0, with_followup: 0 };
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
        const followupId = (out as WakeCommandResult).codex_followup_id ?? null;
        if (followupId) result.with_followup++;
        db.prepare(
          `UPDATE webhook_wake_queue
              SET delivered_at = datetime('now'), attempts = attempts + 1, last_error = NULL,
                  codex_followup_id = COALESCE(?, codex_followup_id)
            WHERE id = ?`,
        ).run(followupId, row.id);
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
  /** UUID follow-up из stdout codex-cli («Queued message <UUID>»). NULL,
   *  если runner не смог распарсить. Используется для различения
   *  «queued» и «acked» — само по себе наличие UUID НЕ равно подтверждению
   *  turn started, как отдельно зафиксировал ведущий 2026-10-10. */
  codex_followup_id?: string | null;
}

/** Реестр известных wake-ack подтверждений. Заполняется через
 *  /api/integrations/webhooks/_wake_ack (явный callback чата Codex) либо
 *  в будущем — turn_started событием от app-server. Пока app-server
 *  недоступен, единственный путь ack — callback из чата. Это и есть
 *  «независимое подтверждение» из уточнения ведущего 2026-10-10. */
interface AckRecord {
  followupId: string;
  ackedAt: number;
  kind: "codex_chat_callback" | "app_server_turn_started" | string;
}
const wakeAcks = new Map<string, AckRecord>();

export function registerWakeAck(
  followupId: string,
  kind: "codex_chat_callback" | "app_server_turn_started" | string,
): { ok: boolean; reason?: string } {
  if (!followupId || typeof followupId !== "string") {
    return { ok: false, reason: "followupId обязателен" };
  }
  wakeAcks.set(followupId, { followupId, ackedAt: Date.now(), kind });
  // Применяем ack к строкам wake_queue, которые ещё не подтверждены.
  db.prepare(
    `UPDATE webhook_wake_queue
        SET wake_acked_at = datetime('now'), wake_acked_kind = ?
      WHERE codex_followup_id = ? AND wake_acked_at IS NULL`,
  ).run(kind, followupId);
  // Подтянем subscription_id и обновим last_wake_ack.kind в подписке.
  const row = db
    .prepare(
      `SELECT subscription_id FROM webhook_wake_queue
        WHERE codex_followup_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(followupId) as { subscription_id: string } | undefined;
  if (row) {
    db.prepare(
      `UPDATE webhook_subscriptions SET updated_at = datetime('now') WHERE id = ?`,
    ).run(row.subscription_id);
  }
  return { ok: true };
}

export function __resetWakeAcksForTest(): void {
  wakeAcks.clear();
}

export function hasWakeAck(followupId: string): boolean {
  return wakeAcks.has(followupId);
}

export type WakeCommandRunner = (threadId: string, message: string) => Promise<WakeCommandResult>;

/** Реальный раннер по умолчанию (SSH+codex queue через tf_wake_dispatch.py).
 *  Экспортируется на случай, если другой модуль захочет звать wake напрямую,
 *  без очереди (например, agentWake из этапа A карточки d3a628eb-…). Для
 *  подмены в тестах служит `setRuntimeDefaultRunner()` — обходит
 *  ESM-ограничение «только геттер» через индирекцию. */
let runtimeDefaultRunner: WakeCommandRunner | null = null;
/** Подмена для тестов: ставь свой раннер на время прогона, снимай в
 *  afterEach. На проде `runtimeDefaultRunner` всегда null, и индирекция
 *  пропускается: реальный SSH-скрипт вызывается напрямую. */
export function setRuntimeDefaultRunner(
  runner: WakeCommandRunner | null,
): void {
  runtimeDefaultRunner = runner;
}
/** Актуальный раннер, которым пользуется wake-инфраструктура
 *  (processWakePass, testSubscriptionDelivery и т.п.). По умолчанию —
 *  `defaultRunner` (SSH+codex). В тестах можно поставить свою
 *  реализацию. */
export function wakeRunner(): WakeCommandRunner {
  return runtimeDefaultRunner ?? defaultRunner;
}

export async function defaultRunner(threadId: string, message: string): Promise<WakeCommandResult> {
  // defaultRunner живёт в server/src/lib/, скрипт — в корне репозитория
  // (`scripts/orchestrator/tf_wake_dispatch.py` рядом с `tf_webhook_proto.py`).
  // Три `..` поднимаются до корня worktree, а не до `server/`.
  const scriptPath = path.join(
    process.env.TASKFLOW_CODEX_WAKE_SCRIPT ||
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
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
          return;
        }
        // Скрипт печатает `FOLLOWUP=<UUID>` в stdout после успешного
        // `codex queue` — используется как маркер «queued, ещё не acked»
        // (D-5: HTTP ≠ queued ≠ acked). Само по себе наличие UUID не
        // равно подтверждению turn started — ack приходит отдельным путём
        // через registerWakeAck().
        const m = /FOLLOWUP=([0-9a-fA-F-]{8,})/.exec(stdout || "");
        const followupId = m ? m[1] : null;
        resolve({ ok: true, error: null, codex_followup_id: followupId });
      },
    );
  });
}

/** Ack-проверка: отдельный режим `tf_wake_dispatch.py --verify-ack`.
 *  Карточка 905db3e3-… (D-5): наличие UUID в .codex-global-state.json
 *  ещё НЕ означает turn started — это лишь подтверждение постановки в
 *  очередь. Поэтому метод существует, но его результат сейчас
 *  документированно `acked: false` до подключения явного callback чата
 *  либо app-server turn_started. См. уточнение ведущего 2026-10-10. */
async function defaultVerifyAck(
  threadId: string,
  followupId: string,
): Promise<{ acked: boolean; reason: string }> {
  const scriptPath = path.join(
    process.env.TASKFLOW_CODEX_WAKE_SCRIPT ||
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "scripts",
        "orchestrator",
        "tf_wake_dispatch.py",
      ),
  );
  if (!fs.existsSync(scriptPath)) {
    return { acked: false, reason: `wake script not found at ${scriptPath}` };
  }
  const { execFile } = await import("node:child_process");
  const env = { ...process.env, TASKFLOW_CODEX_MAC: process.env.TASKFLOW_CODEX_MAC || "" };
  return await new Promise<{ acked: boolean; reason: string }>((resolve) => {
    execFile(
      "python3",
      [scriptPath, "--verify-ack", threadId, followupId],
      { timeout: 15_000, env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ acked: false, reason: stderr?.slice(0, 200) || err.message });
          return;
        }
        resolve({ acked: false, reason: "verify-ack показывает только queued; ack требует явного callback чата" });
      },
    );
  });
}

export function startWakeDeliveryLoop(runner: WakeCommandRunner = wakeRunner()): () => void {
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

/**
 * Nested wake DTO для test-ручки. Форма согласована с `WebhookDTO.wake`
 * (см. rowToDto): кодекс-клиент уже понимает `wake.codex_thread_id`,
 * здесь тот же shape, чтобы iPhone-UI не приходилось различать test и
 * основную подписку. D-3: плоские `wake_queued`/`wake_thread_id`
 * удалены; `acked` — отдельный булев, всегда false (подтверждение turn
 * started приходит отдельным путём — см. registerWakeAck).
 */
export interface TestWakeDTO {
  codex_thread_id: string | null;
  has_thread: boolean;
  queued: boolean;
  queued_message: string | null;
  codex_followup_id: string | null;
  acked: boolean;
  acked_at: string | null;
  error: string | null;
}

export interface TestDeliveryResult {
  delivered: boolean;
  http_status: number;
  wake: TestWakeDTO;
  error: string | null;
}

/**
 * POST /:id/test — синхронная проверка «получил iPhone» + «пробудился Codex».
 * По контракту HTTP и wake — отдельные признаки (HTTP ≠ queued ≠ acked).
 * Делаем 1) POST на URL подписки для немедленной реакции iPhone-UI,
 * 2) синхронный wake через `runner`, 3) возвращаем оба признака + статусы.
 *
 * Никакого `secret` в ответе: подписочный ключ уже шифрован в БД, эхо
 * полного значения в test-ответе нарушало бы write-only контракт
 * (уточнение ведущего 2026-10-10).
 */
export async function testSubscriptionDelivery(
  id: string,
  fetchImpl: typeof fetch = fetch,
  runner: WakeCommandRunner = wakeRunner(),
  codexThreadOverride?: string | null,
): Promise<TestDeliveryResult> {
  const sub = db
    .prepare("SELECT * FROM webhook_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  if (!sub) {
    return {
      delivered: false,
      http_status: 0,
      wake: {
        codex_thread_id: null,
        has_thread: false,
        queued: false,
        queued_message: null,
        codex_followup_id: null,
        acked: false,
        acked_at: null,
        error: "subscription not found",
      },
      error: "not found",
    };
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
  // Подпись тела делается ТЕМ ЖЕ секретом подписки, что и боевая доставка;
  // на test-ручке в headers идёт `"X-Webhook-Signature": "test"` — это
  // сознательно НЕ настоящий HMAC, чтобы случайный сниффер не собрал
  // валидный токен. Сама проверка подписи остаётся за iPhone-UI; здесь
  // мы лишь убеждаемся, что endpoint отвечает.
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
  let followupId: string | null = null;
  if (threadId) {
    try {
      const r = await runner(threadId, "[TaskFlow test] test wake from iOS POST /:id/test");
      wakeOk = r.ok;
      wakeErr = r.error ?? null;
      followupId = r.codex_followup_id ?? null;
    } catch (e) {
      wakeErr = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    delivered: status >= 200 && status < 300,
    http_status: status,
    wake: {
      codex_thread_id: threadId,
      has_thread: threadId !== null,
      queued: wakeOk,
      queued_message: wakeOk ? "[TaskFlow test] test wake from iOS POST /:id/test" : null,
      codex_followup_id: followupId,
      acked: false,
      acked_at: null,
      error: wakeErr,
    },
    error: httpErr ?? wakeErr,
  };
}
