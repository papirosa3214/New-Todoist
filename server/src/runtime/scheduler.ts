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

export type SchedulerCounts = { retry: number; repick: number; dead: number; scheduled: number; repeat: number; deferred: number };

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
