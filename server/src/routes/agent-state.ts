import { effectiveRules } from "../lib/roleContextResolver.js";
// POST /api/tasks/:id/claim | /heartbeat | /state — the agent-work protocol
// (see AGENT-PROTOCOL.md). Core rules (transition matrix, lease math, event
// logging) live in ../agentState.ts; this file is just the HTTP surface.
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { reviewerFirstEnabled } from "../reviewerPolicy.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import {
  getTaskForRead,
  getTaskForReview,
  getTaskForWrite,
  isOwner as isTrackerOwner,
  isReviewer as isTaskReviewer,
} from "../access.js";
import { unmetDependencyIds } from "../enricher.js";
import { isServiceUser } from "../serviceUser.js";
import { broadcastToUsers, broadcastTaskEvent } from "../ws.js";
import { readAttemptId, attemptMismatchReason } from "../lib/attemptCheck.js";
import { nextAttemptTemplate as computeNextAttemptTemplate } from "../lib/attemptLadder.js";
import {
  nextModelForFailure,
  markProviderLimited,
  ladderEntryForModel,
} from "../lib/modelLadder.js";
import {
  currentResultVersion,
  ensureResultVersionForReview,
  hasApprovedCurrentVersion,
} from "../resultVersions.js";
import {
  isStopReasonCode,
  stopReasonError,
  stopReasonPolicy,
} from "../stopReasons.js";
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
import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";
import { bumpContextVersion } from "../runtime/taskContextVersion.js";

const uid = () => crypto.randomUUID();

/**
 * Сервисные учётки, которым разрешено ставить state='blocked' на ЛЮБУЮ
 * задачу через этот endpoint — для фиксации технических падений
 * claim/launch_agent из trigger.py (см. taskflow-pipeline-head-plan.md,
 * шаг 2). Ролевой ключ мог и быть причиной падения, поэтому блокировку
 * обязательно писать служебной учёткой.
 *
 * Сейчас сюда попадает Pi Agent (TASKFLOW_TOKEN) — он исторически
 * держит служебную дверь. Если владелец заведёт отдельного
 * trigger-service пользователя с ролью orchestrator, его id добавится
 * сюда без правок в триггере.
 */
// Сам список — в serviceUser.ts (01.10.2026): им пользуется и проверка
// пропуска (auth.ts), и внутренний планировщик.

/** Экспорт для других роутов (release и т.д.), чтобы не дублировать. */
export { isServiceUser };

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
  app.get("/api/agent/rules", { preHandler: authPre }, async (req: any) => ({
    rules: effectiveRules((db.prepare("SELECT role_key FROM users WHERE id=?").get(req.userId) as any)?.role_key ?? ""),
  }));

  // ═══════ ЛЕСЕНКА МОДЕЛИ (спек 1.2, 1.2.2) ═══════
  // GET /api/agent/attempt-policies — для trigger.py, чтобы он мог построить
  // лесенку Haiku→Sonnet→Opus при reason_code=insufficient_capability.
  // Триггер дёргает этот endpoint вместо прямого sqlite (как и для правил).
  app.get("/api/agent/attempt-policies", { preHandler: authPre }, async () => {
    const rows = db
      .prepare(
        `SELECT id, reason_code, from_model, to_model, max_attempts,
                cooldown_seconds, created_at
           FROM attempt_policies
          ORDER BY reason_code, max_attempts DESC, from_model`,
      )
      .all();
    return { policies: rows };
  });

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

      // НАЗНАЧЕНА — ЕЩЁ НЕ ЗНАЧИТ «ВЕДЁШЬ» (14.09.2026).
      //
      // Отбор выше берёт все активные задачи с этим assignee_id, а дальше
      // фильтруются только «упёрся» и «чужая сессия». Карточка, которую
      // владелец заранее назначил, но никто не брал, проходила оба фильтра
      // (agent_state NULL, сессии нет) и попадала в выдачу как «задача,
      // которую ты ведёшь». Формулировка гейта переставала быть правдой, а
      // главное — выйти из него было нельзя: claim такую задачу не трогал,
      // а перевести её в blocked сервер не даёт («invalid transition» из
      // состояния «не взята»). Сессия запиралась насмерть на работе, к
      // которой никто не притрагивался.
      //
      // Прецедент: 12 карточек спека 2, назначенных на Claude_Bot заранее,
      // держали чужую сессию, занятую совершенно другой работой.
      //
      // «Ведёшь» — это след работы: задача взята (есть agent_state или
      // сессия) либо тронут хоть один шаг. Нетронутое назначение гейт
      // отпускает: напоминать о нём — дело доски и будильника, а не
      // Stop-хука.
      const neverStarted =
        !state &&
        !t.agent_session_id &&
        steps.every((s) => !s.done && !s.agent_state && !s.agent_heartbeat_at);
      if (neverStarted) continue;

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

    if (!unfinished.length && !awaiting.length)
      return { can_stop: true, tasks: [] };

    rememberWarned(
      mySession,
      unfinished.filter((u) => u.foreign).map((u) => u.id),
    );

    const lines: string[] = [
      "⛔ ЖЁСТКИЙ ГЕЙТ: ход пытается закончиться, а работа не отпущена.",
    ];

    if (awaiting.length) {
      lines.push(
        "",
        "Тебе сдали работу и ждут твоего слова — уйти сейчас значит бросить её:",
      );
      for (const a of awaiting) {
        lines.push(`  • «${a.title}» (${a.id.slice(0, 8)}…):`);
        for (const k of a.children) {
          const what =
            k.agent_state === "review"
              ? "сдал на проверку"
              : "упёрся и ждёт решения";
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
      let task =
        getTaskForWrite(req.params.id, req.userId) ??
        getTaskForReview(req.params.id, req.userId);
      if (!task) {
        // An unassigned task created by the owner is readable by an agent,
        // but not writable yet. The self-claim gate below decides whether
        // this read access is enough to claim it. A task already assigned to
        // another agent must keep the old 403 access response.
        const readableTask = getTaskForRead(req.params.id, req.userId);
        if (readableTask?.assignee_id === null) task = readableTask;
      }
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

      // ГОТОВНОСТЬ К САМОЗАХВАТУ (миграция 026, карточка d598de9f).
      // Карточка, собранная машиной из чата, лежит без флага, пока
      // владелец её не откроет и не поднимет — никто её взять не может.
      // Проверка стоит ДО leaseAlive/canTransition, чтобы живая аренда
      // пустой карточки тоже не давала ложного «уже держит». Сообщение
      // отдельное, чтобы агент понял, что это не «занято», а «ещё не
      // разрешено», и не уходил в ресет по lease.
      if ((task.ready_for_pickup ?? 0) !== 1) {
        return reply.code(400).send({
          error:
            "задача ещё не готова к самозахвату: владелец не поднял " +
            "флаг готовности. Это нормальное состояние для карточки, " +
            "собранной машиной из чата — её владелец должен сначала " +
            "открыть и подтвердить",
        });
      }

      // Свободную задачу агент себе больше не берёт: исполнителя назначает
      // подбор по смыслу при создании (14.09.2026, вместе с удалением
      // старой доски объявлений). Осталась проверка порядка работ.
      if (task.assignee_id === null) {
        return reply.code(403).send({
          error:
            "задача ещё никому не назначена — исполнителя подбирает система " +
            "при создании, а брать чужую работу самому нельзя",
        });
      }
      const unmetDeps = unmetDependencyIds(task.id);
      if (unmetDeps.length > 0) {
        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "dependency_context_blocked",
          field: "unmet_dependency_ids",
          toValue: JSON.stringify(unmetDeps),
        });
        return reply.code(403).send({
          error:
            "задача ждёт завершения зависимостей — взять её можно после их приёмки",
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

      let claimRejection: { code: number; error: string } | null = null;
      const claimTxn = db.transaction(() => {
        // Re-read inside the transaction. Two agents may have passed all
        // checks above before either request reached SQLite; only the first
        // request may turn the still-free row into an active claim.
        const latest = db
          .prepare("SELECT * FROM tasks WHERE id = ?")
          .get(task.id) as any;
        if (!latest) {
          claimRejection = { code: 404, error: "Not found" };
          return;
        }
        if (latest.status !== "active") {
          claimRejection = {
            code: 400,
            error: "задачу можно взять в работу, только пока она активна",
          };
          return;
        }
        if ((latest.ready_for_pickup ?? 0) !== 1) {
          claimRejection = {
            code: 400,
            error: "задача больше не готова к самозахвату",
          };
          return;
        }
        const latestFrom = (latest.agent_state ?? null) as AgentState | null;
        const latestLeaseExpired =
          latestFrom === "in_progress" && isStale(latest.agent_heartbeat_at);
        const latestLeaseAlive =
          latestFrom === "in_progress" && !latestLeaseExpired;
        if (
          latestLeaseAlive &&
          latest.assignee_id &&
          latest.assignee_id !== req.userId
        ) {
          claimRejection = {
            code: 409,
            error:
              "задачу уже держит другой исполнитель — гонка за claim проиграна",
          };
          return;
        }
        // Внутри транзакции отвечать нельзя — отказ копится и отдаётся
        // после неё, как и соседние проверки гонки.
        if (latest.assignee_id === null) {
          claimRejection = {
            code: 403,
            error:
              "задача ещё никому не назначена — исполнителя подбирает система " +
              "при создании, а брать чужую работу самому нельзя",
          };
          return;
        }

        // session_id — необязательный: приходит от MCP-клиента как
        // CLAUDE_CODE_SESSION_ID процесса, который реально claim'ит. Пишем
        // его молча (не в лог) — это техническая метка «чей физически этот
        // claim», не событие, которое имеет смысл владельцу. Несколько
        // параллельных сессий делят один и тот же учётный аккаунт-агента
        // (assignee_id/Claude_Bot), поэтому это единственное поле, по
        // которому свой Stop-хук отличает «мою» незавершённую работу от
        // чужой под тем же ботом (миграция 004_agent_session_id).
        //
        // Задача 8ca87c61, шаг 2: claim создаёт запись в `attempts` и
        // проставляет tasks.current_attempt_id. Старые tasks.agent_state /
        // tasks.agent_heartbeat_at обновляются по-прежнему — переезд
        // аренды на attempt идёт в этой же правке ниже (heartbeat/state)
        // и закрывается в шагах 3–4, не здесь. tasks.current_attempt_id
        // пока nullable — у уже существующих задач его нет, и это не
        // мешает текущему claim'у: он просто не находит attempt при чтении.
        const attemptId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO attempts (id, task_id, executor_id, runner, model, started_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).run(
          attemptId,
          task.id,
          req.userId,
          (req.body && (req.body as any).runner) ?? null,
          (req.body && (req.body as any).model) ?? null,
        );
        db.prepare(
          `UPDATE tasks SET agent_state = 'in_progress', agent_heartbeat_at = datetime('now'),
             assignee_id = COALESCE(assignee_id, ?), agent_session_id = ?,
             current_attempt_id = ? WHERE id = ?`,
        ).run(req.userId, sessionOf(req), attemptId, task.id);

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
          fromValue: latest.agent_state ?? null,
          toValue: "in_progress",
        });
      });
      claimTxn();
      // The rejection is assigned inside the transaction callback, so make
      // the post-transaction value explicit for TypeScript's control-flow
      // analysis.
      const rejection = claimRejection as {
        code: number;
        error: string;
      } | null;
      if (rejection) {
        return reply.code(rejection.code).send({ error: rejection.error });
      }

      const updated = getTaskRow(task.id);
      const hydrated = hydrateTask(updated);
      // Same shape as task:created/task:updated (hydrateTask, with labels +
      // subtasks) — a client that merges task:state through the same store
      // path as the other task events must not lose labels/subtasks.
      broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });
      // Вместе с задачей агент получает ПРАВИЛА — сразу, в момент взятия.
      // Максим 20.08.2026: «чтобы любой агент, ты или не ты, когда
      // приступает к работе, на него сразу же всё это навешивалось, и он
      // строго соблюдал». Памятка в чьём-то CLAUDE.md чужому агенту не
      // указ, а этот ответ получают все одинаково.
      return { task: hydrated, rules: effectiveRules((db.prepare("SELECT role_key FROM users WHERE id=?").get(req.userId) as any)?.role_key ?? "") };
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
      const task =
        getTaskForWrite(req.params.id, req.userId) ??
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

      // Шаг 3 карточки 8ca87c61: прислал attempt_id — должен совпасть с
      // текущей действующей попыткой задачи. Старые клиенты без заголовка
      // пропускаются (мягкий enforcement), жёсткий — в следующих шагах.
      const claimedAttempt = readAttemptId(req);
      const mismatch = attemptMismatchReason(
        claimedAttempt,
        (task as any).current_attempt_id ?? null,
      );
      if (mismatch) {
        return reply.code(400).send({
          error: `attempt_id: ${mismatch}`,
        });
      }

      db.prepare(
        "UPDATE tasks SET agent_heartbeat_at = datetime('now') WHERE id = ?",
      ).run(task.id);

      // Блокер 2 карточки 8ca87c61 (ревью 11.09.2026): аренда фактически
      // не переехала на attempt, пока heartbeat продлевал только старую
      // tasks.agent_heartbeat_at. Сторож читает tasks.agent_heartbeat_at,
      // и lease_expired там вроде как срабатывает — но attempts.heartbeat_at
      // остаётся замороженным, и попытка, для которой это единственный
      // источник правды в шаге 4–5, выглядит «протухшей» навсегда.
      // Продлеваем оба, пока полный переезд аренды (taskflow на attempts
      // как primary signal) не сделан в работе последующих шагов.
      db.prepare(
        `UPDATE attempts SET heartbeat_at = datetime('now')
          WHERE id = ? AND ended_at IS NULL`,
      ).run((task as any).current_attempt_id);

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
    Body: {
      state: AgentState | null;
      comment?: string;
      session_id?: string;
      reason_code?: string;
      // Служебные поля триггера (шаг 2 шапки конвейера): записываются
      // вместе с state=blocked, чтобы планировщик (шаг 4) мог отличить
      // техническое падение от ручного «не моя роль».
      block_type?: string;
      blocked_reason?: string;
      blocked_at?: string;
      block_notified?: boolean;
      // Поля планировщика (шаг 4): он переводит карточку из blocked
      // обратно в todo и инкрементирует retry_count, либо ставит
      // новую machine_selected_role при переподборе.
      retry_count?: number;
      machine_selected_role?: string | null;
    };
  }>("/api/tasks/:id/state", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const { state } = req.body || {};
      // Сервисная дверь для trigger.py: при state=blocked сервисный
      // юзер (Pi Agent) может пометить любую задачу, даже если он не
      // assignee/creator. Это нужно, чтобы зафиксировать техническое
      // падение claim/launch_agent, когда ролевой ключ не сработал.
      let task =
        getTaskForWrite(req.params.id, req.userId) ??
        getTaskForReview(req.params.id, req.userId);
      if (!task && state === "blocked" && isServiceUser(req.userId)) {
        task = getTaskForRead(req.params.id, req.userId);
      }
      if (!task) return reply.code(404).send({ error: "Not found" });

      // Шаг 3 карточки 8ca87c61: тот же мягкий enforcement attempt_id,
      // что и в heartbeat (см. комментарий там).
      const claimedAttempt = readAttemptId(req);
      const mismatch = attemptMismatchReason(
        claimedAttempt,
        (task as any).current_attempt_id ?? null,
      );
      if (mismatch) {
        return reply.code(400).send({ error: `attempt_id: ${mismatch}` });
      }

      if (state !== null && !AGENT_STATES.includes(state)) {
        return reply.code(400).send({
          error:
            "state должно быть одним из: in_progress, blocked, review, null",
        });
      }

      const reasonCode = req.body?.reason_code;
      if (reasonCode !== undefined && !isStopReasonCode(reasonCode)) {
        return reply.code(400).send({ error: stopReasonError() });
      }

      // block_type / blocked_reason — служебные поля шага 2. Имеет смысл
      // только при state=blocked; иначе это мусор, который потом придётся
      // вычищать. Три допустимых значения — согласно плану
      // taskflow-pipeline-head-plan.md, шаг 1: technical | wrong_role | dead.
      const blockType = req.body?.block_type;
      if (blockType !== undefined) {
        if (
          state !== "blocked" ||
          !["technical", "wrong_role", "dead"].includes(blockType)
        ) {
          return reply.code(400).send({
            error:
              "block_type допустим только при state='blocked' и должен быть одним из: technical, wrong_role, dead",
          });
        }
      }
      const blockedReason =
        typeof req.body?.blocked_reason === "string"
          ? req.body.blocked_reason.trim()
          : "";

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
        // Reviewer-first — общий рубильник владельца, читается в момент
        // перехода. Гейт только для агентов; владельца он не касается.
        requiresReviewerReview: reviewerFirstEnabled(),
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

        // The old comment-only contract remains accepted for old clients.
        // When a structured code is supplied, it becomes the machine-readable
        // source of truth and is copied to the active attempt. Technical
        // retries live in their own table and therefore do not inflate the
        // number of substantive attempts.
        if (state === "blocked" && reasonCode) {
          const policy = stopReasonPolicy(reasonCode)!;
          const attemptId = (task as any).current_attempt_id as string | null;
          if (attemptId) {
            db.prepare(
              "UPDATE attempts SET reason_code = ? WHERE id = ? AND ended_at IS NULL",
            ).run(reasonCode, attemptId);
            if (policy.automaticRetry) {
              const retryNo =
                (
                  db
                    .prepare(
                      "SELECT COALESCE(MAX(retry_no), 0) AS n FROM attempt_retries WHERE attempt_id = ?",
                    )
                    .get(attemptId) as { n: number }
                ).n + 1;
              if (retryNo <= policy.maxAutomaticRetries) {
                db.prepare(
                  `INSERT INTO attempt_retries
                     (id, attempt_id, reason_code, retry_no, delay_seconds,
                      scheduled_at, detail)
                   VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)`,
                ).run(
                  uid(),
                  attemptId,
                  reasonCode,
                  retryNo,
                  policy.delaySeconds ?? 0,
                  `+${policy.delaySeconds ?? 0} seconds`,
                  comment || null,
                );
              }
            }
          }
          logEvent({
            taskId: task.id,
            actorId: req.userId,
            kind: "stop_reason",
            field: "reason_code",
            toValue: reasonCode,
          });
        }

        // A review round is immutable evidence, not just a state flag. If an
        // explicit result version was created before this transition, keep
        // it; otherwise materialize the submitted comment as the version for
        // this revision. Returning from review increments current_revision,
        // so the next submission cannot reuse the old approval.
        if (state === "review") {
          const beforeVersion = currentResultVersion(task.id);
          const version = ensureResultVersionForReview(
            task.id,
            req.userId,
            comment,
          );
          if (!beforeVersion) {
            logEvent({
              taskId: task.id,
              actorId: req.userId,
              kind: "result_version_created",
              field: "result_version",
              toValue: String(version.version_no),
            });
          }
          // Монотонная версия контекста ветки.
          bumpContextVersion(task.id);
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
        } else if (state === "blocked" && (blockType || blockedReason)) {
          // Шаг 2: вместе с переходом в blocked записываем тип причины,
          // её текст, время ухода в blocked и сбрасываем notified (шаг 5).
          // Если оба пустые — пишем только agent_state (поведение не меняется).
          db.prepare(
            `UPDATE tasks SET agent_state = ?,
                              block_type = COALESCE(?, block_type),
                              blocked_reason = COALESCE(?, blocked_reason),
                              blocked_at = COALESCE(?, blocked_at),
                              block_notified = COALESCE(?, block_notified)
              WHERE id = ?`,
          ).run(
            state,
            blockType ?? null,
            blockedReason || null,
            req.body?.blocked_at ?? null,
            typeof req.body?.block_notified === "boolean"
              ? (req.body.block_notified ? 1 : 0)
              : null,
            task.id,
          );
        } else if (state === "todo" || state === null) {
          // Шаг 4: планировщик переводит карточку обратно в todo
          // (state='todo' из blocked) или снимает блокировку (state=null).
          // Сбрасывает block_type (если не передан), и при желании —
          // инкрементирует retry_count и/или ставит новую
          // machine_selected_role.
          const retryCountRaw = req.body?.retry_count;
          const newRetryCount =
            typeof retryCountRaw === "number" && Number.isFinite(retryCountRaw)
              ? Math.max(0, Math.floor(retryCountRaw))
              : null;
          const msrRaw = req.body?.machine_selected_role;
          const newMsr =
            msrRaw === null
              ? null
              : typeof msrRaw === "string" && msrRaw.length > 0
                ? msrRaw
                : undefined;
          db.prepare(
            `UPDATE tasks SET agent_state = ?,
                              block_type = ?,
                              retry_count = COALESCE(?, retry_count),
                              machine_selected_role = COALESCE(?, machine_selected_role),
                              blocked_at = NULL,
                              block_notified = false,
                              assignee_id = NULL,
                              updated_at = datetime('now')
              WHERE id = ?`,
          ).run(
            state,
            null, // block_type снимаем при выходе из blocked
            newRetryCount,
            newMsr === undefined ? null : newMsr,
            task.id,
          );
        } else {
          db.prepare("UPDATE tasks SET agent_state = ? WHERE id = ?").run(
            state,
            task.id,
          );
        }

        // Принятие ревью владельцем (review → null) синхронизируется с
        // одобрением актуальной версии результата, чтобы последующий
        // PATCH status=completed прошёл проверку hasApprovedCurrentVersion
        // в tasks.ts. Раньше это были две разные сущности: свайп «Принять»
        // на iOS слал только setState(null), без POST /reviews — сервер 409
        // на close (см. лог 1789211958918, PATCH → 409).
        // Аналогия с approve POST /reviews в routes/reviews.ts: пишем
        // запись в reviews с verdict=approved, чтобы hasApprovedCurrentVersion
        // вернула true. criteria_version — строка-маркер схемы, у нас нет
        // версионирования критериев, "1" стабильна.
        if (from === "review" && state === null) {
          const current = currentResultVersion(task.id);
          if (current && !hasApprovedCurrentVersion(task.id)) {
            db.prepare(
              `INSERT INTO reviews
                 (id, task_id, version_id, task_revision, reviewer_id,
                  artifact_hash, criteria_version, verdict, findings,
                  created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
            ).run(
              crypto.randomUUID(),
              task.id,
              current.id,
              current.task_revision,
              req.userId,
              current.artifact_hash,
              "1",
              "approved",
            );
            logEvent({
              taskId: task.id,
              actorId: req.userId,
              kind: "review_recorded",
              field: "result_version",
              toValue: `${current.version_no}:approved`,
            });
          }
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
            (
              db
                .prepare("SELECT current_revision FROM tasks WHERE id=?")
                .get(task.id) as any
            )?.current_revision ?? null,
          );
          registryRecord({
            source: "review_return",
            trigger: "POST /api/tasks/:id/state",
            toUserId: task.assignee_id,
            data: {
              task_id: task.id,
              actor_id: req.userId,
              inbox_id: returnInboxId,
            },
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

        // Шаг 4 карточки 8ca87c61: при завершении попытки (state=null или
        // state='review') записываем исход и причину в текущую попытку.
        // Шаг 5 (сторож) закроет попытку при истечении аренды отдельным
        // сценарием — здесь только успешный release / сдача на проверку.
        if (state === null || state === "review") {
          const outcome = state === "review" ? "review" : "released";
          db.prepare(
            `UPDATE attempts
                SET ended_at = datetime('now'), outcome = ?, reason = ?
              WHERE id = ? AND ended_at IS NULL`,
          ).run(outcome, comment || null, (task as any).current_attempt_id);
          // Блокер 4 карточки 8ca87c61 (ревью 11.09.2026): сбрасываем
          // current_attempt_id сразу, чтобы старый attempt_id стал
          // устаревшим для attemptCheck, и сообщения с ним не проходили
          // до следующего claim.
          db.prepare(
            "UPDATE tasks SET current_attempt_id = NULL WHERE id = ? AND current_attempt_id = ?",
          ).run(task.id, (task as any).current_attempt_id);
        }

        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "state_changed",
          field: "agent_state",
          fromValue: from,
          toValue: state,
        });
        if (state === "review") {
          enqueueRoleRunJob({
            taskId: task.id,
            reason: "review",
            actorId: req.userId,
            dedupeKey: `review:${task.id}:${(task as any).current_attempt_id ?? uid()}`,
          });
        }
      });
      stateTxn();
      // Владелец ответил на блокировку ролевой карточки: снятие блокировки
      // обнуляет исполнителя (ветка state=null выше), а раздача сама
      // срабатывает только при поднятии флага. Без этого карточка с
      // поднятым флагом оставалась ничьей, и роль не просыпалась (живая
      // проба C3 23.09.2026, карточка bad6799f). Раздаём заново — та же
      // роль берётся из owner_selected_role, запуск ставится в очередь
      // в транзакции раздачи. Флаг не поднят — dispatchTaskToPi откажет сам.
      if (
        from === "blocked" &&
        state === null &&
        String(task.assignee_id ?? "").startsWith("role_") &&
        task.assignee_id !== req.userId
      ) {
        try {
          const { dispatchTaskToPi } = await import("./dispatch.js");
          await dispatchTaskToPi(task.id, req.userId, { system: true });
        } catch (err) {
          console.warn(`повторная раздача ${task.id} после ответа на блокировку:`, err);
        }
      }
      if (state === "review") {
        // Дочерняя сдана — может, пора исполнять родителя (его свои пункты).
        void import("./dispatch.js")
          .then((m) => m.admitParentAfterChildren(task.id))
          .catch((err) => console.warn("родитель после дочерней:", err));
      }

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

      broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });

      return { task: hydrated };
    },
  });

  // ═══════ STRUCTURED STOP ═══════
  // A stop is different from the legacy state endpoint: the caller names the
  // reason explicitly, and the server returns the policy action. Technical
  // failures are recorded as retry rows while the substantive attempt stays
  // alive; all other reasons close the current attempt and wait in blocked.
  app.post<{
    Params: { id: string };
    Body: { reason_code?: string; comment?: string; window_kind?: string };
  }>("/api/tasks/:id/stop", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const task = getTaskForWrite(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const reasonCode = req.body?.reason_code;
      const policy = stopReasonPolicy(reasonCode);
      if (!policy) return reply.code(400).send({ error: stopReasonError() });

      const claimedAttempt = readAttemptId(req);
      const mismatch = attemptMismatchReason(
        claimedAttempt,
        (task as any).current_attempt_id ?? null,
      );
      if (mismatch) {
        return reply.code(400).send({ error: `attempt_id: ${mismatch}` });
      }

      const comment =
        typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
      const attemptId = (task as any).current_attempt_id as string | null;
      if (!attemptId) {
        return reply
          .code(400)
          .send({ error: "у задачи нет действующей попытки" });
      }

      const currentAttempt = db
        .prepare(
          "SELECT executor_id, runner, model, routing_role FROM attempts WHERE id = ?",
        )
        .get(attemptId) as
        | {
            executor_id: string;
            runner: string | null;
            model: string | null;
            routing_role: string | null;
          }
        | undefined;
      const assigneeRole =
        currentAttempt?.routing_role ??
        (task.assignee_id
          ? (
              db
                .prepare("SELECT role FROM users WHERE id = ?")
                .get(task.assignee_id) as { role?: string | null } | undefined
            )?.role
          : null);
      // Эскалация по ступеням (карточка f8e8a055): лимит — ВБОК, в другую
      // учётку той же ступени; нехватка способностей — ВВЕРХ на ступень.
      // Выбор — по model_ladder и состоянию provider_limits.
      const fallback =
        reasonCode === "provider_limit" ||
        reasonCode === "insufficient_capability"
          ? nextModelForFailure(currentAttempt?.model ?? null, reasonCode)
          : null;
      if (reasonCode === "provider_limit" && currentAttempt?.model) {
        const cur = ladderEntryForModel(currentAttempt.model);
        const windowKind =
          typeof req.body?.window_kind === "string" ? req.body.window_kind : null;
        if (cur) markProviderLimited(cur.provider, windowKind, comment || null);
      }

      const retry = db
        .prepare(
          "SELECT COALESCE(MAX(retry_no), 0) AS n FROM attempt_retries WHERE attempt_id = ?",
        )
        .get(attemptId) as { n: number };
      if (policy.automaticRetry && retry.n >= policy.maxAutomaticRetries) {
        return reply.code(409).send({
          error:
            "лимит технических повторов исчерпан — нужно решение владельца",
          reason_code: reasonCode,
          action: "wait_owner",
          retry_count: retry.n,
        });
      }

      const stopTxn = db.transaction(() => {
        if (comment) {
          db.prepare(
            "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
          ).run(uid(), task.id, req.userId, comment);
        }

        if (fallback) {
          // 18.09.2026: Pi — единый runtime. Fallback по provider_limit
          // больше не переключает «следующую оболочку» (их нет) — только
          // следующую модель в лесенке роли. Executor остаётся той же
          // ролевой учёткой, runner остаётся Pi.
          //
          // 18.09.2026 (правка fallback): старый attempt НЕ трогаем —
          // он сохраняет свою исходную модель как часть истории. Только
          // закрываем его (ended_at, outcome, reason_code, reason).
          // fallback.model идёт исключительно в INSERT нового attempt
          // ниже, чтобы листа попыток честно показывала, на какой
          // модели каждый из них жил.
          db.prepare(
            `UPDATE attempts
                SET ended_at = datetime('now'), outcome = ?,
                    reason_code = ?, reason = ?
              WHERE id = ? AND ended_at IS NULL`,
          ).run(policy.action, reasonCode, comment || null, attemptId);
          const fallbackAttemptId = uid();
          db.prepare(
            `INSERT INTO attempts
               (id, task_id, executor_id, runner, model, routing_role,
                started_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
          ).run(
            fallbackAttemptId,
            task.id,
            task.assignee_id ?? "",
            "pi",
            fallback.model,
            assigneeRole,
          );
          db.prepare(
            `UPDATE tasks
                SET agent_state = 'in_progress',
                    agent_heartbeat_at = datetime('now'), agent_session_id = NULL,
                    current_attempt_id = ?, updated_at = datetime('now')
              WHERE id = ? AND current_attempt_id = ?`,
          ).run(fallbackAttemptId, task.id, attemptId);
          logEvent({
            taskId: task.id,
            actorId: req.userId,
            kind: "field_changed",
            field: "model",
            fromValue: currentAttempt?.model ?? null,
            toValue: fallback.model,
          });
        } else if (policy.automaticRetry) {
          const retryNo = retry.n + 1;
          db.prepare(
            `INSERT INTO attempt_retries
               (id, attempt_id, reason_code, retry_no, delay_seconds,
                scheduled_at, detail)
             VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)`,
          ).run(
            uid(),
            attemptId,
            reasonCode,
            retryNo,
            policy.delaySeconds ?? 0,
            `+${policy.delaySeconds ?? 0} seconds`,
            comment || null,
          );
          db.prepare(
            "UPDATE attempts SET reason_code = ? WHERE id = ? AND ended_at IS NULL",
          ).run(reasonCode, attemptId);
        } else {
          db.prepare(
            `UPDATE attempts
                SET ended_at = datetime('now'), outcome = ?,
                    reason_code = ?, reason = ?
              WHERE id = ? AND ended_at IS NULL`,
          ).run(policy.action, reasonCode, comment || null, attemptId);
          db.prepare(
            "UPDATE tasks SET current_attempt_id = NULL WHERE id = ? AND current_attempt_id = ?",
          ).run(task.id, attemptId);
          db.prepare(
            "UPDATE tasks SET agent_state = 'blocked', updated_at = datetime('now') WHERE id = ?",
          ).run(task.id);
          logEvent({
            taskId: task.id,
            actorId: req.userId,
            kind: "state_changed",
            field: "agent_state",
            fromValue: task.agent_state ?? null,
            toValue: "blocked",
          });
        }

        logEvent({
          taskId: task.id,
          actorId: req.userId,
          kind: "stop_reason",
          field: "reason_code",
          toValue: reasonCode,
        });
      });
      stopTxn();

      const updated = getTaskRow(task.id);
      const hydrated = hydrateTask(updated);
      // Лесенка модели (спек 1.2, 1.2.2): при insufficient_capability —
      // следующая ступень из attempt_policies через общий
      // attemptLadder.ts (порядок ступеней — рекурсивный CTE, не сортировка
      // по id: id строк — это порядок вставки миграции, а не лесенка).
      const nextAttemptTemplate = computeNextAttemptTemplate({
        reasonCode,
        currentModel: currentAttempt?.model ?? null,
        runner: currentAttempt?.runner ?? null,
      });
      if (fallback) {
        const notificationId = uid();
        // 18.09.2026: notify ролевую учётку (task.assignee_id), а не
        // несуществующего «следующего исполнителя» — fallback теперь
        // только про смену модели в лесенке роли.
        const notifyUserId = task.assignee_id ?? "";
        if (notifyUserId) {
          db.prepare(
            "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'assigned', ?, ?, ?)",
          ).run(
            notificationId,
            notifyUserId,
            task.id,
            `${reasonCode === "provider_limit" ? "Лимит провайдера" : "Повышение ступени"}: задача «${task.title}» переключена на ${fallback.model}`,
            req.userId,
          );
          broadcastToUsers([notifyUserId], {
            type: "notification:new",
            notificationId,
            taskId: task.id,
          });
        }
      }
      broadcastTaskEvent([updated.creator_id, updated.assignee_id], {
        type: "task:state",
        task: hydrated,
      });

      return {
        task: hydrated,
        reason_code: reasonCode,
        action: policy.action,
        retry_count: policy.automaticRetry ? retry.n + 1 : retry.n,
        retry_delay_seconds: policy.delaySeconds,
        // 18.09.2026: возвращаем только model/provider, без shell/userId
        // (Pi единственный runtime, executor не меняется).
        fallback: fallback
          ? { model: fallback.model, provider: fallback.provider }
          : null,
        next_attempt_template: nextAttemptTemplate,
        substantive_attempts: (hydrated.attempts || []).length,
      };
    },
  });
}
