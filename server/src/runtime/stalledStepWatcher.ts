// Самовосстановление зависших шагов (карточка 71651ad0, поправки
// оркестратора 17:01–17:06 от 06.10.2026: один порог 10 минут по потоку
// событий хода, без пинга, до 2 автоперезапусков на шаг, затем blocked
// с техснимком и сигналом владельцу).
//
// Сигнал «жива» — поток событий хода. Журнал роли лежит в
// `~/.local/state/taskflow-runs/sessions/<task>-<role>-<step>/*.jsonl`;
// mtime самого свежего файла в каталоге и есть «последнее событие».
// 10 минут без новых записей → автоперезапуск. Свыше 2 перезапусков
// за окно — `blocked` и уведомление владельцу. Шаги с живым потоком
// (mtime < 10 мин) не трогаем.
//
// Граница с `recoverInterruptedPlanSubtasks` (рестарт сервера) и
// `settleStalledPlanNode` (ход завершился без сдачи) намеренная: этот
// модуль работает, пока ход НЕ завершился, но и событий по нему давно
// нет. Узлы `todo`/`blocked`/`done` не трогаем.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { roleTitle, roleUserId } from "../roleRouting.js";
import { technicalSlotSnapshot } from "./slotWorkSnapshot.js";
import { logStepAbandoned } from "./abandonedStep.js";
import { enqueueRoleRunJob } from "./roleRunQueue.js";
import { announceStepState } from "./stepTopicProgress.js";
import { startPlanSubtaskRun } from "./planSubtaskAdmission.js";
import { wakeAndDeliverStalled } from "./orchestratorWake.js";

/** Возраст последнего события хода, после которого шаг считается
 *  зависшим и сервер сам перезапускает попытку. Один порог, без
 *  исключений (поправка владельца 17:05 от 06.10.2026).
 *  MAK-95: значения приходят из реестра `serverSettings` и обновляются
 *  подпиской без перезапуска процесса. */
import { getSetting, onChange } from "../lib/serverSettings.js";
let STALL_AFTER_MIN = getSetting("stall_after_min");
/** Сколько автоперезапусков на слот за окно — после этого blocked. */
let MAX_RESTARTS_PER_WINDOW = getSetting("max_restarts_per_window");
onChange("stall_after_min", (v) => {
  STALL_AFTER_MIN = v;
});
onChange("max_restarts_per_window", (v) => {
  MAX_RESTARTS_PER_WINDOW = v;
});
const RESTART_WINDOW = "-2 hours";
/** Только плановые узлы: не-plan subtasks живут под своим контролем
 *  (поток ролей, heartbeat по задаче); путать с плановыми тут опасно. */
const PLAN_STEP_ONLY = true;

type StalledSubtask = {
  id: string;
  task_id: string;
  title: string;
  agent_state: string | null;
  current_attempt_id: string | null;
  agent_heartbeat_at: string | null;
  agent_id: string | null;
  collaboration_plan_id: string | null;
  plan_node_key: string | null;
};

function loadStalledSteps(): StalledSubtask[] {
  // План-фильтр в SQL: не-plan subtasks пусть живут под своими
  // механизмами, иначе тикер залезет в задачи, где роль вообще не
  // ведёт журнал сессии.
  return db.prepare(
    `SELECT id, task_id, title, agent_state, current_attempt_id, agent_heartbeat_at, agent_id, collaboration_plan_id, plan_node_key
       FROM subtasks
      WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = subtasks.task_id AND t.archived_at IS NULL)
        AND agent_state = 'in_progress'
        AND done = 0
        AND (collaboration_plan_id IS NOT NULL AND plan_node_key IS NOT NULL) = ?`,
  ).all(PLAN_STEP_ONLY ? 1 : 0) as StalledSubtask[];
}

function restartCount(subtaskId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM attempts
      WHERE subtask_id = ? AND outcome = 'auto_restarted'
        AND started_at >= datetime('now', ?)`,
  ).get(subtaskId, RESTART_WINDOW) as { n: number };
  return row.n;
}

function roleOf(subtask: StalledSubtask): string | null {
  if (!subtask.collaboration_plan_id || !subtask.plan_node_key) return null;
  const node = db.prepare("SELECT role_key FROM task_collaboration_plan_nodes WHERE plan_id = ? AND slot_key = ?")
    .get(subtask.collaboration_plan_id, subtask.plan_node_key) as { role_key: string } | undefined;
  return node?.role_key ?? null;
}

function ownerId(): string | null {
  const row = db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function taskHeads(taskId: string): { creator_id: string | null; assignee_id: string | null; title: string } {
  const row = db.prepare("SELECT creator_id, assignee_id, title FROM tasks WHERE id = ?").get(taskId) as
    | { creator_id: string | null; assignee_id: string | null; title: string }
    | undefined;
  return row ?? { creator_id: null, assignee_id: null, title: "" };
}

function postRoleNote(taskId: string, role: string, text: string): void {
  db.prepare("INSERT INTO comments (id, task_id, user_id, text) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), taskId, roleUserId(role), text);
}

function postOwnerNotification(taskId: string, title: string, body: string): void {
  const owner = ownerId();
  if (!owner) return;
  const notifId = crypto.randomUUID();
  db.prepare("INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'stalled_blocked', ?, ?, NULL)")
    .run(notifId, owner, taskId, body);
  logEvent({ taskId, actorId: null, kind: "stalled_step_blocked", field: title, toValue: body.slice(0, 160) });
}

/** mtime самого свежего `.jsonl` в каталоге сессии шага, или null,
 *  если каталога нет / он пуст. Поиск идёт по
 *  `~/.local/state/taskflow-runs/sessions/<task>-<role>-<step>` —
 *  формат имени зафиксирован HANDOFF-2026-10-05-orchestrator.md
 *  (mtime свежего .jsonl = «последнее событие хода»).
 *
 *  ВАЖНО (дефект D1, 06.10.2026): `inProcessRun.sessionDir` и
 *  `slotSessionDirectory` кладут журнал в `<task>-<role>-<subtaskId>`,
 *  где `subtaskId` — UUID подзадачи, а НЕ `plan_node_key`. Поэтому
 *  основной кандидат — UUID (`subtask.id`); `plan_node_key` и каталог
 *  без шага оставлены как legacy-fallback, чтобы не потерять записи
 *  старой раскладки. */
function lastSessionEventMs(subtask: StalledSubtask, role: string): number | null {
  const root = process.env.TASKFLOW_SESSIONS_DIR
    || path.join(os.homedir(), ".local", "state", "taskflow-runs", "sessions");
  if (!fs.existsSync(root)) return null;
  const slot = subtask.plan_node_key ?? "";
  const candidates = [
    path.join(root, `${subtask.task_id}-${role}-${subtask.id}`),
    path.join(root, `${subtask.task_id}-${role}-${slot}`),
    path.join(root, `${subtask.task_id}-${role}`),
  ];
  let latest: number | null = null;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(dir, name));
      } catch {
        continue;
      }
      const m = stat.mtimeMs;
      if (latest === null || m > latest) latest = m;
    }
    if (latest !== null) break;
  }
  return latest;
}

/** Закрыть попытку автоперезапуском. Возвращает 1 только если закрыли МЫ:
 *  `WHERE ended_at IS NULL` делает повторный тик идемпотентным, а значит
 *  и уведомление оркестратору уходит ровно один раз на попытку. */
function endAttemptAsAutoRestarted(attemptId: string, reason: string): number {
  return db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'auto_restarted', reason = ? WHERE id = ? AND ended_at IS NULL")
    .run(reason.slice(0, 500), attemptId).changes;
}

/** Личность события для сообщения оркестратору: id закрываемой попытки,
 *  а если попытки не было — цикл допуска (детерминированно в обоих
 *  случаях, поэтому повторный тик не заведёт второе сообщение). */
function attemptKeyFor(subtask: StalledSubtask): string {
  if (subtask.current_attempt_id) return subtask.current_attempt_id;
  const cycle = db.prepare("SELECT admission_cycle FROM subtasks WHERE id = ?").get(subtask.id) as { admission_cycle: number | null } | undefined;
  return `cycle:${cycle?.admission_cycle ?? "none"}`;
}

function markRestartedAndEnqueue(subtask: StalledSubtask, role: string, reason: string): { closed: boolean; attemptKey: string } {
  const attemptKey = attemptKeyFor(subtask);
  const closed = subtask.current_attempt_id
    ? endAttemptAsAutoRestarted(subtask.current_attempt_id, reason) === 1
    : false;
  db.prepare("UPDATE subtasks SET agent_state = NULL, agent_id = NULL, current_attempt_id = NULL, agent_heartbeat_at = NULL WHERE id = ?")
    .run(subtask.id);
  // Новый dedupe_key обязателен: иначе worker вернёт прежнее задание,
  // которое уже `succeeded` (Г1-к, 06.10.2026).
  enqueueRoleRunJob({
    taskId: subtask.task_id,
    reason: "after_run",
    actorId: null,
    dedupeKey: `stalled-restart:${subtask.id}:${crypto.randomUUID()}`,
  });
  postRoleNote(
    subtask.task_id,
    role,
    `«${subtask.title}»: поток событий остановился — перезапускаю попытку (${restartCount(subtask.id) + 1} из ${MAX_RESTARTS_PER_WINDOW}).`,
  );
  logEvent({ taskId: subtask.task_id, actorId: null, kind: "stalled_step_auto_restart", field: subtask.plan_node_key ?? subtask.id, toValue: reason.slice(0, 160) });
  return { closed, attemptKey };
}

function blockAsStalled(subtask: StalledSubtask, role: string, reason: string): void {
  const attemptKey = attemptKeyFor(subtask);
  if (subtask.current_attempt_id) {
    db.prepare("UPDATE attempts SET ended_at = datetime('now'), outcome = 'stalled_blocked', reason = ? WHERE id = ? AND ended_at IS NULL")
      .run(reason.slice(0, 500), subtask.current_attempt_id);
  }
  db.prepare("UPDATE subtasks SET agent_state = 'blocked', agent_id = ?, current_attempt_id = NULL, agent_heartbeat_at = NULL WHERE id = ?")
    .run(roleUserId(role), subtask.id);
  const blockedReason = `нет событий хода дольше ${STALL_AFTER_MIN} минут; автоперезапуск ${MAX_RESTARTS_PER_WINDOW}/${MAX_RESTARTS_PER_WINDOW} исчерпан. ${reason}`.slice(0, 600);
  // Карточка 7efcc173: автоблок шага виден владельцу в чате. АвтоРЕСТАРТ
  // выше по коду строки не пишет (перезапуск попытки — не смена состояния),
  // а автоблок — та же смена, что и блок ролью.
  announceStepState(subtask.id, "blocked", blockedReason);
  technicalSlotSnapshot(subtask.id, "blocked", {
    blocker: blockedReason,
    attemptId: subtask.current_attempt_id,
  });
  postRoleNote(
    subtask.task_id,
    role,
    `«${subtask.title}»: поток остановился, перезапуски исчерпаны — перевожу шаг в blocked. ${reason}`,
  );
  // Шаг брошен (MAK-97): прикладываем хвост журнала хода и снимок git —
  // получателю видно, где именно шаг встал.
  logStepAbandoned({ taskId: subtask.task_id, subtaskId: subtask.id, role, reason });
  const heads = taskHeads(subtask.task_id);
  postOwnerNotification(
    subtask.task_id,
    subtask.title,
    `⏸ Шаг «${subtask.title}» (${roleTitle(role)}) остановлен: поток событий молчит ${STALL_AFTER_MIN}+ минут, автоперезапуск ${MAX_RESTARTS_PER_WINDOW}/${MAX_RESTARTS_PER_WINDOW} не помог. Задача: «${heads.title}».`,
  );
  logEvent({ taskId: subtask.task_id, actorId: null, kind: "stalled_step_blocked_user", field: subtask.plan_node_key ?? subtask.id, toValue: roleTitle(role) });
  // Оркестратор ведёт план и должен узнать о зависании сам: молчаливый
  // автоблок — тот же дефект, что и молчаливый авторестарт (карточка
  // 2beb2bf2). Ключ события (`attemptKeyFor`) детерминирован и без
  // попытки — цикл допуска, поэтому сообщение уходит и у узла с пустым
  // `current_attempt_id` (D3, ревью критика 16.10.2026): раньше такой узел
  // блокировался в полной тишине, а запасной ключ был недостижим.
  // Повторы гасит сам ключ — `chat_messages.id` это primary key.
  wakeAndDeliverStalled(
    subtask.id,
    "stalled_blocked",
    attemptKey,
    `Роль: ${roleTitle(role)}. Поток событий молчал дольше ${STALL_AFTER_MIN} минут, автоперезапуск ${MAX_RESTARTS_PER_WINDOW}/${MAX_RESTARTS_PER_WINDOW} исчерпан — шаг переведён в blocked, снимок шага и уведомление владельцу записаны. Причина: ${reason}`,
  );
}

/** Сколько тик сторожа ждёт подтверждения, что новая попытка реально
 *  поднялась. Старт уходит в `runRoleInProcess` → `await acquireSlotSession`
 *  (inProcessRun.ts:1205), а аренда слота — промис-«хвост» в памяти
 *  процесса: если прежний запуск умер и не отпустил её, подтверждения не
 *  будет никогда. Ждать такого обещания до конца нельзя — тик не
 *  завершится, флаг `busy` не сбросится, и сторож перестанет смотреть за
 *  всеми узлами до рестарта сервера (дефект D1, ревью критика
 *  16.10.2026). Предел короткий и по истечении ничего не выдумывается:
 *  старт продолжается в фоне и сообщит по факту, если он упадёт.
 *  Переопределяется TASKFLOW_STALLED_START_WAIT_MS (тесты, стенды). */
function startConfirmWaitMs(): number {
  const raw = Number(process.env.TASKFLOW_STALLED_START_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
}

const START_UNCONFIRMED = Symbol("stalled-start-unconfirmed");

/** Дождаться `work`, но не дольше `ms`. Обещание, которое не
 *  разрешится никогда, не должно держать тик сторожа. */
async function confirmWithin<T>(work: Promise<T>, ms: number): Promise<T | typeof START_UNCONFIRMED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof START_UNCONFIRMED>((resolve) => { timer = setTimeout(() => resolve(START_UNCONFIRMED), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Развязать результат старта: успех молчит (сообщение о зависании уже
 *  ушло), отказ — отдельное сообщение с другим ключом события. `ours`
 *  отличает наше зависание от чужого события: если попытку закрыл не
 *  этот тик, молчим, о нём расскажет тот, кто его создал. */
function reportStart(
  subtask: StalledSubtask,
  attemptKey: string,
  fact: string,
  started: { ok: true; runId: string } | { ok: false; error: string },
  ours: boolean,
): void {
  if (started.ok) return;
  logEvent({ taskId: subtask.task_id, actorId: null, kind: "stalled_step_restart_failed", field: subtask.plan_node_key ?? subtask.id, toValue: started.error });
  if (!ours) return;
  wakeAndDeliverStalled(subtask.id, "stalled_restart_failed", attemptKey, `${fact} Запуск не удался: ${started.error}`);
}

async function restartAttempt(subtask: StalledSubtask, role: string, sinceMin: number): Promise<void> {
  const { closed, attemptKey } = markRestartedAndEnqueue(subtask, role, `авто-перезапуск после ${sinceMin} минут без событий хода`);
  // Зависание наше, если попытку закрыл этот тик (замок `.changes === 1`).
  // Узлу без текущей попытки закрывать нечего, но зависание всё равно
  // наше — иначе такой авторестарт прошёл бы в тишине, тот же класс
  // дефекта, что D3 на автоблоке. Всё прочее — чужое событие.
  const ours = closed || !subtask.current_attempt_id;
  const closedFact = closed
    ? `Сторож закрыл попытку ${attemptKey}`
    : subtask.current_attempt_id
      ? `Попытка ${attemptKey} была закрыта ранее, текущей у шага нет`
      : `У шага не было текущей попытки (${attemptKey})`;
  const fact = `Поток событий молчал ${sinceMin} минут (порог ${STALL_AFTER_MIN}). Роль: ${roleTitle(role)}. ${closedFact}, снял шаг с умершего запуска и запустил перезапуск ${restartCount(subtask.id)} из ${MAX_RESTARTS_PER_WINDOW}: новая попытка поставлена в очередь.`;
  // Уведомление уходит ЗДЕСЬ, до старта, и не зависит от его исхода:
  // при умершем держателе слота старт не разрешится никогда, а раньше
  // в этом случае не уходило ничего и тик замирал (D1). Формулировка
  // обещает только запуск перезапуска. Повторный тик по тому же
  // событию ничего не добавит: messageId детерминирован, а
  // `chat_messages.id` — primary key (`INSERT OR IGNORE`).
  if (ours) {
    wakeAndDeliverStalled(subtask.id, "stalled_restarted", attemptKey, `${fact} Перезапуск запущен; если старт не пройдёт, придёт отдельное сообщение.`);
  }
  // `enqueueRoleRunJob` положил задание в очередь; стартанём role
  // in-process сами, чтобы ход не ждал следующего тика worker'а — иначе
  // карточка выглядит «тишина в ленте» ещё минуту (Г1-к/Г1-л).
  const started = startPlanSubtaskRun(subtask.id, roleUserId(role));
  const waitMs = startConfirmWaitMs();
  const confirmed = await confirmWithin(started, waitMs);
  if (confirmed === START_UNCONFIRMED) {
    // Слот, скорее всего, держит умерший запуск. Тик его не ждёт —
    // иначе замерзнет совсем, — но отказа тоже не выдумывает: старт
    // продолжается сам, и сообщение о нём уйдёт по факту.
    logEvent({ taskId: subtask.task_id, actorId: null, kind: "stalled_step_restart_pending", field: subtask.plan_node_key ?? subtask.id, toValue: `подтверждение старта не пришло за ${Math.round(waitMs / 1000)} с` });
    const late = (result: { ok: true; runId: string } | { ok: false; error: string }) => reportStart(subtask, attemptKey, fact, result, ours);
    void started.then(late, (error: unknown) => late({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  reportStart(subtask, attemptKey, fact, confirmed, ours);
}

export type StalledStepReport = {
  /** Узлов, по которым прошёлся тикер (поток роли не растёт). */
  stalled: number;
  restarted: number;
  blocked: number;
};

/**
 * Один обход «сторожа зависших шагов». Логика:
 *  • для каждого планового узла `agent_state='in_progress'` смотрит
 *    mtime свежего `.jsonl` журнала сессии (поток событий хода);
 *  • если событий нет `STALL_AFTER_MIN+` минут и перезапусков меньше
 *    лимита — закрыть попытку, сбросить дедупликацию, поставить
 *    новую в очередь и поднять `startPlanSubtaskRun`;
 *  • если лимит исчерпан — `blocked` + техснимок + уведомление
 *    владельцу.
 *
 * Узлы с живым потоком (mtime < STALL_AFTER_MIN) или без каталога
 * сессии (ещё не стартовали) не трогаем: первый запуск в норме
 * пишет первые события не сразу.
 */
export async function runStalledStepWatch(now: Date = new Date()): Promise<StalledStepReport> {
  const stalled = loadStalledSteps();
  const report: StalledStepReport = { stalled: stalled.length, restarted: 0, blocked: 0 };
  const thresholdMs = STALL_AFTER_MIN * 60_000;
  const restarts_in_flight: Array<Promise<void>> = [];
  for (const subtask of stalled) {
    const role = roleOf(subtask);
    if (!role) continue;
    const lastMs = lastSessionEventMs(subtask, role);
    if (lastMs === null) {
      // Каталога сессии ещё нет (только что стартовали) или у роли
      // другая схема журнала. Опора только на `agent_heartbeat_at`:
      // если он младше порога, идём дальше; иначе считаем зависшим.
      const hb = subtask.agent_heartbeat_at ? new Date(`${subtask.agent_heartbeat_at}Z`).getTime() : 0;
      if (!hb || now.getTime() - hb < thresholdMs) continue;
      // heartbeat старый, но и журнала нет — это пуск, который умер
      // ещё до первой записи: рестартуем.
    } else if (now.getTime() - lastMs < thresholdMs) {
      continue;
    }
    const sinceMin = lastMs === null
      ? Math.max(STALL_AFTER_MIN, Math.floor((now.getTime() - (subtask.agent_heartbeat_at ? new Date(`${subtask.agent_heartbeat_at}Z`).getTime() : now.getTime())) / 60_000))
      : Math.floor((now.getTime() - lastMs) / 60_000);
    const restarts = restartCount(subtask.id);
    if (restarts >= MAX_RESTARTS_PER_WINDOW) {
      blockAsStalled(subtask, role, `лимит автоперезапуска ${MAX_RESTARTS_PER_WINDOW} за ${RESTART_WINDOW} исчерпан`);
      report.blocked += 1;
    } else {
      restarts_in_flight.push(restartAttempt(subtask, role, sinceMin).then(() => { report.restarted += 1; }));
    }
  }
  await Promise.all(restarts_in_flight);
  return report;
}

/** Раз в минуту; первый обход — через 70 секунд, чтобы отличаться от
 *  пятиминутного `startScheduler` и не толпиться в одну секунду. */
export const STALLED_STEP_WATCH_INTERVAL_MS = 60_000;
export const STALLED_STEP_WATCH_FIRST_DELAY_MS = 70_000;

export function startStalledStepWatch(): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const report = await runStalledStepWatch();
        if (report.stalled > 0) {
          console.log(`[stalled-watch] stalled=${report.stalled} restarted=${report.restarted} blocked=${report.blocked} threshold=${STALL_AFTER_MIN}min`);
        }
      } catch (error) {
        console.warn(`[stalled-watch]: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
      }
    })();
  };
  const first = setTimeout(tick, STALLED_STEP_WATCH_FIRST_DELAY_MS);
  const timer = setInterval(tick, STALLED_STEP_WATCH_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
