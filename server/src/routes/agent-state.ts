// POST /api/tasks/:id/claim | /heartbeat | /state — the agent-work protocol
// (see AGENT-PROTOCOL.md). Core rules (transition matrix, lease math, event
// logging) live in ../agentState.ts; this file is just the HTTP surface.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { getTaskForWrite, isOwner as isTrackerOwner } from "../access.js";
import { broadcastToUsers } from "../ws.js";
import { hydrateTask } from "./tasks.js";
import {
  AGENT_RULES,
  AGENT_STATES,
  AgentState,
  canTransition,
  commentRequiredFor,
  isStale,
  leaseExpiresAt,
  logEvent,
} from "../agentState.js";

const uid = () => crypto.randomUUID();

export function registerAgentStateRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ═══════ CLAIM ═══════
  // Take the task into work: agent_state -> 'in_progress', heartbeat = now,
  // and become assignee if nobody was assigned yet. Goes through the SAME
  // canTransition matrix as /state (AGENT-PROTOCOL.md, "claim подчиняется
  // той же матрице") — claim is a second door onto some of the matrix's
  // rows, not a bypass of it. In particular it must NOT be able to reach
  // in_progress from `review`: that would let an agent silently take back
  // work it already submitted for the owner's review.
  app.post<{
    Params: { id: string };
    Body: { session_id?: string };
  }>("/api/tasks/:id/claim", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      // Взять задачу в работу может только учётка-агент (type = 'ai').
      // Решение Максима 14.08.2026: сводка на «Обзоре» показывает «В
      // работе N» как работу агентов, и это должно быть правдой по
      // построению, а не по договорённости. Раньше проверки не было —
      // человек мог выставить себе agent_state и попасть в тот же счётчик.
      // Возврат задачи из review в in_progress («вернуть на доработку»)
      // это не затрагивает: он идёт через /state и разрешён именно
      // владельцу (agentState.ts canTransition).
      const caller = db
        .prepare("SELECT type FROM users WHERE id = ?")
        .get(req.userId) as { type?: string } | undefined;
      if (caller?.type !== "ai") {
        return reply.code(403).send({
          error: "взять задачу в работу может только агент",
        });
      }

      if (task.status !== "active") {
        return reply.code(400).send({
          error: "задачу можно взять в работу, только пока она активна",
        });
      }

      const from = (task.agent_state ?? null) as AgentState | null;
      const leaseAlive =
        from === "in_progress" && !isStale(task.agent_heartbeat_at);

      // A live lease held by someone else is a "try later" situation, not a
      // permanently forbidden move — 409, checked before the matrix so it
      // doesn't get flattened into a generic "invalid transition" 400.
      if (leaseAlive && task.assignee_id && task.assignee_id !== req.userId) {
        return reply.code(409).send({
          error: "задачу уже держит другой исполнитель — аренда ещё не истекла",
        });
      }

      // Before assignment, "the executor" is whoever is claiming — matches
      // claim's own job of setting assignee_id when it was empty. Once
      // assigned, only that assignee counts (this matters for the
      // in_progress -> in_progress self-reclaim row: someone else must not
      // be able to just walk in on a stale lease, even the task's own
      // creator — AGENT-PROTOCOL.md is explicit that only the owner
      // *explicitly releasing it via /state* reopens it to a new claimant).
      const who = {
        // Владелец трекера (role='owner') — владелец ЛЮБОЙ задачи, даже
        // заведённой агентом. Раньше здесь стояло только сравнение с
        // creator_id, и владелец не мог ни принять, ни вернуть задачу,
        // которую агент создал сам: сервер отвечал отказом, а интерфейс
        // показывал «Не удалось изменить состояние задачи» (поймано
        // владельцем 19.08.2026 на кнопке «Вернуть в ожидание»). То же
        // правило по роли уже жило в access.ts — сюда его не донесли.
        isOwner: isTrackerOwner(req.userId) || task.creator_id === req.userId,
        isExecutor:
          task.assignee_id === req.userId || task.assignee_id === null,
        leaseExpired:
          from === "in_progress" && isStale(task.agent_heartbeat_at),
      };

      if (!canTransition(from, "in_progress", who, "claim")) {
        if (from === "review") {
          return reply.code(400).send({
            error:
              "задача на проверке у владельца, вернуть её в работу может только он",
          });
        }
        return reply.code(400).send({ error: "invalid transition" });
      }

      const claimTxn = db.transaction(() => {
        // Перезахват после истёкшей аренды (from === 'in_progress', to ===
        // 'in_progress') — тот самый момент, когда система «замечает»
        // молчание агента: до сих пор это было только вычисляемым полем
        // agent_stale, нигде не оставлявшим следа. Пишем один раз именно
        // здесь — не по крону (AGENT-PROTOCOL.md: «никакого фонового
        // процесса»), а на первом же действии, которое трогает эту аренду.
        // Дважды на один и тот же период не запишется: следующий раз
        // agent_heartbeat_at уже будет свежим (обновлён строкой ниже), и
        // isStale(task.agent_heartbeat_at) — значение ДО этого UPDATE —
        // войдёт в лог ровно один раз за цикл claim → ... → claim.
        //
        // actor_id = NULL — это не действие req.userId, а факт, который
        // вскрыл его вызов: молчание случилось раньше и независимо от
        // текущего запроса (см. комментарий у CREATE TABLE task_events).
        if (who.leaseExpired) {
          logEvent({
            taskId: task.id,
            actorId: null,
            kind: "lease_expired",
            field: "agent_heartbeat_at",
            fromValue: task.agent_heartbeat_at ?? null,
          });
        }

        // session_id — необязательный: приходит от MCP-клиента как
        // CLAUDE_CODE_SESSION_ID процесса, который реально claim'ит. Пишем
        // его молча (не в лог) — это техническая метка «чей физически этот
        // claim», не событие, которое имеет смысл владельцу. Несколько
        // параллельных сессий делят один и тот же учётный аккаунт-агента
        // (assignee_id/Claude_Bot), поэтому это единственное поле, по
        // которому свой Stop-хук отличает «мою» незавершённую работу от
        // чужой под тем же ботом (миграция 004_agent_session_id).
        db.prepare(
          `UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now'),
             assignee_id = COALESCE(assignee_id, ?), agent_session_id = ? WHERE id = ?`,
        ).run(req.userId, sessionOf(req), task.id);

        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "claimed",
        });
        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "state_changed",
          field: "agent_state",
          fromValue: task.agent_state ?? null,
          toValue: "in_progress",
        });
      });
      claimTxn();

      const updated = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as any;
      const hydrated = hydrateTask(updated);
      // Same shape as task:created/task:updated (hydrateTask, with labels +
      // subtasks) — a client that merges task:state through the same store
      // path as the other task events must not lose labels/subtasks.
      broadcastToUsers([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });
      // Вместе с задачей агент получает ПРАВИЛА — сразу, в момент взятия.
      // Максим 20.08.2026: «чтобы любой агент, ты или не ты, когда
      // приступает к работе, на него сразу же всё это навешивалось, и он
      // строго соблюдал». Памятка в чьём-то CLAUDE.md чужому агенту не
      // указ, а этот ответ получают все одинаково.
      return { task: hydrated, rules: AGENT_RULES };
    },
  });

  // ═══════ HEARTBEAT ═══════
  // Renew the lease. Only the executor (assignee), only while in_progress.
  // Deliberately touches ONLY agent_heartbeat_at — never updated_at (a ping
  // every few minutes must not look like an edit to the task) and never
  // writes to task_events (that would flood the journal).
  app.post<{ Params: { id: string } }>("/api/tasks/:id/heartbeat", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      if (
        task.assignee_id !== req.userId ||
        task.agent_state !== "in_progress"
      ) {
        return reply.code(400).send({
          error:
            "продлить аренду может только исполнитель задачи, взятой в работу",
        });
      }

      db.prepare(
        "UPDATE tasks SET agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(task.id);

      // Вместе с задачей продлевается и ШАГ, который этот же агент отметил
      // как «в работе».
      //
      // ⚠️ Прецедент 21.08.2026: у шага своя аренда, и она протухала сама
      // по себе — агент отмечал начало шага, уходил на полчаса писать код
      // и молчал. Значок «в работе» у шага гас через пять минут, хотя
      // работа шла: владелец видел статичный пунктирный кружок и спросил
      // «почему перестало крутиться». Сигнал у нас один — живой ход агента,
      // и делить его между задачей и шагом незачем: если аренда задачи
      // продлена, то шаг, взятый тем же агентом, работает тоже.
      //
      // Условие по agent_id обязательно: на одной задаче шаги могут быть
      // взяты разными агентами, и продлевать чужой шаг мы не вправе.
      db.prepare(
        `UPDATE subtasks SET agent_heartbeat_at = datetime('now')
          WHERE task_id = ? AND agent_state = 'in_progress'
            AND (agent_id IS NULL OR agent_id = ?)`,
      ).run(task.id, req.userId);

      const updated = db
        .prepare("SELECT agent_heartbeat_at FROM tasks WHERE id = ?")
        .get(task.id) as any;
      return { lease_expires_at: leaseExpiresAt(updated.agent_heartbeat_at) };
    },
  });

  // ═══════ STATE ═══════
  // Explicit transition, with a mandatory comment for blocked/review. One
  // transaction covers the comment + agent_state + journal entry, so a task
  // can never end up in blocked/review without its explanation attached.
  app.post<{
    Params: { id: string };
    Body: { state: AgentState | null; comment?: string; session_id?: string };
  }>("/api/tasks/:id/state", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const { state } = req.body || {};
      if (state !== null && !AGENT_STATES.includes(state)) {
        return reply.code(400).send({
          error:
            "state должно быть одним из: in_progress, blocked, review, null",
        });
      }

      const from = (task.agent_state ?? null) as AgentState | null;

      // Задачу нельзя сдать на приёмку, пока её шаги висят несделанными.
      // Правило владельца (20.08.2026): работа идёт СНИЗУ ВВЕРХ — каждый
      // шаг сдаётся отдельно (work: review + result), и только когда все
      // они закрыты им самим или ждут его приёмки, задача целиком уходит
      // в review. Иначе «сдал задачу» ничего не значит: шаги остаются
      // пустыми, и владелец не понимает, что именно сделано.
      //
      // Проверка живёт на СЕРВЕРЕ, а не в хуках клиента, потому что
      // агентов несколько (Claude, Hermes, DeepSeek, любые субагенты) и
      // чужие хуки нам не подчиняются.
      if (state === "review") {
        const caller = db
          .prepare("SELECT type FROM users WHERE id = ?")
          .get(req.userId) as { type?: string } | undefined;
        if (caller?.type === "ai") {
          const pending = db
            .prepare(
              `SELECT title FROM subtasks
                WHERE task_id = ?
                  AND done = 0
                  AND (agent_state IS NULL OR agent_state != 'review')
                ORDER BY position`,
            )
            .all(req.params.id) as { title: string }[];
          if (pending.length > 0) {
            return reply.code(400).send({
              error:
                "сначала сдай шаги: " +
                pending.map((x) => `«${x.title}»`).join(", ") +
                ". Каждый — POST /api/subtasks/:id/work {state:'review', result:'что вышло'}",
            });
          }
        }
      }

      const comment =
        typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
      // Whether a comment is mandatory depends on the (from, to) pair, not
      // just `state` — see commentRequiredFor: review -> in_progress (owner
      // sending work back) needs one just as much as blocked/review do.
      if (commentRequiredFor(from, state) && !comment) {
        let error: string;
        if (state === "blocked") {
          error =
            "нужен комментарий: что мешает и какие действия ждёте от владельца";
        } else if (state === "review") {
          error = "нужен комментарий: что сделано";
        } else {
          // from === "review" && state === "in_progress"
          error = "нужен комментарий: что не так и что нужно доработать";
        }
        return reply.code(400).send({ error });
      }

      const who = {
        // Владелец трекера (role='owner') — владелец ЛЮБОЙ задачи, даже
        // заведённой агентом. Раньше здесь стояло только сравнение с
        // creator_id, и владелец не мог ни принять, ни вернуть задачу,
        // которую агент создал сам: сервер отвечал отказом, а интерфейс
        // показывал «Не удалось изменить состояние задачи» (поймано
        // владельцем 19.08.2026 на кнопке «Вернуть в ожидание»). То же
        // правило по роли уже жило в access.ts — сюда его не донесли.
        isOwner: isTrackerOwner(req.userId) || task.creator_id === req.userId,
        isExecutor: task.assignee_id === req.userId,
      };
      if (!canTransition(from, state, who, "state")) {
        return reply.code(400).send({ error: "invalid transition" });
      }

      // Тот же случай, что self-reclaim в claim() — система замечает
      // истёкшую аренду в момент, когда что-то СДЕЛАНО с задачей, а не по
      // таймеру. Здесь это происходит не только при перезахвате (тот идёт
      // через claim, не сюда), а при любом уходе ИЗ in_progress с
      // просроченным сигналом: агент вернулся и сразу сдал на review/ушёл
      // в blocked, или владелец снял его явным state:null. isStale
      // считается ДО обновления heartbeat ниже, поэтому один и тот же
      // просроченный период не залогируется дважды.
      const leaseWasExpired =
        from === "in_progress" && isStale(task.agent_heartbeat_at);

      const stateTxn = db.transaction(() => {
        // actor_id = NULL — тот же довод, что в claim(): это не действие
        // req.userId, а факт, который вскрыл его вызов.
        if (leaseWasExpired) {
          logEvent({
            taskId: task.id,
            actorId: null,
            kind: "lease_expired",
            field: "agent_heartbeat_at",
            fromValue: task.agent_heartbeat_at ?? null,
          });
        }

        if (comment) {
          db.prepare(
            "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
          ).run(uid(), task.id, req.userId, comment);
        }

        // Re-entering in_progress (from blocked, or owner sending it back
        // from review) takes out a fresh lease — "берётся новая аренда".
        //
        // ⚠️ COALESCE, а НЕ голое присваивание. Когда задачу возвращает
        // ВЛАДЕЛЕЦ из браузера, у запроса нет ни заголовка X-Agent-Session,
        // ни session_id в теле — sessionOf() отдаёт null, и прежняя запись
        // затиралась. Связь с сессией агента терялась ровно в тот момент,
        // когда она нужнее всего: будильник переставал понимать, куда
        // возвращать работу, и поднял бы новую сессию с чистого листа.
        //
        // Живой прецедент 21.08.2026: Максим вернул карточку на доработку
        // через трекер, у неё обнулился agent_session_id, и его сообщение
        // просто легло в ленту — «я решил через TaskFlow с тобой
        // прокоммуницировать, и у меня это не получилось».
        //
        // Своя сессия (агент возвращается из blocked) метку передаёт и
        // перезапишет её, как и раньше.
        if (state === "in_progress") {
          db.prepare(
            `UPDATE tasks SET agent_state = ?, agent_heartbeat_at = datetime('now'),
               agent_session_id = COALESCE(?, agent_session_id) WHERE id = ?`,
          ).run(state, sessionOf(req), task.id);
        } else {
          db.prepare("UPDATE tasks SET agent_state = ? WHERE id = ?").run(
            state,
            task.id,
          );
        }

        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "state_changed",
          field: "agent_state",
          fromValue: from,
          toValue: state,
        });
      });
      stateTxn();

      const updated = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as any;
      const hydrated = hydrateTask(updated);

      // Owner attention required — notify + WS, outside the transaction (not
      // journal, not comment/state — just side effects for the live client).
      if ((state === "blocked" || state === "review") && task.creator_id) {
        if (task.creator_id !== req.userId) {
          const notifId = uid();
          const label = state === "blocked" ? "заблокирована" : "на проверке";
          db.prepare(
            "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'agent_state', ?, ?, ?)",
          ).run(
            notifId,
            task.creator_id,
            task.id,
            `Задача «${task.title}» ${label}`,
            req.userId,
          );
          broadcastToUsers([task.creator_id], {
            type: "notification:new",
            notificationId: notifId,
            taskId: task.id,
          });
        }
      }

      broadcastToUsers([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });

      return { task: hydrated };
    },
  });
}
