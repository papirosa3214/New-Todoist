// Core of the agent-work protocol (see AGENT-PROTOCOL.md). Everything about
// "what state can follow what, who's allowed to cause it, and is the lease
// still alive" lives in this one file — routes/agent-state.ts and
// routes/tasks.ts only call into it, they never re-derive the rules.
import crypto from "crypto";
import db from "./db.js";

// Срок аренды: сколько задача считается «в работе» после последнего сигнала
// агента. Было 15 минут, с 14.08.2026 — 5 (решение Максима): пропавшего
// исполнителя надо видеть быстро, а не через четверть часа. Служба-будильник
// шлёт сигнал каждые 90 секунд, то есть даже пара пропущенных подряд не
// сделает работающего агента «пропавшим».
export const LEASE_MINUTES = 5;

export type AgentState = "in_progress" | "blocked" | "review";
export const AGENT_STATES: AgentState[] = ["in_progress", "blocked", "review"];

const uid = () => crypto.randomUUID();

/**
 * `tasks.agent_heartbeat_at` (like every other timestamp column in this
 * schema — created_at, updated_at, completed_at) is written with SQLite's
 * `datetime('now')`, which is UTC but formatted as "YYYY-MM-DD HH:MM:SS" —
 * no "Z", no "T". `new Date(that string)` parses it as LOCAL time in
 * Node, which silently shifts every heartbeat by the server's UTC offset.
 * On a UTC+3 box a fresh heartbeat would look 3 hours old and
 * `agent_stale` would be permanently (wrongly) true. Normalize to a
 * real ISO-8601 UTC string before handing it to `Date`.
 */
function parseSqliteUtc(value: string): Date {
  return new Date(value.replace(" ", "T") + "Z");
}

/** Lease expiry = last heartbeat + LEASE_MINUTES. */
export function leaseExpiresAt(
  heartbeatAt: string | null | undefined,
): Date | null {
  if (!heartbeatAt) return null;
  return new Date(
    parseSqliteUtc(heartbeatAt).getTime() + LEASE_MINUTES * 60_000,
  );
}

/** True if the lease taken out at `heartbeatAt` has expired ("агент пропал"). */
export function isStale(heartbeatAt: string | null | undefined): boolean {
  const expires = leaseExpiresAt(heartbeatAt);
  if (!expires) return false;
  return expires.getTime() <= Date.now();
}

type Caller = {
  isOwner: boolean;
  isExecutor: boolean;
  // Only meaningful for the from==='in_progress' rows: whether the lease
  // has expired. Drives the in_progress -> in_progress self-reclaim row —
  // see canTransition below.
  leaseExpired?: boolean;
};

/** Which endpoint is asking. claim() and state() share most of the matrix
 * but diverge on two rows — see canTransition. */
export type TransitionVia = "claim" | "state";

/**
 * Transition matrix (AGENT-PROTOCOL.md, "Матрица переходов"). `completed`
 * is deliberately NOT modeled here — that leg of the state machine lives in
 * `status` (PATCH /api/tasks/:id), not `agent_state`; see
 * AGENT-PROTOCOL.md "Решение о хранении". This function covers the four
 * `agent_state` values both POST /api/tasks/:id/state and
 * POST /api/tasks/:id/claim are allowed to reach: null | in_progress |
 * blocked | review. **claim() must call this too** — it is not a
 * shortcut around the matrix, just a second door onto some of the same
 * rows (AGENT-PROTOCOL.md, "claim подчиняется той же матрице").
 *
 * A caller can hold both roles at once (creator claims their own task) —
 * so `who` is a set of held roles, not a single exclusive one, and a
 * transition is allowed if ANY held role permits it.
 *
 * Two rows are endpoint-specific:
 *  - `in_progress -> in_progress` (self-reclaim of an expired lease) only
 *    claim() can take — state() has no reason to request a no-op transition.
 *  - `review -> in_progress` only state() can take, and only the owner,
 *    with a mandatory comment (see commentRequiredFor). claim() reaching
 *    into `review` is exactly the hole this endpoint-gating closes: an
 *    agent that submitted its own work for review must not be able to
 *    silently take it back and skip the owner's acceptance.
 */
export function canTransition(
  from: AgentState | null,
  to: AgentState | null,
  who: Caller,
  via: TransitionVia,
): boolean {
  if (from === null && to === "in_progress") return who.isExecutor;
  if (from === "blocked" && to === "in_progress") return who.isExecutor;
  if (from === "in_progress" && to === "review") return who.isExecutor;
  if (from === "in_progress" && to === "blocked") return who.isExecutor;
  if (from === "in_progress" && to === "in_progress") {
    return via === "claim" && who.isExecutor && !!who.leaseExpired;
  }
  if (from === "review" && to === "in_progress") {
    return via === "state" && who.isOwner;
  }
  // "любое → NULL, владелец, снять с агента"
  if (to === null) return who.isOwner;
  return false;
}

/**
 * Comment is mandatory not just by destination state but by the (from, to)
 * pair (AGENT-PROTOCOL.md, "Что нельзя сделать молча" + the `review ->
 * in_progress` row's "комментарий обязателен"): blocked/review always need
 * one, and so does an owner sending work from `review` back to
 * `in_progress` — the agent has to be told what's wrong, or it just
 * re-reads "in_progress" with no idea what to fix.
 */
export function commentRequiredFor(
  from: AgentState | null,
  to: AgentState | null,
): boolean {
  if (to === "blocked" || to === "review") return true;
  if (from === "review" && to === "in_progress") return true;
  return false;
}

/**
 * ПРАВИЛА РАБОТЫ НАД ШАГОМ — здесь, а не в хуках клиента.
 *
 * Максим 20.08.2026: «все эти правила должен контролировать сторонний
 * скрипт, который будет контролировать вообще всех агентов, не только
 * тебя… как политика доступов работает с паролями: хочешь залезть — оп,
 * тебе нельзя». Значит правило = отказ сервера, одинаковый для Claude,
 * Hermes, DeepSeek и любого их субагента, а не памятка в моём CLAUDE.md,
 * который чужому агенту не указ.
 *
 * И следом, о самих статусах: «приступить к работе, не проставив статус
 * задачи, статус подзадачи — нельзя. Статус подзадачи всегда динамический:
 * работаешь над ней — должен быть „в процессе“; заблокировал по какой-то
 * причине — ставишь соответствующий; всё выполнил — на ревью, и дальше
 * продолжаешь следующие шаги».
 *
 * Отсюда три отказа (плюс уже существовавший «result обязателен»):
 *  1. шаг нельзя взять в работу, пока не взята сама задача — иначе в
 *     карточке горит шаг, а сверху «никто не работает»;
 *  2. шаг нельзя сдать на проверку, не побывав в работе — ровно так
 *     статус остаётся мёртвым: агент делает молча и в конце проставляет
 *     «review», а владелец так и не видел, что именно шло;
 *  3. заблокированный шаг обязан объяснить причину — тот же принцип «что
 *     нельзя сделать молча», что у задачи (AGENT-PROTOCOL.md).
 *
 * Проверки 1 и 2 адресованы агентам (`isAi`): владелец правит шаги руками
 * в своём же интерфейсе, и подводить его под 400 нельзя. Требование
 * причины — общее: без текста шаг нечитаем кем угодно он ни был выставлен.
 *
 * ⚠️ Чего сервер знать НЕ может: он не видит, что агент «начал работать».
 * Правило «сначала статус, потом работа» держится косвенно — недостижимым
 * review без in_progress, — а дрейф ловит сторож (scripts/agent_watch.py).
 */
export type SubtaskWorkContext = {
  /** Текущее состояние шага. */
  from: AgentState | null;
  /** Куда просят перевести. undefined — тело без state, продление аренды. */
  to: AgentState | null | undefined;
  /** Вызывающий — учётка агента (users.type = 'ai'). */
  isAi: boolean;
  /** Состояние самой задачи на момент вызова. */
  taskAgentState: AgentState | null;
  /** Есть ли текст: в теле запроса или уже сохранённый у шага. */
  hasResult: boolean;
};

export function subtaskWorkRefusal(
  ctx: SubtaskWorkContext,
): { code: number; error: string } | null {
  const { from, to, isAi, taskAgentState, hasResult } = ctx;

  if (to === "in_progress" && isAi && taskAgentState !== "in_progress") {
    return {
      code: 400,
      error:
        "сначала возьмите саму задачу в работу: POST /api/tasks/<id>/claim — " +
        "шаг не может идти в работу под задачей, которую никто не взял",
    };
  }

  if (to === "review") {
    if (isAi && from !== "in_progress" && from !== "blocked") {
      return {
        code: 400,
        error:
          "шаг не был в работе: сначала POST /api/subtasks/<id>/work " +
          '{"state":"in_progress"}, потом сдавайте — владелец должен видеть, ' +
          "какой шаг идёт, а не только итог",
      };
    }
    if (!hasResult) {
      return {
        code: 400,
        error: "result обязателен: что сделано в этом шаге",
      };
    }
  }

  if (to === "blocked" && !hasResult) {
    return {
      code: 400,
      error:
        "result обязателен: что именно мешает и каких действий вы ждёте от владельца",
    };
  }

  return null;
}

export function logEvent(params: {
  taskId: string;
  actorId: string | null;
  kind: string;
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
}) {
  db.prepare(
    `INSERT INTO task_events (id, task_id, actor_id, kind, field, from_value, to_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid(),
    params.taskId,
    params.actorId,
    params.kind,
    params.field ?? null,
    params.fromValue ?? null,
    params.toValue ?? null,
  );
}
