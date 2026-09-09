// POST /api/tasks/:id/claim | /heartbeat | /state — the agent-work protocol
// (see AGENT-PROTOCOL.md). Core rules (transition matrix, lease math, event
// logging) live in ../agentState.ts; this file is just the HTTP surface.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import {
  getTaskForReview,
  getTaskForWrite,
  isOwner as isTrackerOwner,
  isReviewer as isTaskReviewer,
} from "../access.js";
import { broadcastToUsers } from "../ws.js";
import { hydrateTask, getTaskRow, withAgentStale } from "./tasks.js";
import {
  AGENT_RULES,
  AGENT_STATES,
  AgentState,
  canTransition,
  commentRequiredFor,
  isStale,
  leaseExpiresAt,
  logEvent,
  registryRecord,
  releaseSubtaskWork,
} from "../agentState.js";

const uid = () => crypto.randomUUID();

// О ЧУЖОЙ сданной задаче предупреждаем один раз на сессию: свою работу
// исполнитель доделает сам, а чужую — нет, и держать ход закрытым намертво
// незачем. Раньше эта отметка лежала файлом рядом с хуком, поэтому у каждой
// сессии был свой счёт и своё «уже говорили». Здесь она общая.
//
// Живёт в памяти процесса намеренно: отметка нужна на время жизни сессии,
// которая всегда короче жизни сервера, а таблица ради неё — лишняя миграция
// и лишний мусор в базе.
const warnedBySession = new Map<string, Set<string>>();

function alreadyWarned(session: string | null, taskId: string): boolean {
  if (!session) return false;
  return warnedBySession.get(session)?.has(taskId) ?? false;
}

function rememberWarned(session: string | null, taskIds: string[]): void {
  if (!session || !taskIds.length) return;
  let set = warnedBySession.get(session);
  if (!set) {
    set = new Set();
    warnedBySession.set(session, set);
  }
  for (const id of taskIds) set.add(id);
}

export function registerAgentStateRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // ═══════ ПРАВИЛА ═══════
  // GET /api/agent/rules — те же AGENT_RULES, что приходят в ответе на claim
  // и на взятие шага, но их можно СПРОСИТЬ, не занимая задачу.
  //
  // Понадобилось для Control Center: он показывает правила исполнителю на
  // экране задач. Показывать их из своей копии он не может по решению
  // 20.08.2026 — правила живут на сервере трекера, чтобы действовать на
  // любого агента, а не только на прочитавшего чей-то CLAUDE.md. Значит
  // единственный честный способ их показать — спросить у нас.
  app.get("/api/agent/rules", { preHandler: authPre }, async () => ({
    rules: AGENT_RULES,
  }));

  // ═══════ МОЖНО ЛИ ЗАКОНЧИТЬ ХОД ═══════
  // GET /api/agent/can-stop — «у меня остались незакрытые шаги?»
  //
  // Максим 26.08.2026: «этот твой жёсткий гейт… ты можешь его перевести на
  // систему? На сервер, чтобы это сервер делал, а не твой хук». Правила
  // жили в Stop-хуке Claude Code — 295 строк, действовавших на одного
  // исполнителя и правившихся отдельно от сервера. Дважды за неделю их
  // приходилось менять (что считать закрытым шагом, как быть с чужой
  // сессией), и каждый раз правка доставалась только тому агенту, у кого
  // этот хук стоит.
  //
  // Само событие «ход заканчивается» видно только внутри клиента, поэтому
  // хук остаётся — но становится курьером: спросил, показал ответ. Решение
  // и формулировка причины теперь здесь и действуют на любого агента.
  app.get("/api/agent/can-stop", { preHandler: authPre }, async (req: any) => {
    const mySession = sessionOf(req);
    const tasks = db
      .prepare(
        `SELECT id, title, agent_state, agent_session_id
           FROM tasks
          WHERE assignee_id = ? AND status = 'active'`,
      )
      .all(req.userId) as Array<{
      id: string;
      title: string;
      agent_state: string | null;
      agent_session_id: string | null;
    }>;

    const stepsOf = db.prepare(
      `SELECT done, agent_state, agent_heartbeat_at FROM subtasks WHERE task_id = ?`,
    );
    const unfinished: Array<{
      id: string;
      title: string;
      closed: number;
      total: number;
      state: string | null;
      foreign: boolean;
    }> = [];

    // Координационная карточка оркестратора собственных шагов не имеет:
    // работа разложена по ДОЧЕРНИМ ЗАДАЧАМ, а формальной связи с ними в
    // базе нет — оркестратор пишет её строкой «Часть координационной
    // задачи #id» в описание каждого куска (build_orchestrator_prompt).
    // По этой же нити его теперь будит и будильник.
    //
    // Зачем ручке про них знать (28.08.2026, владелец: «как он мог
    // отключаться, если он не выполнил задачу?»): гейт пропускал такую
    // карточку насквозь по `!steps.length`, и оркестратор заканчивал ход,
    // оставив сданную работу непринятой. Держим его ТОЛЬКО когда ребёнок
    // уже сдался или упёрся: пока дети работают, уходить ему можно и нужно
    // — заход стоит денег, а смотреть не на что.
    const childrenWaiting = db.prepare(
      `SELECT id, title, agent_state FROM tasks
        WHERE status = 'active' AND creator_id = ? AND id <> ?
          AND agent_state IN ('review', 'blocked')
          AND description LIKE '%' || ? || '%'`,
    );
    const awaiting: Array<{
      id: string;
      title: string;
      children: Array<{ id: string; title: string; agent_state: string }>;
    }> = [];

    for (const t of tasks) {
      const steps = stepsOf.all(t.id) as Array<{
        done: number;
        agent_state: string | null;
        agent_heartbeat_at: string | null;
      }>;
      // Состояние задачи ВЫЧИСЛЯЕТСЯ из шагов, а не лежит в её строке:
      // у задачи, которую ведут пошагово, собственный agent_state годами
      // остаётся NULL (см. withAgentStale в routes/tasks.ts). Первая
      // редакция этой ручки читала сырое поле и потому тянула в выдачу
      // задачу, давно помеченную blocked через шаг.
      const state = withAgentStale(t, steps).agent_state as string | null;

      // Упёрся и сказал об этом — незакрытые шаги там законны.
      if (state === "blocked") continue;

      // Задачу, которую прямо сейчас ведёт другой процесс под тем же ботом,
      // доделать нельзя: не зная, что там сделано, честного result не
      // напишешь. Но СДАННУЮ работу проверяем всегда, чья бы сессия ни
      // стояла — иначе дыра: 18.08.2026 выяснилось, что MCP-процесс может
      // писать ИД уже завершённой сессии, совпадения не случается никогда
      // и гейт молча пропускает всё подряд.
      const foreign = Boolean(
        t.agent_session_id && mySession && t.agent_session_id !== mySession,
      );
      if (foreign && state !== "review") continue;
      if (foreign && alreadyWarned(mySession, t.id)) continue;

      const kids = childrenWaiting.all(req.userId, t.id, t.id) as Array<{
        id: string;
        title: string;
        agent_state: string;
      }>;
      if (kids.length) {
        awaiting.push({ id: t.id, title: t.title, children: kids });
      }

      if (!steps.length) continue;
      // Шаг закрыт: сделан ЛИБО сдан на проверку. «Сделан» с 20.08.2026
      // доступен и агенту — обязательная приёмка владельцем отменена.
      const closed = steps.filter(
        (s) => Boolean(s.done) || s.agent_state === "review",
      ).length;
      if (closed < steps.length) {
        unfinished.push({
          id: t.id,
          title: t.title,
          closed,
          total: steps.length,
          state,
          foreign,
        });
      }
    }

    if (!unfinished.length && !awaiting.length) return { can_stop: true, tasks: [] };

    rememberWarned(
      mySession,
      unfinished.filter((u) => u.foreign).map((u) => u.id),
    );

    const lines: string[] = ["⛔ ЖЁСТКИЙ ГЕЙТ: ход пытается закончиться, а работа не отпущена."];

    if (awaiting.length) {
      lines.push(
        "",
        "Тебе сдали работу и ждут твоего слова — уйти сейчас значит бросить её:",
      );
      for (const a of awaiting) {
        lines.push(`  • «${a.title}» (${a.id.slice(0, 8)}…):`);
        for (const k of a.children) {
          const what =
            k.agent_state === "review" ? "сдал на проверку" : "упёрся и ждёт решения";
          lines.push(`      — «${k.title}» (${k.id.slice(0, 8)}…) ${what}`);
        }
      }
      lines.push(
        "Прими сделанное или верни на доработку (taskflow_state с comment). " +
          "Дети ещё в работе — тогда уходить можно, гейт про них не спрашивает.",
      );
    }

    if (unfinished.length) {
      lines.push("", "Задача с незакрытыми шагами, которую ты ведёшь:");
    }
    let sold = false;
    for (const u of unfinished) {
      let mark = u.state === "review" ? " — задача уже сдана в review!" : "";
      if (u.foreign) mark += " (сдала другая сессия — предупреждаю один раз)";
      sold = sold || (u.state === "review" && !u.foreign);
      lines.push(
        `  • «${u.title}» (${u.id.slice(0, 8)}…) — закрыто ${u.closed}/${u.total} шагов${mark}`,
      );
    }
    if (sold) {
      lines.push(
        "Сдана задача, а шаги при ней не сданы — так владелец не видит, " +
          "что именно сделано по каждому. Пройди шаги " +
          "(taskflow_subtask_work со state='review' и честным result).",
      );
    }
    if (unfinished.length) {
      lines.push(
        "Либо продолжи следующий шаг (taskflow_subtask_work), либо закрой " +
          "все шаги и сдай задачу (taskflow_state), либо переведи её в blocked " +
          "с честной причиной — тогда ход закроется.",
      );
    }

    return {
      can_stop: false,
      reason: lines.join("\n"),
      tasks: unfinished,
      coordination: awaiting,
    };
  });

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
      const task = getTaskForWrite(req.params.id, req.userId) ??
        getTaskForReview(req.params.id, req.userId);
      if (!task) {
        // Задача может быть чужой, а не отсутствующей, и для агента это
        // совсем разные новости. Голое «не найдено» сбивает с толку:
        // 22.08.2026 Гермес получил его на не назначенную ему карточку и
        // решил, что дело в пропавшем проекте — пошёл искать несуществующую
        // причину вместо того, чтобы попросить назначить задачу на себя.
        //
        // Содержимое чужой задачи при этом не раскрываем — только сам факт
        // и имя исполнителя: этого хватает, чтобы понять, что делать
        // дальше, и не хватает, чтобы прочитать чужую работу.
        const exists = db
          .prepare(
            `SELECT t.assignee_id, u.name AS assignee_name
               FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
              WHERE t.id = ?`,
          )
          .get(req.params.id) as
          { assignee_id?: string; assignee_name?: string } | undefined;
        if (exists) {
          const who = exists.assignee_name
            ? `назначена на «${exists.assignee_name}»`
            : "не назначена ни на кого";
          return reply.code(403).send({
            error:
              `эта задача ${who} — взять её в работу может только её ` +
              `исполнитель. Попроси владельца назначить задачу на тебя.`,
          });
        }
        return reply.code(404).send({ error: "Not found" });
      }

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

      const updated = getTaskRow(task.id);
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
      const task = getTaskForWrite(req.params.id, req.userId) ??
        getTaskForReview(req.params.id, req.userId);
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
      const task = getTaskForWrite(req.params.id, req.userId) ??
        getTaskForReview(req.params.id, req.userId);
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
        isReviewer: isTaskReviewer(req.userId),
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

        // Возврат из review в in_progress — карточка меняется: поднимаем
        // current_revision, чтобы устаревшие inbox-события (записанные до
        // возврата) тихо отбрасывались триггером перед claim (5f292e87), и
        // фиксируем событие в реестре диспетчеризации (режим наблюдения).
        if (from === "review" && state === "in_progress") {
          db.prepare(
            "UPDATE tasks SET current_revision = current_revision + 1 WHERE id = ?",
          ).run(task.id);
          // Возврат из review — тоже доставка: кладём поручение в inbox
          // исполнителю (Reviewer 5f292e87: review→in_progress не создаёт
          // inbox). chat_message_id — синтетический (это не сообщение в чат,
          // а сигнал возврата), поэтому для дедупа свой уникальный ключ.
          const returnInboxId = uid();
          db.prepare(
            `INSERT INTO agent_inbox
               (id, chat_message_id, to_user_id, body_text, task_id,
                task_version, kind, event_type, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'text', 'review_return', 'sent', datetime('now'))`,
          ).run(
            returnInboxId,
            `rvr-${uid()}`,
            task.assignee_id,
            comment || "задача возвращена на доработку",
            task.id,
            (db.prepare("SELECT current_revision FROM tasks WHERE id=?").get(task.id) as any)?.current_revision ?? null,
          );
          registryRecord({
            source: "review_return",
            trigger: "POST /api/tasks/:id/state",
            toUserId: task.assignee_id,
            data: { task_id: task.id, actor_id: req.userId, inbox_id: returnInboxId },
            result: "review→in_progress",
          });
        }

        // «Снять с агента» снимает работу и с ШАГОВ — иначе задача тут же
        // перечитается занятой: её состояние могло приходить не из своей
        // колонки, а роллапом с незакрытого шага (см. releaseSubtaskWork и
        // withAgentStale в routes/tasks.ts). Именно из-за этого владелец
        // 24.08.2026 не мог расклинить карточку с пропавшим агентом.
        if (state === null) {
          releaseSubtaskWork(task.id);
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

      const updated = getTaskRow(task.id);
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

      // Владелец вернул задачу из review в работу — единственный путь,
      // отправляющий agent_state и комментарий ОДНИМ атомарным запросом
      // (см. AGENT-PROTOCOL.md, строка «review → in_progress»). У всех
      // остальных owner-переходов с заданием (ответ на blocked, снятие
      // с агента) комментарий идёт ВТОРЫМ отдельным POST на /comments,
      // и именно ТОТ маршрут будит будильник (taskflow-trigger слушает
      // строго notification:new, см. trigger.py::_on_message). У этой
      // атомарной ветки такого второго запроса нет и никогда не было —
      // будильник не просыпался ни разу, задача просто зависала «в работе»
      // без реального захода агента. Найдено 27.08.2026 при разборе
      // f381c5a1 (карточка про «баг сохранения подзадачи»): само действие
      // всегда отрабатывало 200 и без него, но внешний агент об этом
      // никогда не узнавал.
      if (
        from === "review" &&
        state === "in_progress" &&
        comment &&
        task.assignee_id &&
        task.assignee_id !== req.userId
      ) {
        const actor = db
          .prepare("SELECT name FROM users WHERE id = ?")
          .get(req.userId) as { name?: string } | undefined;
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'commented', ?, ?, ?)",
        ).run(
          notifId,
          task.assignee_id,
          task.id,
          `${actor?.name || "Кто-то"} прокомментировал: ${task.title}`,
          req.userId,
        );
        broadcastToUsers([task.assignee_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: task.id,
        });
      }

      broadcastToUsers([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });

      return { task: hydrated };
    },
  });
}
