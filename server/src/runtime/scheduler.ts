// Планировщик — внутри сервера (владелец 01.10.2026: «зачем ключ, если он
// внутри системы всё делает?»). Раньше это был scripts/scheduler.py на
// systemd-таймере: раз в 5 минут он ходил в API служебным ключом Pi Agent,
// а запуски по расписанию поднимал через manual_run.sh → trigger.py с
// пачкой ключей ролей. Здесь те же шесть веток и те же ручки, но изнутри:
// пропуск служебной учётки выписывает сам сервер, роль поднимается в
// процессе (runRoleInProcess). Отметка живости — тот же файл, что у
// скрипта: по нему горит лампа «Расписание» и следит scheduler_watch.py.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { ROLE_NAMES, roleTitle } from "../roleRouting.js";
import { SCHEDULER_USER_ID } from "../serviceUser.js";
import { runRoleInProcess } from "./inProcessRun.js";
import {
  defaultSteps,
  parseSteps,
  selectSteps,
  stepKey,
  type EscalationRule,
  type EscalationStep,
  type EscalationTask,
} from "../lib/escalationEvaluator.js";
import { channelsForStep } from "../routes/escalation.js";

const RETRY_LIMIT = 3;
const RETRY_DELAY_MIN = 5;
/** Окно догона: давно прошедшее время запуска не воскрешаем. */
const RUN_CATCH_HOURS = 24;
export const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

export function schedulerHeartbeatPath(): string {
  return process.env.TASKFLOW_SCHEDULER_HEARTBEAT || path.join(os.homedir(), ".local", "state", "taskflow-scheduler", "last-run.json");
}

const log = (msg: string) => console.log(`[scheduler] ${msg}`);

type Api = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) => Promise<any>;

/** Вызов ручки сервера изнутри от служебной учётки — те же проверки, что у
 *  внешнего клиента, но пропуск выписан здесь же и нигде не хранится. */
function makeApi(app: FastifyInstance): Api {
  return async (method, url, body) => {
    const token = app.jwt.sign({ id: SCHEDULER_USER_ID, internalService: "scheduler" }, { expiresIn: "5m" });
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as any } : {}),
    });
    let data: any = {};
    try {
      data = res.body ? JSON.parse(res.body) : {};
    } catch {
      data = { text: res.body };
    }
    return res.statusCode >= 400 ? { error: data?.error ?? res.body, code: res.statusCode } : data;
  };
}

/** Роль карточки и подъём её внутри сервера — вместо manual_run.sh --once. */
async function launchRole(taskId: string, why: string): Promise<boolean> {
  const t = db.prepare(
    "SELECT assignee_id, dispatched_role, owner_selected_role, machine_selected_role FROM tasks WHERE id = ?",
  ).get(taskId) as
    | { assignee_id: string | null; dispatched_role: string | null; owner_selected_role: string | null; machine_selected_role: string | null }
    | undefined;
  if (!t) return false;
  const fromAssignee = t.assignee_id?.startsWith("role_") ? t.assignee_id.slice("role_".length) : null;
  const role = t.dispatched_role ?? t.owner_selected_role ?? t.machine_selected_role ?? fromAssignee;
  if (!role || !ROLE_NAMES.includes(role)) {
    log(`  ⚠️ ${taskId.slice(0, 8)}: роли нет — ${why} пропущен`);
    return false;
  }
  try {
    await runRoleInProcess({ taskId, role });
    logEvent({ taskId, actorId: SCHEDULER_USER_ID, kind: "run_requested", field: "executor", toValue: roleTitle(role) });
    return true;
  } catch (error) {
    log(`  ⚠️ ${taskId.slice(0, 8)}: ${why} не поднялся — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ── Ветки — один в один со scripts/scheduler.py ─────────────────────────

/** Ветка 1: технические блокировки — повтор (до RETRY_LIMIT), потом dead. */
async function retryTechnical(api: Api): Promise<number> {
  const tasks = await api("GET", `/api/tasks?agent_state=blocked&block_type=technical&retry_count_lt=${RETRY_LIMIT + 1}&blocked_older_min=${RETRY_DELAY_MIN}`);
  if (!Array.isArray(tasks)) return 0;
  let handled = 0;
  for (const t of tasks) {
    if (!t?.id) continue;
    const retryCount = Number(t.retry_count ?? 0);
    const res = retryCount >= RETRY_LIMIT
      ? await api("POST", `/api/tasks/${t.id}/state`, {
          state: "blocked",
          block_type: "dead",
          blocked_reason: `${t.blocked_reason ?? ""} | ${RETRY_LIMIT} попытки исчерпаны`.replace(/^[\s|]+|[\s|]+$/g, ""),
          block_notified: false,
        })
      : await api("POST", `/api/tasks/${t.id}/state`, { state: "todo" });
    if (res?.error) log(`  ⚠️ ${t.id.slice(0, 8)} ветка 1: ${res.error}`);
    else handled += 1;
  }
  return handled;
}

/** Ветка 2: «не моя роль» — переподбор; кандидатов нет — dead. */
async function repickWrongRole(api: Api): Promise<number> {
  const tasks = await api("GET", "/api/tasks?agent_state=blocked&block_type=wrong_role");
  if (!Array.isArray(tasks)) return 0;
  let handled = 0;
  for (const t of tasks) {
    if (!t?.id) continue;
    const choice = await api("POST", `/api/tasks/${t.id}/repick-role`);
    if (!choice || choice.error) {
      log(`  ⚠️ ${t.id.slice(0, 8)} repick: ${choice?.error}`);
      continue;
    }
    const res = choice.how === "dead" || !choice.role
      ? await api("POST", `/api/tasks/${t.id}/state`, {
          state: "blocked",
          block_type: "dead",
          blocked_reason: `${t.blocked_reason ?? ""} | все роли отказались`,
          block_notified: false,
        })
      : await api("POST", `/api/tasks/${t.id}/state`, {
          state: "todo",
          machine_selected_role: choice.role,
          block_type: null,
          comment: `Переподбор роли: ${choice.role} (how=${choice.how})`,
        });
    if (res?.error) log(`  ⚠️ ${t.id.slice(0, 8)} ветка 2: ${res.error}`);
    else handled += 1;
  }
  return handled;
}

/** Ветка 3: карточки в тупике — одно уведомление владельцу на карточку. */
async function notifyDead(api: Api): Promise<number> {
  const tasks = await api("GET", "/api/tasks?agent_state=blocked&block_type=dead");
  if (!Array.isArray(tasks)) return 0;
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  if (!owner) return 0;
  let handled = 0;
  for (const t of tasks) {
    if (!t?.id) continue;
    // Отметку — из базы: список задач поле block_notified не отдаёт.
    const flag = db.prepare("SELECT block_notified FROM tasks WHERE id = ?").get(t.id) as { block_notified: number | null } | undefined;
    if (flag?.block_notified) continue;
    const text = [
      "⛔ Карточка в тупике (dead):",
      `  id: ${t.id}`,
      `  заголовок: ${t.title || "(без названия)"}`,
      `  причина: ${t.blocked_reason ?? ""}`,
      `  отказались (role_exclusions): ${t.role_exclusions ?? "[]"}`,
      `  попыток (retry_count): ${t.retry_count ?? 0}`,
    ].join("\n");
    const notif = await api("POST", "/api/notifications", { user_id: owner.id, type: "task_dead", task_id: t.id, text, actor_id: null });
    if (!notif?.id) {
      log(`  ⚠️ ${t.id.slice(0, 8)}: уведомление не создано — ${notif?.error}`);
      continue;
    }
    // Отметку ставим сами: ручка /state умеет её только при смене
    // состояния, а «blocked → blocked» переходом не считается. Старый скрипт
    // звал /state и получал отказ — отметка не ставилась, и при первой же
    // тупиковой карточке он слал бы уведомление каждые 5 минут (найдено при
    // переносе 01.10.2026; тупиковых карточек тогда не было ни одной).
    db.prepare("UPDATE tasks SET block_notified = 1 WHERE id = ?").run(t.id);
    handled += 1;
  }
  return handled;
}

/** Ветка 4: наступило время запуска — поднять исполнителя-роль.
 *
 *  ⚠️ Перенесена как есть (01.10.2026): `run_at` сервер отдаёт только в
 *  карточке (hydrateTask), а не в списке `GET /api/tasks`, поэтому и в
 *  старом scripts/scheduler.py эта ветка ни разу ничего не запускала.
 *  Включать ли её (брать run_at из due_date+start_time) — решение владельца:
 *  после включения роли начнут подниматься на карточках со сроком. */
async function launchScheduled(api: Api, now: Date): Promise<number> {
  const tasks = await api("GET", "/api/tasks");
  if (!Array.isArray(tasks)) return 0;
  const floor = new Date(now.getTime() - RUN_CATCH_HOURS * 3600 * 1000);
  let handled = 0;
  for (const t of tasks) {
    if (t?.status !== "active" || t.agent_state != null) continue;
    if (!String(t.assignee_id ?? "").startsWith("role_") || !t.run_at) continue;
    const m = String(t.run_at).slice(0, 16).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (!m) continue;
    const when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    if (when > now || when < floor) continue;
    if (await launchRole(t.id, "запуск по времени")) {
      log(`  ⏰ ${t.id.slice(0, 8)} по времени ${t.run_at} — поднят исполнитель`);
      handled += 1;
    }
  }
  return handled;
}

/** Следующая дата серии — как `_next_due` в скрипте. */
export function nextDue(due: string, repeat: string): string | null {
  const m = due.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const add = (days: number) => d.setUTCDate(d.getUTCDate() + days);
  if (repeat === "daily") add(1);
  else if (repeat === "weekdays") {
    add(1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) add(1);
  } else if (repeat === "weekly") add(7);
  else if (repeat === "monthly") {
    const year = d.getUTCFullYear() + (d.getUTCMonth() === 11 ? 1 : 0);
    const month = (d.getUTCMonth() + 1) % 12;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(Number(m[3]), last))).toISOString().slice(0, 10);
  } else return null;
  return d.toISOString().slice(0, 10);
}

/** Ветка 5: повтор «одна за раз» — следующее вхождение по завершённой. */
async function cloneRecurring(api: Api, now: Date): Promise<number> {
  const items = await api("GET", "/api/scheduler/recurring");
  if (!Array.isArray(items)) return 0;
  let handled = 0;
  const yearEnd = `${now.getFullYear()}-12-31`;
  for (const t of items) {
    if (!t?.id || !t.due_date || !t.run_repeat) continue;
    const nxt = nextDue(String(t.due_date), String(t.run_repeat));
    if (!nxt) continue;
    const until = t.repeat_until ? String(t.repeat_until).slice(0, 10) : null;
    const cap = until && until < yearEnd ? until : yearEnd;
    if (nxt > cap) {
      // Предел — явный выбор владельца: серия закончена. Конец календарного
      // года — спросить владельца о продлении (решение 20.09.2026).
      if (until && until <= yearEnd) db.prepare("UPDATE tasks SET recurrence_spawned = 1, updated_at = datetime('now') WHERE id = ?").run(t.id);
      else await api("POST", `/api/tasks/${t.id}/repeat-ended`, {});
      continue;
    }
    const res = await api("POST", "/api/tasks", {
      title: t.title,
      description: t.description,
      due_date: nxt,
      start_time: t.start_time,
      project_id: t.project_id,
      assignee_id: t.assignee_id,
      run_repeat: t.run_repeat,
      repeat_until: t.repeat_until,
    });
    if (res?.task || res?.id) {
      // Служебная учётка не редактирует чужую карточку через общий PATCH.
      // Это служебная отметка обхода: сохраняем её здесь, как block_notified.
      db.prepare("UPDATE tasks SET recurrence_spawned = 1, updated_at = datetime('now') WHERE id = ?").run(t.id);
      log(`  ↻ ${t.id.slice(0, 8)} → следующая на ${nxt}`);
      handled += 1;
    } else {
      log(`  ⚠️ ${t.id.slice(0, 8)} следующая не создалась: ${res?.error}`);
    }
  }
  return handled;
}

/** Ветка 6: назревшие отложенные технические повторы. */
async function deferredRetries(api: Api): Promise<number> {
  const res = await api("POST", "/api/scheduler/deferred-retries/claim", {});
  const retries = Array.isArray(res?.retries) ? res.retries : null;
  if (!retries) return 0;
  let handled = 0;
  for (const r of retries) {
    if (r?.task_id && (await launchRole(r.task_id, "отложенный повтор"))) handled += 1;
  }
  return handled;
}

/** Ветка 8 (housekeeping): TTL-чистка escalation_events. Вынесена из
 *  notifyOverdue, чтобы окно тишины и enabled=0 не блокировали чистку —
 *  это операция обслуживания, не эскалация. Делается раз в сутки, когда
 *  под TZ владельца сейчас 03:00..03:05. */
export function escalationCleanupTick(now: Date = new Date()): number {
  const timezone = process.env.TASKFLOW_TIMEZONE || "Europe/Moscow";
  const cleanupClock = localTimeParts(now, timezone);
  if (!(cleanupClock.hour === 3 && cleanupClock.minute < 6)) return 0;
  try {
    const res = db
      .prepare(
        "DELETE FROM escalation_events WHERE sent_at < datetime('now', '-30 days')",
      )
      .run();
    if (res.changes > 0) log(`  ↻ escalation_events: очищено ${res.changes} строк старше 30 дней`);
    return res.changes;
  } catch (error) {
    log(`  ⚠️ escalation_events cleanup: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/** Ветка 7: умные напоминания о просроченных задачах (карточка
 *  615095f4-…). Документация — `docs/escalation-architecture.md` §3.
 *  Каждые 5 минут проверяем правила владельца и для каждой просроченной
 *  задачи creator=owner вставляем событие-маркер; если вставка удалась —
 *  создаём уведомление и (если в шаге есть `apns`) дёргаем
 *  queueLiveActivityPush. Дубликаты гасит UNIQUE-индекс
 *  uq_escalation_event_day. */
async function notifyOverdue(api: Api, now: Date): Promise<number> {
  // Один владелец на систему. Если их несколько — каждый получит уведомления
  // только по СВОИМ задачам (creator_id = user_id), и в §0 спеки это явно
  // обозначено как граница MVP.
  const owners = db
    .prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1")
    .all() as Array<{ id: string }>;
  if (owners.length === 0) return 0;
  const ownerId = owners[0].id;

  // Ленивая вставка дефолтной записи: как в роуте /rules, чтобы ветка
  // работала сразу после миграции 088 без отдельной инициализации.
  const rule = ensureRuleRow(ownerId);
  if (!rule.enabled) return 0;

  const { today, timezone } = summaryClockForScheduler(now);
  const local = localTimeParts(now, timezone);
  if (isInQuiet(rule, local.hour, local.minute, local.weekday)) return 0;

  const tasks = db
    .prepare(
      `SELECT id, title, priority, due_date, status
         FROM tasks
        WHERE creator_id = ?
          AND status = 'active'
          AND due_date IS NOT NULL
          AND trim(due_date) != ''`,
    )
    .all(ownerId) as EscalationTask[];

  let handled = 0;
  for (const t of tasks) {
    // Перепроверка status='active' непосредственно перед INSERT — R-6 из
    // спеки: между SELECT и INSERT владелец мог закрыть задачу.
    const steps: EscalationStep[] = selectSteps(rule, t, now, timezone);
    if (steps.length === 0) continue;
    for (const step of steps) {
      // step_key = "p<приоритет задачи>_h<after_hours>" — это метка
      // НА конкретной задаче, не на шаге. Один и тот же шаг 4ч сработает
      // и на P1 (priority=1), и на P2 (priority=2) — это разные события
      // с разными step_key. Так дедуп по (task, step) держится корректно:
      // нельзя подавить «4ч для P2» тем, что уже слали «4ч для P1».
      const taskPrio: 1 | 2 | 3 | 4 =
        t.priority == null
          ? 4
          : ([1, 2, 3, 4].includes(t.priority) ? (t.priority as 1 | 2 | 3 | 4) : 4);
      const key = stepKey(taskPrio, step.after_hours);
      const stillActive = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(t.id) as { status: string } | undefined;
      if (!stillActive || stillActive.status !== "active") continue;
      const evtId = newId();
      const ins = db
        .prepare(
          `INSERT OR IGNORE INTO escalation_events
             (id, task_id, user_id, step_key, sent_at)
           VALUES (?, ?, ?, ?, datetime('now'))`,
        )
        .run(evtId, t.id, ownerId, key);
      if (ins.changes === 0) continue; // уже слали сегодня — дубль
      // Создаём уведомление через ту же ручку, что и ветка 3: POST
      // /api/notifications от service user. type совпадает с key и с
      // notifications.type в спеке.
      const text = `⏰ Просрочено: ${t.title} · было ${t.due_date} · приоритет P${t.priority ?? 4}`;
      const channels = channelsForStep(rule, key);
      const created = await api("POST", "/api/notifications", {
        user_id: ownerId,
        type: `escalation_${key}`,
        task_id: t.id,
        text,
        actor_id: SCHEDULER_USER_ID,
      });
      const notifId: string | null = created?.id ?? null;
      if (notifId) {
        db.prepare(
          "UPDATE escalation_events SET notification_id = ? WHERE id = ?",
        ).run(notifId, evtId);
      }
      if (channels.includes("apns")) {
        // Live Activity-островок прилетает и без явного вызова, через
        // ws.broadcast(task:*) → queueLiveActivityPush. Прямой вызов тут
        // страхует случай, когда события по задаче не было (например,
        // сама эскалация — первое движение за день).
        try {
          const { queueLiveActivityPush } = await import("../apns.js");
          queueLiveActivityPush({ id: t.id, status: "active", title: t.title });
        } catch (error) {
          log(`  ⚠️ apns: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      handled += 1;
    }
  }
  // TTL-чистка живёт отдельной веткой (см. escalationCleanupTick) — здесь
  // её быть не должно: тишина и enabled=0 не должны блокировать housekeeping.
  return handled;
}

function ensureRuleRow(ownerId: string): EscalationRule {
  const row = db
    .prepare(
      "SELECT enabled, quiet_from, quiet_to, weekdays, steps_json FROM escalation_rules WHERE user_id = ?",
    )
    .get(ownerId) as
    | {
        enabled: number;
        quiet_from: string;
        quiet_to: string;
        weekdays: string;
        steps_json: string;
      }
    | undefined;
  if (row) {
    return {
      enabled: row.enabled === 1,
      quiet_from: row.quiet_from,
      quiet_to: row.quiet_to,
      weekdays: row.weekdays
        .split(",")
        .map((s) => Number(s))
        .filter((n) => n >= 1 && n <= 7),
      steps: parseSteps(row.steps_json),
    };
  }
  const steps = defaultSteps();
  db.prepare(
    `INSERT INTO escalation_rules (user_id, enabled, quiet_from, quiet_to, weekdays, steps_json)
     VALUES (?, 1, '22:00', '08:00', '1,2,3,4,5,6,7', ?)`,
  ).run(ownerId, JSON.stringify(steps));
  return {
    enabled: true,
    quiet_from: "22:00",
    quiet_to: "08:00",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    steps,
  };
}

function summaryClockForScheduler(now: Date): { today: string; timezone: string } {
  // Совпадает по логике с lib/secretaryTaskSummary.ts#summaryClock, но
  // импортировать тот модуль из scheduler.ts — затянуть лишние зависимости
  // (там подключается AI, чат, broadcast). Для тика нужны только дата и TZ.
  const timezone = process.env.TASKFLOW_TIMEZONE || "Europe/Moscow";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const v = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
  return { today: `${v("year")}-${v("month")}-${v("day")}`, timezone };
}

function localTimeParts(now: Date, timezone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const v = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const hour = Number(v("hour")) % 24;
  const minute = Number(v("minute"));
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = map[v("weekday")] ?? 1;
  return { hour, minute, weekday };
}

function isInQuiet(rule: EscalationRule, hour: number, minute: number, weekday: number): boolean {
  if (!rule.weekdays.includes(weekday)) return true;
  const [fromH, fromM] = parseHm(rule.quiet_from);
  const [toH, toM] = parseHm(rule.quiet_to);
  if (fromH === null || toH === null) return false;
  const cur = hour * 60 + minute;
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  if (from === to) return false;
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

function parseHm(value: string): [number, number] | [null, null] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return [null, null];
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return [null, null];
  return [h, min];
}

function newId(): string {
  // crypto.randomUUID есть в Node ≥ 14.17; в проекте он уже используется
  // (см. routes/notifications.ts), так что дублировать polyfill не нужно.
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
}

export type SchedulerCounts = { retry: number; repick: number; dead: number; scheduled: number; repeat: number; deferred: number; overdue: number; cleanup: number };

/** Один обход доски. Сбой ветки не валит остальные. */
export async function runSchedulerPass(app: FastifyInstance, now: Date = new Date()): Promise<SchedulerCounts> {
  const api = makeApi(app);
  const safe = async (name: string, fn: () => Promise<number>) => {
    try {
      return await fn();
    } catch (error) {
      log(`  ⚠️ ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };
  const counts: SchedulerCounts = {
    retry: await safe("ветка 1", () => retryTechnical(api)),
    repick: await safe("ветка 2", () => repickWrongRole(api)),
    dead: await safe("ветка 3", () => notifyDead(api)),
    scheduled: await safe("ветка 4", () => launchScheduled(api, now)),
    repeat: await safe("ветка 5", () => cloneRecurring(api, now)),
    deferred: await safe("ветка 6", () => deferredRetries(api)),
    overdue: await safe("ветка 7", () => notifyOverdue(api, now)),
    cleanup: await safe("ветка 8 (housekeeping)", async () => escalationCleanupTick(now)),
  };
  try {
    const file = schedulerHeartbeatPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = (n: number) => String(n).padStart(2, "0");
    const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    fs.writeFileSync(file, JSON.stringify({ at, at_epoch: now.getTime(), ...counts, source: "server" }));
  } catch (error) {
    log(`  ⚠️ отпечаток живости не записан: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Object.values(counts).some((n) => n > 0)) log(`итого: ${JSON.stringify(counts)}`);
  return counts;
}

/** Раз в 5 минут; первый обход — через полминуты после старта. */
export function startScheduler(app: FastifyInstance): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runSchedulerPass(app);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 30_000);
  const timer = setInterval(() => void tick(), SCHEDULER_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
