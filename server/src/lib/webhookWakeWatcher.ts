// Сторож wake-канала вебхуков: проверяет, что цепочка «событие →
// durable delivery → подписка → wake в Codex-чат» живая. Если нет —
// задача в «Серверные уведомления», не чаще одной в сутки.
//
// Карточка 905db3e3-… (webhook V2): правила ведущего 2026-10-10
//   • НЕ будить живой чат каждые 30 минут и НЕ хардкодить UUID треда;
//     сторож работает в изоляции (служебная подписка и синтетический
//     event, доставка на URL 127.0.0.1, без обращения к Codex'у).
//   • Реальный wake в новый чат 01a123bf-… — отдельное согласование
//     по контрольному event'у (владелец отдельно решает, когда).
//   • Дедуп тревог (не чаще одной задачи в сутки) — как у
//     noteAccessWatcher/kbTriageWatcher.
//
// Сценарий пробы:
//   1. Создать временную подписку с произвольным codex_thread_id
//      (НЕ из продового списка) и URL `http://127.0.0.1:0/...`.
//   2. Записать синтетическое событие `plan_subtask_started` через
//      agentState.logEvent, прогнать `processWebhookDeliveryPass` и
//      `processWakePass` под фейковым runner'ом.
//   3. Проверить, что в `webhook_wake_queue` появилась строка и
//      follow-up UUID распарсился из stdout (queued ≠ acked).
//   4. Снять временную подписку (каскад уберёт delivery/wake).
//
// Эта проверка — настоящая: проверяется не «таблица существует», а
// ход всей цепочки. Так и ломается по-настоящему — например, миграция
// 128 не накатилась и `secret_encrypted` остался NULL, тогда
// `resolveSecret` бросит `WebhookSecretUnavailableError`, и доставка
// не подпишется. Сторож это увидит и поднимет тревогу.

import crypto from "node:crypto";
import db from "../db.js";
import { serverNotificationsProjectId } from "./serverNotificationsProject.js";
import {
  WEBHOOK_PROJECT_ID,
  createSubscription,
  deleteSubscription,
  processWakePass,
  processWebhookDeliveryPass,
  type WakeCommandRunner,
} from "./webhookSubscriptions.js";

const OWNER_ID = "u1";
const PRIORITY = 2;
const INTERVAL_MS = 30 * 60 * 1000; // 30 минут, как требует контракт
const PROBE_PREFIX = "probe-webhook-wake-";

let pollHandle: NodeJS.Timeout | null = null;
let lastRaisedAt = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

const PROBE_THREAD_UUID = "00000000-0000-4000-8000-000000000001";

interface CheckResult {
  ok: boolean;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * Одна проверка. Без сетевых вызовов: ставим фейковый runner,
 * прогоняем один pass, смотрим, что в wake_queue появилась строка.
 * Использует серверные часы (`Date.now`) — для тестов это ОК.
 */
export async function checkWebhookWakeInstrument(opts?: {
  runner?: WakeCommandRunner;
}): Promise<CheckResult> {
  const owner = db
    .prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1")
    .get() as { id: string } | undefined;
  const ownerId = owner?.id ?? OWNER_ID;
  let subId = "";
  let taskId = "";
  let probeEventId = 0;
  const tmpSubId = `${PROBE_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const fakeRunner: WakeCommandRunner = opts?.runner ?? (async () => ({
    ok: true,
    codex_followup_id: PROBE_THREAD_UUID,
  }));

  try {
    const out = createSubscription({
      owner_user_id: ownerId,
      name: tmpSubId,
      url: "http://127.0.0.1:0/synthetic-marker",
      secret: `probe-secret-${crypto.randomBytes(12).toString("hex")}-1234`,
      enabled: true,
      event_kinds: ["plan_subtask_started"],
      project_id: WEBHOOK_PROJECT_ID,
      codex_thread_id: PROBE_THREAD_UUID,
    });
    subId = out.webhook.id;

    // Синтетическое событие: фиксированный task_id, чтобы dedupe
    // по (event_id, sub) не помешал повторным прогонам. Очищаем
    // старые строки по этой паре.
    taskId = `probe-${tmpSubId}`;
    // tasks.creator_id — FK на users(id). В свежей БД u1 (owner) уже есть
    // (миграция 039_seed_owner); в сухой тестовой — заводим.
    try {
      db.prepare(
        "INSERT OR IGNORE INTO users (id, name, email, password_hash, role, type) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(ownerId, "wake-watcher-owner", `ww-${ownerId}@test`, "x", "owner", "human");
    } catch (e) {
      console.error("[webhook-wake-watch] users insert failed:", e);
    }
    db.prepare(
      "INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)",
    ).run(WEBHOOK_PROJECT_ID, "TaskFlow - NewTodoist");
    db.prepare(
      "INSERT OR IGNORE INTO tasks (id, title, project_id, creator_id) VALUES (?, ?, ?, ?)",
    ).run(taskId, "wake watcher probe", WEBHOOK_PROJECT_ID, ownerId);

    const evRow = db
      .prepare(
        `INSERT INTO orchestrator_events (kind, task_id, field, detail)
         VALUES ('plan_subtask_started', ?, ?, ?)`,
      )
      .run(taskId, "webhook-wake-watcher-probe", "synthetic event from webhookWakeWatcher");
    probeEventId = (evRow as any)?.lastInsertRowid as number;

    // Чтобы не зависеть от реального fetch — URL 127.0.0.1:0 всегда
    // даст ошибку соединения, и это нормально: проверяем именно wake.
    const fetchImpl: typeof fetch = async () => {
      throw new Error("probe: HTTP не доставляется (127.0.0.1:0 — намеренно)");
    };
    await processWebhookDeliveryPass(fetchImpl);

    const wake = await processWakePass(fakeRunner);
    if (wake.processed === 0) {
      return {
        ok: false,
        reason: "processWakePass не обработал ни одной записи (wake не поставился)",
        details: { wake },
      };
    }
    const w = db
      .prepare(
        `SELECT id, codex_followup_id, wake_acked_at FROM webhook_wake_queue
          WHERE subscription_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(subId) as
      | { id: number; codex_followup_id: string | null; wake_acked_at: string | null }
      | undefined;
    if (!w) {
      return {
        ok: false,
        reason: "в webhook_wake_queue нет строки для временной подписки",
        details: { wake },
      };
    }
    if (!w.codex_followup_id) {
      return {
        ok: false,
        reason: "codex_followup_id не распарсился — runner не вернул UUID",
        details: { wake, w },
      };
    }
    // wake_acked_at остаётся NULL — это queued, не acked (см. уточнение
    // ведущего 2026-10-10: ack только по независимому turn started).
    return { ok: true, reason: "" };
  } catch (e: any) {
    return { ok: false, reason: `ошибка пробного хода: ${String(e?.message ?? e).slice(0, 200)}` };
  } finally {
    // Подчищаем: каскад по webhook_subscriptions(id) ON DELETE CASCADE
    // снимет webhook_deliveries/attempts/wake_queue.
    if (subId) deleteSubscription(subId);
    // Синтетическая задача пробы — только декорация для доставки/пробуждения.
    // Если её не удалить, каждый старт сервера (и каждый плановый заход
    // сторожа) оставляет в главном проекте задачу «wake watcher probe» —
    // она видна владельцу и засоряет список задач, хотя не является работой.
    // `orchestrator_events.task_id` — TEXT без FK, поэтому event от неё не
    // зависит; его мы отдельно помечаем expired ниже.
    if (taskId) {
      try {
        db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      } catch {
        /* схема недоступна — не повод поднимать тревогу */
      }
    }
    // Синтетический event — помечаем expired, чтобы повторный прогон
    // увидел чистый state.
    if (probeEventId) {
      try {
        db.prepare("UPDATE orchestrator_events SET expired = 1 WHERE id = ?").run(probeEventId);
      } catch {
        /* таблица недоступна — не повод поднимать тревогу */
      }
    }
  }
}

function raise(reason: string, details?: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastRaisedAt < DAY_MS) return;
  lastRaisedAt = now;
  const id = `webhook-wake-watch-${Date.now().toString(36)}`;
  const title = `Wake-канал вебхуков не работает: ${reason}`;
  const description = [
    "## Что случилось",
    "Сторож прибора «wake-канал вебхуков» не смог выполнить пробный ход.",
    "",
    "## Причина",
    reason,
    details ? `\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`\n` : "",
    "",
    "## Что сломано",
    "Пробуждение Codex-чата по подпискам: даже если HTTP-доставка прошла,",
    "wake не уходит, или follow-up не парсится из stdout codex-cli.",
    "Владелец не увидит уведомлений в новом чате.",
    "",
    "## Что делать",
    "- Проверить миграцию 128_webhook_durable_secret_and_wake_ack.",
    "- Проверить, что TASKFLOW_WEBHOOK_SECRET_KEY задан и бутстрап прошёл.",
    "- Прогнать `server/test/webhookWakeWatcher.test.ts` локально.",
    "- Прогнать вручную `python3 scripts/orchestrator/tf_wake_dispatch.py <UUID> text` — должен вернуть `FOLLOWUP=...`.",
  ].join("\n");
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, priority, creator_id, status, agent_state, project_id
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?)`,
    ).run(id, title, description, PRIORITY, OWNER_ID, serverNotificationsProjectId(OWNER_ID));
  });
  txn();
  console.error(`[webhook-wake-watch] ПРИБОР НЕ РАБОТАЕТ: ${reason}`);
}

/** Сброс состояния для тестов. */
export function __setWatchState(at: number) {
  lastRaisedAt = at;
}
export function __resetWatchState() {
  lastRaisedAt = 0;
}

export function startWebhookWakeWatcher() {
  // Уборка старых пробных подписок, если предыдущий заход умер посередине.
  try {
    const stale = db
      .prepare("SELECT id FROM webhook_subscriptions WHERE id LIKE ?")
      .all(`${PROBE_PREFIX}%`) as Array<{ id: string }>;
    for (const s of stale) deleteSubscription(s.id);
  } catch {
    /* не смогли — не повод поднимать тревогу */
  }

  // Первая проверка — сразу при старте, чтобы поймать регрессы до того,
  // как их поймает владелец.
  checkWebhookWakeInstrument().then((r) => {
    if (!r.ok) raise(r.reason, r.details);
    else console.error("[webhook-wake-watch] прибор живой");
  });

  pollHandle = setInterval(async () => {
    const r = await checkWebhookWakeInstrument();
    if (!r.ok) raise(r.reason, r.details);
  }, INTERVAL_MS);
  pollHandle.unref?.();
}

export function stopWebhookWakeWatcher() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}