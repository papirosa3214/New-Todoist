// Снимок рабочего состояния слота — «на чём остановился» (владелец
// 04.10.2026, LOCK-SLOT-SNAPSHOT-20261004).
//
// Зачем. Ход роли живёт только внутри процесса сервера: сессия сохранена на
// диске, но следующий вызов той же роли получает задание заново и по этому
// заданию не видно, где работа остановилась — только «сделано/осталось» из
// итога закрытого шага (а его может и не быть: слот часто остаётся недоделанным).
// Снимок — короткая запись о том, где слот стоял в момент остановки, чтобы
// продолжение начиналось с фактов, а не с догадок.
//
// Что снимок НЕ делает (границы владельца): не даёт прав и не двигает
// состояния. Права, статусы, аренда и порядок этапов остаются под контролем
// сервера — снимок это данные, а не команда.
//
// Две независимые вещи, которые важно не смешивать:
//   • Снимок — что РОЛЬ сообщила о работе (сделано/осталось/блок/шаг) или,
//     если не успела, техфакты сервера (последнее действие, состояние, ссылки).
//     Техснимок всегда помечается неполным (`is_complete = 0`).
//   • Время последней рабочей активности — отдельно, из
//     `subtasks.agent_heartbeat_at`/`attempts.heartbeat_at`. Момент записи
//     снимка ею не подменяется: снимок могли записать секунду назад поверх
//     работы, которая шла два часа назад.
import crypto from "node:crypto";
import { getSetting } from "../lib/serverSettings.js";
import db from "../db.js";
import { roleTitle } from "../roleRouting.js";

export const SNAPSHOT_REASONS = ["progress", "done", "blocked", "stopped", "failed"] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number] | string;

/** Снимок читает и человек, и модель — длинные простыни тут не по делу:
 *  поля короткие, лишнее подрезается на записи. Это подрезка самого снимка,
 *  а не правило для сообщений роли в чате (таких запретов у сервера больше
 *  нет, 04.10.2026). */
const FIELD_MAX = 400;
const BLOCK_MAX = 2_400;
const ARTIFACT_MAX = 12;
const HISTORY_MAX = 20;
/** Аренда слота — 5 минут (LEASE_MINUTES в agentState.ts). */
const LEASE_MINUTES = 5;
/** Сколько снимков на слот держим в базе. История всё равно показывается
 *  последними HISTORY_MAX, а без предела таблица росла бы вместе с ходом:
 *  периодический техснимок пишется сервером сам, без модели. */
export const SNAPSHOT_KEEP = HISTORY_MAX;

export interface SlotSnapshotRow {
  id: string;
  task_id: string;
  subtask_id: string;
  attempt_id: string | null;
  role_key: string | null;
  plan_node_key: string | null;
  reason: string;
  is_complete: 0 | 1;
  done_summary: string | null;
  left_summary: string | null;
  blocker: string | null;
  next_step: string | null;
  last_action: string | null;
  artifacts_json: string;
  author_id: string | null;
  created_at: string;
}

export interface SnapshotInput {
  subtaskId: string;
  reason: SnapshotReason;
  /** Что сделано. */
  done?: string | null;
  /** Что осталось. */
  left?: string | null;
  /** Текущий блок. */
  blocker?: string | null;
  /** Следующий шаг. */
  nextStep?: string | null;
  /** Ссылки на артефакты: строки или {kind,title,ref}. */
  artifacts?: unknown;
  /** Техническое: последнее действие (для снимка без участия модели). */
  lastAction?: string | null;
  /** true — снимок полный (роль сказала всё сама), false — техснимок. */
  complete?: boolean;
  /** Попытка; по умолчанию текущая попытка слота. */
  attemptId?: string | null;
  /** Кто записал (роль или владелец). */
  authorId?: string | null;
}

function one(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: unknown, max = FIELD_MAX): string | null {
  if (typeof text !== "string") return null;
  const flat = one(text);
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function normArtifacts(input: unknown): string {
  if (!Array.isArray(input)) return "[]";
  const out: unknown[] = [];
  for (const item of input.slice(0, ARTIFACT_MAX)) {
    if (typeof item === "string") {
      const s = clip(item);
      if (s) out.push({ title: s });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const title = clip(o.title ?? o.name ?? o.key ?? null);
      const ref = clip(o.ref ?? o.url ?? o.id ?? null);
      const kind = clip(o.kind ?? o.artifact_key ?? null, 60);
      if (title || ref) out.push({ ...(kind ? { kind } : {}), ...(title ? { title } : {}), ...(ref ? { ref } : {}) });
    }
  }
  return JSON.stringify(out);
}

export function parseArtifacts(raw: string | null | undefined): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type SlotRow = {
  id: string;
  task_id: string;
  title: string;
  done: number;
  agent_id: string | null;
  agent_state: string | null;
  agent_heartbeat_at: string | null;
  current_attempt_id: string | null;
  collaboration_plan_id: string | null;
  plan_node_key: string | null;
  result: string | null;
};

function slotRow(subtaskId: string): SlotRow | undefined {
  return db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId) as SlotRow | undefined;
}

function roleKeyOf(agentId: string | null): string | null {
  if (!agentId) return null;
  const row = db.prepare("SELECT role_key FROM users WHERE id = ?").get(agentId) as { role_key?: string | null } | undefined;
  return row?.role_key ?? null;
}

/** Попытки слота по возрастанию — их порядок и определяет, чей снимок свежее. */
function attemptsOldestFirst(subtaskId: string): Array<{ id: string; started_at: string | null; outcome: string | null; ended_at: string | null }> {
  return db
    .prepare("SELECT id, started_at, outcome, ended_at FROM attempts WHERE subtask_id = ? ORDER BY started_at, rowid")
    .all(subtaskId) as Array<{ id: string; started_at: string | null; outcome: string | null; ended_at: string | null }>;
}

/**
 * Записать снимок. Снимок всегда остаётся в истории: запрет в плане владельца
 * касается не записи, а актуальности — «более старый запуск не может заменить
 * снимок новой попытки». Поэтому поздняя запись сохраняется, но `stale: true`
 * в ответе и в выборке «последнего» она не участвует.
 */
export function saveSlotSnapshot(input: SnapshotInput): { snapshot: SlotSnapshotRow; stale: boolean } {
  const slot = slotRow(input.subtaskId);
  if (!slot) throw new Error("шаг не найден");
  const attemptId = input.attemptId !== undefined ? input.attemptId : slot.current_attempt_id;
  const id = crypto.randomUUID();
  const done = clip(input.done);
  const left = clip(input.left);
  const blocker = clip(input.blocker);
  const nextStep = clip(input.nextStep);
  const lastAction = clip(input.lastAction);
  // Полным снимок считаем только когда роль сказала хоть что-то сама: иначе
  // это техфакты сервера, и следующий вызов должен видеть пометку «неполный».
  const complete = input.complete ?? Boolean(done ?? left ?? blocker ?? nextStep);
  db.prepare(
    `INSERT INTO slot_work_snapshots
       (id, task_id, subtask_id, attempt_id, role_key, plan_node_key, reason,
        is_complete, done_summary, left_summary, blocker, next_step, last_action,
        artifacts_json, author_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    slot.task_id,
    slot.id,
    attemptId ?? null,
    roleKeyOf(slot.agent_id),
    slot.plan_node_key,
    String(input.reason),
    complete ? 1 : 0,
    done,
    left,
    blocker,
    nextStep,
    lastAction,
    normArtifacts(input.artifacts),
    input.authorId ?? slot.agent_id ?? null,
  );
  pruneSlotSnapshots(slot.id);
  const snapshot = db.prepare("SELECT * FROM slot_work_snapshots WHERE id = ?").get(id) as SlotSnapshotRow;
  if (complete && String(input.reason) === "done" && !process.env.VITEST) {
    void import("./slotMemoryObserver.js")
      .then((m) => m.observeSlotMemory(snapshot))
      .catch((err: { message?: string }) => console.warn("[slot-memory-observer]", err?.message ?? err));
  }
  return { snapshot, stale: Boolean(attemptId) && attemptId !== slot.current_attempt_id };
}

/** Держим на слот только последние SNAPSHOT_KEEP снимков. Читатели всё
 *  равно видят лишь последние HISTORY_MAX (`slotSnapshotHistory`), а таблица
 *  без предела росла бы от каждого тика сервера. */
export function pruneSlotSnapshots(subtaskId: string, keep = getSetting("snapshot_keep")): number {
  const info = db
    .prepare(
      `DELETE FROM slot_work_snapshots
        WHERE subtask_id = ? AND id NOT IN (
          SELECT id FROM slot_work_snapshots
           WHERE subtask_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
        )`,
    )
    .run(subtaskId, subtaskId, Math.max(1, Math.floor(keep)));
  return info.changes;
}

/** Ссылки на артефакты слота — то, что сервер знает о работе без модели. */
function technicalArtifacts(subtaskId: string): Array<Record<string, unknown>> {
  const rows = db
    .prepare(
      `SELECT artifact_key, version_no, status FROM subtask_artifact_versions
        WHERE subtask_id = ? ORDER BY version_no DESC LIMIT ?`,
    )
    .all(subtaskId, ARTIFACT_MAX) as Array<{ artifact_key: string; version_no: number; status: string }>;
  return rows.map((r) => ({ kind: r.artifact_key, title: `${r.artifact_key} v${r.version_no}`, ref: r.status }));
}

/** Последнее, что сервер видел по слоту, — для техснимка. */
function lastKnownAction(subtaskId: string, taskId: string): string | null {
  const event = db
    .prepare(
      `SELECT kind, to_value FROM task_events
        WHERE task_id = ? AND (field = ? OR field = (SELECT plan_node_key FROM subtasks WHERE id = ?))
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, subtaskId, subtaskId) as { kind?: string; to_value?: string | null } | undefined;
  if (!event?.kind) return null;
  return clip(event.to_value ? `${event.kind}: ${event.to_value}` : event.kind);
}

/**
 * Техснимок — пишет сервер сам, без участия модели: последнее действие,
 * состояние и ссылки. Так снимок появляется даже там, где модель не ответила
 * (обрыв, сбой, аварийная остановка), и всегда помечен неполным.
 */
export function technicalSlotSnapshot(
  subtaskId: string,
  reason: SnapshotReason,
  extra: { blocker?: string | null; lastAction?: string | null; artifacts?: unknown; attemptId?: string | null } = {},
): { snapshot: SlotSnapshotRow; stale: boolean } | null {
  const slot = slotRow(subtaskId);
  if (!slot) return null;
  const artifacts = extra.artifacts ?? technicalArtifacts(subtaskId);
  return saveSlotSnapshot({
    subtaskId,
    reason,
    complete: false,
    done: reason === "done" ? slot.result : null,
    blocker: extra.blocker ?? (reason === "blocked" ? slot.result : null),
    lastAction: extra.lastAction ?? lastKnownAction(subtaskId, slot.task_id),
    artifacts,
    ...(extra.attemptId !== undefined ? { attemptId: extra.attemptId } : {}),
  });
}

function attemptRank(subtaskId: string): Map<string, number> {
  const rank = new Map<string, number>();
  attemptsOldestFirst(subtaskId).forEach((a, i) => rank.set(a.id, i));
  return rank;
}

/**
 * Снимок, который показывают следующему вызову роли.
 *
 * Пока идёт текущая попытка, важен снимок ПРЕДЫДУЩЕЙ: он и рассказывает, где
 * работа остановилась. Когда попытки нет (слот ждёт, заблокирован или уже
 * закрыт) — последний снимок вообще. `beforeAttempt` — тот же выбор для
 * интерфейса, которому нужен «тот самый» снимок.
 */
export function latestSlotSnapshot(subtaskId: string, opts: { beforeAttempt?: boolean } = {}): SlotSnapshotRow | null {
  const rows = db
    .prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at, rowid")
    .all(subtaskId) as SlotSnapshotRow[];
  if (!rows.length) return null;
  const slot = slotRow(subtaskId);
  const rank = attemptRank(subtaskId);
  const currentId = slot?.current_attempt_id ?? null;
  if (opts.beforeAttempt) {
    if (!currentId) return rows[rows.length - 1];
    const currentRank = rank.get(currentId);
    if (currentRank === undefined) return rows[rows.length - 1];
    const earlier = rows.filter((r) => {
      if (!r.attempt_id) return false;
      const r_rank = rank.get(r.attempt_id);
      return r_rank !== undefined && r_rank < currentRank;
    });
    return earlier.length ? earlier[earlier.length - 1] : null;
  }
  // Актуальным считаем снимок самой свежей попытки: поздняя запись старого
  // запуска в историю попала, но актуальным не станет. Если у свежей попытки
  // снимков ещё нет — отдаём последний известный (работа предыдущей попытки),
  // а вызывающий обязан пометить его как относящийся к более ранней попытке:
  // см. `slotSnapshotDto().latest_from_earlier_attempt`.
  const lastRank = Math.max(-1, ...[...rank.values()]);
  const newestAttemptRows = rows.filter((r) => {
    if (!r.attempt_id) return false;
    const r_rank = rank.get(r.attempt_id);
    return r_rank !== undefined && r_rank === lastRank;
  });
  if (newestAttemptRows.length) return newestAttemptRows[newestAttemptRows.length - 1];
  return rows[rows.length - 1];
}

export function slotSnapshotHistory(subtaskId: string, limit = HISTORY_MAX): SlotSnapshotRow[] {
  return db
    .prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(subtaskId, limit) as SlotSnapshotRow[];
}

function minutesSince(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const then = Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

function agoRu(minutes: number | null): string {
  if (minutes === null) return "неизвестно";
  if (minutes < 1) return "меньше минуты назад";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Последняя по времени запись о слоте — не путать с `latestSlotSnapshot`,
 *  который выбирает снимок самой свежей попытки: для throttle и dedupe
 *  периодического техснимка нужен именно «что записано последним». */
function lastSnapshotRow(subtaskId: string): SlotSnapshotRow | null {
  const row = db
    .prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(subtaskId) as SlotSnapshotRow | undefined;
  return row ?? null;
}

function ageMs(stamp: string | null | undefined, now = Date.now()): number | null {
  if (!stamp) return null;
  const then = Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);
  if (Number.isNaN(then)) return null;
  return Math.max(0, now - then);
}

/** Совпадает ли новая техзапись с уже сохранённой: причина, полнота, все
 *  текстовые поля и артефакты. Если да — писать второй подряд
 *  бессмысленно, снимок ничего не сообщает. */
function sameSnapshotContent(a: SlotSnapshotRow, b: SnapshotInput): boolean {
  return (
    a.reason === String(b.reason) &&
    a.is_complete === (b.complete ? 1 : 0) &&
    (a.done_summary ?? null) === (b.done ?? null) &&
    (a.left_summary ?? null) === (b.left ?? null) &&
    (a.blocker ?? null) === (b.blocker ?? null) &&
    (a.next_step ?? null) === (b.nextStep ?? null) &&
    (a.last_action ?? null) === (b.lastAction ?? null) &&
    a.artifacts_json === normArtifacts(b.artifacts)
  );
}

export type PeriodicSnapshotResult =
  | { written: true; snapshot: SlotSnapshotRow; stale: boolean }
  | { written: false; skipped: "not-found" | "not-slot" | "not-working" | "fresh" | "unchanged" };

/**
 * Периодический техснимок идущего слота — пишет сервер, без модели.
 *
 * Зовётся на каждом продлении аренды слота (роль или её собственный beat
 * раз в 90 секунд), но пишет не чаще, чем раз в LEASE_MINUTES: чаще —
 * лишние строки, реже — дыра в «где стояла работа». Если с прошлого снимка
 * ничего не изменилось, второй подряд не пишется вовсе: одинаковые снимки
 * не сообщают ничего нового. Полный снимок от роли при этом не подменяется:
 * техснимок всегда `is_complete = 0`.
 */
export function periodicSlotSnapshot(subtaskId: string, opts: { now?: number } = {}): PeriodicSnapshotResult {
  const slot = slotRow(subtaskId);
  if (!slot) return { written: false, skipped: "not-found" };
  // Техснимок идущего слота — только у узла плана: у личной подзадачи нет
  // «предыдущей попытки» и подкладки следующему вызову, там снимок не нужен.
  if (!slot.collaboration_plan_id) return { written: false, skipped: "not-slot" };
  // Пишем только пока работа реально идёт: у сданного, заблокированного или
  // отпущенного слота уже есть своя запись (done/blocked/stopped).
  if (slot.done || slot.agent_state !== "in_progress") return { written: false, skipped: "not-working" };

  const now = opts.now ?? Date.now();
  const last = lastSnapshotRow(subtaskId);
  if (last) {
    const age = ageMs(last.created_at, now);
    if (age !== null && age < getSetting("snapshot_interval_min") * 60_000) return { written: false, skipped: "fresh" };
  }

  const candidate: SnapshotInput = {
    subtaskId,
    reason: "progress",
    complete: false,
    lastAction: lastKnownAction(subtaskId, slot.task_id),
    artifacts: technicalArtifacts(subtaskId),
  };
  // Одинаковые подряд не плодим. Смена попытки — не «то же самое»: новой
  // попытке нужен свой снимок, даже если текст совпал.
  if (last && last.attempt_id === slot.current_attempt_id && sameSnapshotContent(last, candidate)) {
    return { written: false, skipped: "unchanged" };
  }
  const saved = saveSlotSnapshot(candidate);
  return { written: true, ...saved };
}

export type SlotWorkState = {
  state: string | null;
  working: boolean;
  last_activity_at: string | null;
  last_activity_age_min: number | null;
};

/** Работает ли слот сейчас и как свежи его сведения. Только факты БД: признак
 *  «процесс жив» умирает вместе с сервером, а показывать его в снимке Means
 *  ровно то, что врёт после перезапуска. */
export function slotWorkState(subtaskId: string): SlotWorkState {
  const slot = slotRow(subtaskId);
  const state = slot?.agent_state ?? null;
  const lastActivity = slot?.agent_heartbeat_at ?? null;
  const age = minutesSince(lastActivity);
  return {
    state,
    working: state === "in_progress" && age !== null && age <= LEASE_MINUTES,
    last_activity_at: lastActivity,
    last_activity_age_min: age,
  };
}

function attemptLabel(subtaskId: string, attemptId: string | null): string | null {
  if (!attemptId) return null;
  const rank = attemptRank(subtaskId).get(attemptId);
  return rank === undefined ? null : `попытка ${rank + 1}`;
}

function oneLine(snapshot: SlotSnapshotRow): string {
  const done = snapshot.done_summary ?? snapshot.last_action ?? "—";
  const next = snapshot.next_step ?? snapshot.left_summary ?? "—";
  return `сделано: ${done}; дальше: ${next}`;
}

export type SnapshotBlockOptions = {
  /** Заголовок блока. */
  title?: string;
  /** Дописать в конце (обычно — про то, что слот работает сейчас). */
  footer?: string;
};

/**
 * Блок «на чём остановился» для задания роли. Факты о работе, без
 * размышлений модели и без команд: снимок не даёт прав (границы владельца).
 */
export function snapshotBlock(snapshot: SlotSnapshotRow, opts: SnapshotBlockOptions = {}): string {
  const work = slotWorkState(snapshot.subtask_id);
  const attempt = attemptLabel(snapshot.subtask_id, snapshot.attempt_id);
  const head = [
    opts.title ?? "На чём остановился предыдущий ход",
    `снимок от ${snapshot.created_at}`,
    attempt,
    snapshot.is_complete ? null : "неполный — техснимок сервера, роль не ответила",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    head,
    snapshot.done_summary ? `Сделано: ${snapshot.done_summary}` : null,
    snapshot.left_summary ? `Осталось: ${snapshot.left_summary}` : null,
    snapshot.blocker ? `Блок: ${snapshot.blocker}` : null,
    snapshot.next_step ? `Следующий шаг: ${snapshot.next_step}` : null,
    !snapshot.done_summary && snapshot.last_action ? `Последнее действие: ${snapshot.last_action}` : null,
    parseArtifacts(snapshot.artifacts_json).length
      ? `Артефакты: ${parseArtifacts(snapshot.artifacts_json).map((a) => String(a.title ?? a.ref ?? "")).filter(Boolean).join(", ")}`
      : null,
    work.state
      ? `Слот сейчас: ${work.state === "in_progress" ? (work.working ? "в работе" : "в работе, но аренда истекла") : work.state === "blocked" ? "заблокирован" : work.state}, последняя активность ${agoRu(work.last_activity_age_min)}`
      : `Последняя активность: ${agoRu(work.last_activity_age_min)}`,
    opts.footer ?? null,
  ].filter((l): l is string => Boolean(l));
  return lines.join("\n").slice(0, BLOCK_MAX);
}

/** Блок для конкретного слота: его снимок перед текущей попыткой. */
export function slotSnapshotBlock(subtaskId: string, opts: SnapshotBlockOptions = {}): string | null {
  const snapshot = latestSlotSnapshot(subtaskId, { beforeAttempt: true });
  if (!snapshot) return null;
  return snapshotBlock(snapshot, opts);
}

/**
 * Блок для общего контекста роли (чат). Для конкретного этапа — его снимок;
 * без этапа и с несколькими слотами — короткий перечень, по одной строке на
 * слот, иначе контекст растёт вместе с планом.
 */
export function roleSlotSnapshotsBlock(input: { role: string; taskId?: string | null; projectId?: string | null; subtaskId?: string | null }): string | null {
  const slots = input.subtaskId
    ? ([input.subtaskId] as string[])
    : input.taskId
      ? (
          db
            .prepare(
              `SELECT id FROM subtasks
                WHERE task_id = ? AND done = 0 AND agent_id = (SELECT id FROM users WHERE role_key = ?)
                ORDER BY rowid DESC LIMIT 5`,
            )
            .all(input.taskId, input.role) as Array<{ id: string }>
        ).map((r) => r.id)
      : input.projectId
        ? (
            db
              .prepare(
                `SELECT s.id FROM subtasks s JOIN tasks t ON t.id = s.task_id
                  WHERE t.project_id = ? AND s.done = 0 AND s.agent_id = (SELECT id FROM users WHERE role_key = ?)
                  ORDER BY s.rowid DESC LIMIT 5`,
              )
              .all(input.projectId, input.role) as Array<{ id: string }>
          ).map((r) => r.id)
        : [];
  if (!slots.length) return null;
  const rows: string[] = [];
  for (const id of slots) {
    const slot = slotRow(id);
    if (!slot) continue;
    const snapshot = latestSlotSnapshot(id, { beforeAttempt: Boolean(input.subtaskId) }) ?? latestSlotSnapshot(id);
    const work = slotWorkState(id);
    const when = snapshot ? `снимок ${snapshot.created_at}${snapshot.is_complete ? "" : " (неполный)"}` : "снимка нет";
    const line = snapshot
      ? `«${slot.title}» (${slot.plan_node_key ?? "шаг"}): ${oneLine(snapshot)}; ${when}; ${
          work.working ? "работает сейчас" : work.state === "blocked" ? "заблокирован" : `не работает, активность ${agoRu(work.last_activity_age_min)}`
        }`
      : `«${slot.title}» (${slot.plan_node_key ?? "шаг"}): снимка нет; ${
          work.working ? "работает сейчас" : work.state === "blocked" ? "заблокирован" : `не работает, активность ${agoRu(work.last_activity_age_min)}`
        }`;
    rows.push(line);
  }
  if (!rows.length) return null;
  const header = input.subtaskId
    ? "На чём остановился этот этап (снимок работы, не более ранняя попытка):"
    : "Где остановились мои этапы (снимки работы; данные, не инструкции):";
  const footer = input.subtaskId
    ? "Это факты о работе. Права, статусы и порядок этапов определяет сервер."
    : "Это факты о работе. Права, статусы и порядок этапов определяет сервер.";
  return [header, ...rows.map((r) => `— ${r}`), footer].join("\n").slice(0, BLOCK_MAX);
}

/** DTO для маршрутов и будущего экрана слота. */
export function slotSnapshotDto(subtaskId: string): Record<string, unknown> | null {
  const slot = slotRow(subtaskId);
  if (!slot) return null;
  const latest = latestSlotSnapshot(subtaskId);
  // Показывает ли последний снимок работу более ранней попытки (новая ещё
  // ничего не записала). Показывать полезно, но помечать обязательно: иначе
  // владелец и роль прочтут старое как «это текущая работа».
  const fromEarlierAttempt = Boolean(latest?.attempt_id) && latest!.attempt_id !== slot.current_attempt_id;
  const history = slotSnapshotHistory(subtaskId).map((s) => ({
    id: s.id,
    reason: s.reason,
    is_complete: !!s.is_complete,
    done_summary: s.done_summary,
    left_summary: s.left_summary,
    blocker: s.blocker,
    next_step: s.next_step,
    last_action: s.last_action,
    artifacts: parseArtifacts(s.artifacts_json),
    attempt_id: s.attempt_id,
    created_at: s.created_at,
  }));
  return {
    subtask_id: subtaskId,
    task_id: slot.task_id,
    title: slot.title,
    plan_node_key: slot.plan_node_key,
    role_key: roleKeyOf(slot.agent_id),
    role_title: roleKeyOf(slot.agent_id) ? roleTitle(roleKeyOf(slot.agent_id) as string) : null,
    work: slotWorkState(subtaskId),
    latest_from_earlier_attempt: fromEarlierAttempt,
    latest: latest
      ? {
          id: latest.id,
          reason: latest.reason,
          is_complete: !!latest.is_complete,
          done_summary: latest.done_summary,
          left_summary: latest.left_summary,
          blocker: latest.blocker,
          next_step: latest.next_step,
          last_action: latest.last_action,
          artifacts: parseArtifacts(latest.artifacts_json),
          attempt_id: latest.attempt_id,
          created_at: latest.created_at,
        }
      : null,
    history,
  };
}