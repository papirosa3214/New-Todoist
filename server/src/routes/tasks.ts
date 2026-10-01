import { ROLE_NAMES as PREPARATION_ROLES } from "../roleRouting.js";
import { validatePreparation, type TaskPreparation } from "../lib/taskPreparation.js";
import { persistPreparedPlan } from "../lib/taskPreparationPersistence.js";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { autoProposeCollaborationPlanIfNeeded } from "./task-collaboration-plans.js";
import { bumpContextVersion } from "../runtime/taskContextVersion.js";
import { reviewerFirstEnabled } from "../reviewerPolicy.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { broadcastToUsers, broadcastTaskEvent } from "../ws.js";
import {
  getTaskForRead,
  getTaskForWrite,
  getTaskForOwnerDelete,
  allLabelsOwnedByUser,
  getProjectForFiling,
  isOwner,
  isOrchestrator,
  seesEveryTask,
} from "../access.js";
import {
  isStale,
  logEvent,
  registryRecord,
  releaseSubtaskWork,
} from "../agentState.js";
import {
  currentResultVersion,
  ensureResultVersionForReview,
  hasAnyResultVersion,
  hasApprovedCurrentVersion,
  resultFromSubtasks,
} from "../resultVersions.js";
import { ROLE_NAMES, type RoleName } from "../roleRouting.js";
import { attemptLadderForTask } from "../lib/attemptLadder.js";
import { enqueueRoleRunJob } from "../runtime/roleRunQueue.js";

const uid = () => crypto.randomUUID();

const ALLOWED_STATUS = ["active", "completed"];

// due_date is stored as plain "YYYY-MM-DD" text (see db.ts, and
// src/lib/date.ts todayStr() on the frontend) — no time component, no
// timezone. Reject anything that isn't that exact shape, including
// calendar-invalid dates like "2026-02-30" that the regex alone would miss.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

// start_time хранится тем же приёмом, что и due_date выше — голым текстом
// «ЧЧ:ММ» местного времени, без даты и без пояса (миграция
// 005_task_time_of_day). Проверяем не только форму, но и осмысленность:
// «25:00» и «10:75» регулярка одну бы пропустила.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isValidTimeStr(s: string): boolean {
  return TIME_RE.test(s);
}

// Длительность — целые минуты. Верхняя граница 24 часа: задача, которая
// длится дольше суток, в дневную сетку не укладывается по определению, и
// молча принять её значило бы нарисовать блок, уезжающий за край экрана.
const MAX_DURATION_MIN = 24 * 60;
function isValidDuration(n: unknown): boolean {
  return (
    Number.isInteger(n) &&
    (n as number) > 0 &&
    (n as number) <= MAX_DURATION_MIN
  );
}

// agent_stale is derived, not stored (see agentState.ts) — attach it
// wherever a task row goes out over the API. Gated on agent_state ===
// 'in_progress': AGENT-PROTOCOL.md defines "агент пропал" specifically as
// "задача в in_progress, но последний сигнал был давно" — a stale
// agent_heartbeat_at left over on a completed task, or on one sitting in
// blocked/review waiting on the owner (exactly as designed), must NOT
// paint as abandoned just because 5 minutes passed since the last ping.
//
// `subtasks` (optional) — 17.08.2026: с тех пор, как подзадача обзавелась
// собственной арендой (см. withSubtaskState), у задачи с шагами
// task.agent_state годами остаётся NULL: работа идёт через
// /api/subtasks/:id/work, а не через /api/tasks/:id/claim — и бейдж на
// плитке доски (TaskRow.tsx: hasAgentTag = !!task.agent_state) гас, хотя
// агент реально работал. Раз состояние подзадачи и так вычисляется на
// каждое чтение, а не хранится — то же самое для роллапа наверх: если у
// задачи нет своего agent_state, но среди подзадач кто-то running/stale/
// blocked, задача показывает это состояние, унаследовав heartbeat самой
// свежей активной подзадачи. Свой agent_state (claim на задаче без
// подзадач, blocked/review от владельца) остаётся приоритетнее — роллап
// только подставляет то, чего нет.
//
// Первая версия (эта же дата) фильтровала подзадачи по !isStale() ДО
// роллапа — протухшая подзадача просто выпадала из выборки, и бейдж молча
// гас вместо того, чтобы показать «агент пропал». Это ровно та ложь,
// от которой весь этот механизм и задуман избавлять (см. AGENT-PROTOCOL.md
// и лист 2026-08-15 про подзадачи: «индикатор, который горит без работы —
// вранью равносилен» — тут была обратная сторона той же монеты, индикатор
// молчал при работе, которая просто давно не подавала признаков жизни).
// Теперь берём среди in_progress-подзадач самую свежую по heartbeat,
// протухшая она или нет, — agent_stale ниже сам решит, каким показывать
// бейдж: живым или «пропал».
//
// Второй заход (та же дата, чуть позже): без фильтра !s.done роллап считал
// давно закрытые шаги живой работой — задача с одним взятым и закрытым
// шагом из девяти показывала бы «агент пропал» бесконечно, хотя там
// объективно нечему быть пропавшим.
//
// УТОЧНЕНО 20.08.2026 (вечер): причина того остатка устранена в источнике —
// PATCH /api/subtasks/:id с done=true теперь сам гасит agent_state, agent_id
// и аренду (routes/subtasks.ts), а накопленные строки подчищены миграцией
// 007. Раньше здесь стояло «agent_state НЕ сбрасывается никогда» — это
// больше не так, не опирайтесь на это как на инвариант. Сам фильтр !s.done
// оставлен: он ничего не стоит и держит роллап честным на старых базах,
// куда миграция ещё не доехала.
export function withAgentStale(task: any, subtasks?: any[], children?: any[]) {
  let agent_state = task.agent_state;
  let agent_heartbeat_at = task.agent_heartbeat_at;

  if (!agent_state && subtasks?.length) {
    const inProgress = subtasks
      .filter((s) => !s.done && s.agent_state === "in_progress")
      .sort((a, b) => (a.agent_heartbeat_at < b.agent_heartbeat_at ? 1 : -1));
    if (inProgress.length) {
      agent_state = "in_progress";
      agent_heartbeat_at = inProgress[0].agent_heartbeat_at;
    } else if (subtasks.some((s) => !s.done && s.agent_state === "blocked")) {
      agent_state = "blocked";
    }
  }

  // Родитель не считается пропавшим, пока активны его дочерние задачи: он
  // и не должен ничего делать сам — работу ведут они, а он ждёт (задача
  // a195895d, 10.09.2026). Комментарий здесь до этого говорил «оркестратор
  // не считается пропавшим»: строка появилась 29.08.2026, когда дробить и
  // раздавать работу должен был он. Автономного оркестратора нет с
  // 08.09.2026, а правило осталось верным — просто оно про любого
  // родителя, а не про роль.
  const hasActiveChildren =
    children && children.some((c: any) => c.status === "active");

  return {
    ...task,
    agent_state,
    agent_heartbeat_at,
    agent_stale: hasActiveChildren
      ? false
      : agent_state === "in_progress" && isStale(agent_heartbeat_at),
  };
}

// То же самое для подзадачи (15.08.2026). Подзадача теперь единица работы:
// у неё своё состояние и своя аренда, поэтому «в работе» здесь тоже
// ВЫЧИСЛЯЕТСЯ, а не хранится. Замолчал дольше срока — крутилка в ленте
// гаснет сама, без чьего-либо участия. Индикатор, горящий без работы, хуже
// отсутствующего.
export function withSubtaskState(s: any) {
  const stale =
    s.agent_state === "in_progress" && isStale(s.agent_heartbeat_at);
  return {
    ...s,
    done: !!s.done,
    agent_stale: stale,
    // Готово важнее: подзадачу могли отметить сделанной, не сняв состояние.
    // Протухшая аренда возвращает её в «ждёт» — работы-то нет. review не
    // протухает как in_progress (агент сдал и ждёт решения владельца —
    // молчание тут не признак брошенной работы, а нормальное ожидание).
    state: s.done
      ? "done"
      : stale
        ? "pending"
        : s.agent_state === "in_progress"
          ? "running"
          : s.agent_state === "blocked"
            ? "blocked"
            : s.agent_state === "review"
              ? "review"
              : "pending",
  };
}

// Создатель отдаётся рядом с исполнителем: владелец 14.09.2026 —
// «почему я не вижу в карточке, кто создаёт карточки». Раньше наружу шёл
// только creator_id, по которому на экране ничего не покажешь; теперь с
// карточкой едет имя и аватар, как у исполнителя. Особенно это нужно с
// тех пор, как карточки заводит не только владелец: их создают агенты и
// разбор надиктовки.
export const TASK_COLUMNS = `t.*, u.name as assignee_name, u.type as assignee_type, u.role as assignee_role, u.avatar_color as assignee_color, u.avatar_url as assignee_avatar_url, u.initials as assignee_initials,
             c.name as creator_name, c.type as creator_type, c.role as creator_role, c.avatar_color as creator_color, c.avatar_url as creator_avatar_url, c.initials as creator_initials,
             p.name as project_name, p.color as project_color,
             (SELECT COUNT(*) FROM tasks ch WHERE ch.parent_id = t.id) as children_count,
             EXISTS(SELECT 1 FROM task_collaboration_plans cp WHERE cp.task_id = t.id AND cp.status = 'approved') as has_collaboration_plan`;
export const TASK_JOINS = `FROM tasks t
      LEFT JOIN users u ON t.assignee_id = u.id
      LEFT JOIN users c ON t.creator_id = c.id
      LEFT JOIN projects p ON t.project_id = p.id`;

export function getTaskRow(id: string) {
  return db
    .prepare(`SELECT ${TASK_COLUMNS} ${TASK_JOINS} WHERE t.id = ?`)
    .get(id) as any;
}

export function hydrateTask(task: any) {
  if (!task) return task;
  const labels = db
    .prepare(
      `SELECT l.id, l.name, l.color FROM labels l
       JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
    )
    .all(task.id);
  const subtasks = db
    .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
    .all(task.id)
    .map(withSubtaskState);
  // Шаг 6 карточки 8ca87c61: лента попыток идёт вместе с задачей.
  // Сортировка по started_at DESC — новые сверху, как в TaskFlow
  // (см. ленту событий).
  const attempts = db
    .prepare(
      `SELECT id, task_id, subtask_id, executor_id, runner, model,
              started_at, ended_at, heartbeat_at, outcome, reason, reason_code,
              consultation_suggested_reasons
         FROM attempts WHERE task_id = ? ORDER BY started_at DESC`,
    )
    .all(task.id);
  const children = db
    .prepare(
      `SELECT ${TASK_COLUMNS} ${TASK_JOINS} WHERE t.parent_id = ? ORDER BY t.created_at DESC`,
    )
    .all(task.id)
    .map((t) => {
      const childLabels = db
        .prepare(
          `SELECT l.id, l.name, l.color FROM labels l
           JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
        )
        .all((t as any).id);
      const childSubtasks = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all((t as any).id)
        .map(withSubtaskState);
      return {
        ...withAgentStale(t, childSubtasks),
        labels: childLabels,
        subtasks: childSubtasks,
      };
    });

  return {
    ...withAgentStale(task, subtasks, children),
    // Живое значение общего рубильника, а не сохранённый в карточке флаг:
    // решает в моменте, включён он сейчас или нет (см. reviewerPolicy.ts).
    requires_reviewer_review: reviewerFirstEnabled(),
    // Время запуска: собирается из даты+времени карточки; время не
    // задано — 09:00 (владелец 19.09.2026). Отдельного поля в UI нет.
    run_at: task.due_date
      ? `${task.due_date} ${task.start_time || "09:00"}`
      : null,
    run_repeat: task.run_repeat ?? "none",
    recurrence_spawned: task.recurrence_spawned ?? 0,
    repeat_until: task.repeat_until ?? null,
    labels,
    subtasks,
    children,
    attempts: attempts,
    agent_started_at: agentStartedAt(task),
    // Логическая роль: что задача сейчас «про», независимо от того,
    // выбрал её владелец (owner_selected_role) или зафиксировал
    // диспетчер при отдаче в работу (dispatched_role). Возвращается как
    // строка, чтобы клиенту не приходилось гадать по двум колонкам.
    // Пустая строка — роль ещё не выбрана: задача готова, но диспетчер
    // её ещё не тронул, и до owner-override роли тоже нет.
    role: task.dispatched_role || task.owner_selected_role || "",
  };
}

/** Когда агент в последний раз взял эту задачу.
 *
 *  Не хранится в строке задачи — берётся из журнала, единственного места, где
 *  этот момент вообще зафиксирован (kind='claimed', AGENT-PROTOCOL.md). Нужно
 *  островку на телефоне: он показывает время работы, и точка отсчёта обязана
 *  быть моментом взятия задачи, а не моментом, когда человек открыл
 *  приложение. Иначе таймер обнуляется каждый раз, когда телефон достали из
 *  кармана. Пусто — задачу никто не брал.
 *
 *  Журнал неизменяем и индексирован по (task_id, created_at), так что это
 *  дешёвое чтение хвоста, а не скан. */
function agentStartedAt(task: any): string | null {
  if (!task?.id || !task.agent_state) return null;
  const row = db
    .prepare(
      `SELECT created_at FROM task_events
       WHERE task_id = ? AND kind = 'claimed'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(task.id) as any;
  return row?.created_at || null;
}

// ═══════ TASKS CRUD ═══════

export function registerTaskRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Список задач. Кому что видно — правило в access.ts (шапка файла):
  // владельцу и его агентам видны ВСЕ задачи, самостоятельно
  // зарегистрированному человеку — только свои. Раньше правило было одно
  // для всех, и задача, заведённая агентом без проекта и без исполнителя,
  // не показывалась владельцу вообще.
  // Серия повтора дошла до конца календарного года — помечаем завершённой
  // и спрашиваем владельца (карточка f8e8a055, решение 20.09.2026).
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/repeat-ended",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = db
        .prepare("SELECT id, title FROM tasks WHERE id = ?")
        .get(req.params.id) as { id: string; title: string } | undefined;
      if (!task) return reply.code(404).send({ error: "Not found" });
      db.prepare(
        "UPDATE tasks SET recurrence_spawned = 1, updated_at = datetime('now') WHERE id = ?",
      ).run(task.id);
      const owner = db
        .prepare(
          "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (owner?.id && owner.id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'repeat_ended', ?, ?, ?)",
        ).run(
          notifId,
          owner.id,
          task.id,
          `Серия «${task.title}» дошла до конца года. Продлить на следующий год?`,
          req.userId,
        );
        broadcastToUsers([owner.id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: task.id,
        });
      }
      return { ok: true };
    },
  );

  // Продлить серию на следующий год: «до 31 декабря следующего» и снова
  // разрешаем воркеру создавать следующее вхождение (владелец).
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/repeat-extend",
    { preHandler: authPre },
    async (req: any, reply) => {
      if (!isOwner(req.userId)) {
        return reply
          .code(403)
          .send({ error: "продлевать серию может только владелец" });
      }
      const task = db
        .prepare("SELECT id FROM tasks WHERE id = ?")
        .get(req.params.id) as { id?: string } | undefined;
      if (!task) return reply.code(404).send({ error: "Not found" });
      const until = `${new Date().getFullYear() + 1}-12-31`;
      db.prepare(
        "UPDATE tasks SET repeat_until = ?, recurrence_spawned = 0, updated_at = datetime('now') WHERE id = ?",
      ).run(until, task.id);
      return { ok: true, repeat_until: until };
    },
  );

  // Слойный контекст для ролей (владелец 25.09.2026, docs/ПЛАН Супер
  // Секретарь/): счётчики + названия выполненных задач по периодам, а не
  // вся история целиком — роль зовёт это сама, когда владелец спрашивает
  // «что сделал за неделю», вместо того чтобы либо не знать, либо тащить
  // в контекст полные карточки. Названия ограничены (15 на период) —
  // счётчик при этом точный.
  app.get("/api/tasks/my-stats", { preHandler: authPre }, async (req: any) => {
    const actorId = req.userId;
    const titleLimit = 15;
    const period = (days: number) => {
      const count = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM tasks
              WHERE assignee_id = ? AND status = 'completed'
                AND completed_at >= datetime('now', ?)`,
          )
          .get(actorId, `-${days} days`) as { n: number }
      ).n;
      const tasks = db
        .prepare(
          `SELECT id, title FROM tasks
            WHERE assignee_id = ? AND status = 'completed'
              AND completed_at >= datetime('now', ?)
            ORDER BY completed_at DESC LIMIT ?`,
        )
        .all(actorId, `-${days} days`, titleLimit);
      return { count, tasks };
    };
    return { week: period(7), month: period(30) };
  });

  app.get("/api/tasks", { preHandler: authPre }, async (req: any) => {
    const userId = req.userId;
    const includeChildren = req.query.include_children === "true";
    const parentFilter = includeChildren ? "" : "t.parent_id IS NULL AND ";
    const columns = TASK_COLUMNS;
    const joins = TASK_JOINS;

    // Опциональные фильтры для планировщика (шаг 4): agent_state,
    // block_type, retry_count < N, blocked_at старше N минут.
    const filterAgentState =
      typeof req.query.agent_state === "string" ? req.query.agent_state : "";
    const filterBlockType =
      typeof req.query.block_type === "string" ? req.query.block_type : "";
    const filterRetryLt = Number(req.query.retry_count_lt);
    const filterBlockedOlderMin = Number(req.query.blocked_older_min);

    const extraFilters: string[] = [];
    const extraParams: unknown[] = [];
    if (filterAgentState) {
      extraFilters.push("t.agent_state = ?");
      extraParams.push(filterAgentState);
    }
    if (filterBlockType) {
      extraFilters.push("t.block_type = ?");
      extraParams.push(filterBlockType);
    }
    if (Number.isFinite(filterRetryLt) && filterRetryLt > 0) {
      extraFilters.push("t.retry_count < ?");
      extraParams.push(filterRetryLt);
    }
    if (
      Number.isFinite(filterBlockedOlderMin) &&
      filterBlockedOlderMin > 0
    ) {
      extraFilters.push(
        "t.blocked_at IS NOT NULL AND t.blocked_at < datetime('now', ?)",
      );
      extraParams.push(`-${filterBlockedOlderMin} minutes`);
    }
    const extraWhere = extraFilters.length
      ? " AND " + extraFilters.join(" AND ")
      : "";

    const tasks = (
      seesEveryTask(userId)
        ? db
            .prepare(
              `SELECT ${columns} ${joins} ${includeChildren ? "" : "WHERE (t.parent_id IS NULL OR t.project_id IS NOT NULL)"} ${extraWhere} ORDER BY t.created_at DESC`,
            )
            .all(...extraParams)
        : db
            .prepare(
              `SELECT ${columns} ${joins}
      WHERE ${includeChildren ? "" : "(t.parent_id IS NULL OR t.project_id IS NOT NULL) AND "}(t.creator_id = ? OR t.assignee_id = ?
         OR t.project_id IN (SELECT id FROM projects WHERE owner_id = ?))
      ${extraWhere}
      ORDER BY t.created_at DESC`,
            )
            .all(userId, userId, userId, ...extraParams)
    ) as any[];

    const stmtLabels = db.prepare(`
      SELECT l.id, l.name, l.color FROM labels l
      JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
    `);
    const stmtSub = db.prepare(
      "SELECT * FROM subtasks WHERE task_id = ? ORDER BY position",
    );
    const stmtChildren = db.prepare(
      "SELECT id, status FROM tasks WHERE parent_id = ?",
    );

    // Метка сессии вызывающего: кто именно спрашивает. По ней каждая
    // задача помечается `mine` — ведёт ли её ЭТА сессия. Учётка агента
    // одна на все сессии и на всех агентов, поэтому без такой пометки
    // чужая незавершённая работа неотличима от своей, и любой скрипт
    // реагирует на неё как на собственную (Максим 20.08.2026: «другие
    // сессии к этой задаче отношения не имеют»). Пометка справочная:
    // ничего не фильтрует и не прячет — владелец по-прежнему видит всё.
    const session = sessionOf(req);
    return tasks.map((t: any) => {
      const subtasks = stmtSub.all(t.id).map(withSubtaskState);
      const children = stmtChildren.all(t.id);
      const bySubtask = subtasks.some(
        (s: any) => s.agent_session_id && s.agent_session_id === session,
      );
      return {
        ...withAgentStale(t, subtasks, children),
        mine: session ? t.agent_session_id === session || bySubtask : null,
        labels: stmtLabels.all(t.id),
        subtasks,
        // Прогресс родителя в списке — ДВУМЯ ЧИСЛАМИ, а не массивом детей.
        //
        // Сначала здесь отдавался сам `children` в усечённом виде (id +
        // status): списку больше и не нужно. Это положило нативный клиент —
        // у него `children: [ApiTask]?`, то есть полноценная задача со
        // всеми обязательными полями, и на двух ключах декодер падал с
        // «данные отсутствуют» (поймано владельцем 10.09.2026 сразу после
        // выкатки: «сеть недоступна… не удалось разобрать ответ сервера»).
        //
        // Урок общий: в список нельзя класть под именем существующего поля
        // его обрезанную версию — у типизированных клиентов это не
        // «меньше данных», а невалидный ответ. Полные объекты детей возит
        // `GET /api/tasks/:id`, там они настоящие.
        children_total: children.length,
        children_done: (children as Array<{ status: string }>).filter(
          (c) => c.status === "completed",
        ).length,
        // Третий путь отдачи задачи, и он тоже собирается вручную мимо
        // hydrateTask. Островок на телефоне живёт как раз от списка, так что
        // без этой строки время работы считалось бы от открытия приложения.
        agent_started_at: agentStartedAt(t),
      };
    });
  });

  // Get single task — must be creator or assignee.
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForRead(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      const full = getTaskRow(task.id);

      const labels = db
        .prepare(
          `SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
        )
        .all(task.id);
      const subtasks = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(task.id)
        .map(withSubtaskState);
      const children = db
        .prepare(
          `SELECT ${TASK_COLUMNS} ${TASK_JOINS} WHERE t.parent_id = ? ORDER BY t.created_at DESC`,
        )
        .all(task.id)
        .map((t) => {
          const childLabels = db
            .prepare(
              `SELECT l.id, l.name, l.color FROM labels l
               JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
            )
            .all((t as any).id);
          const childSubtasks = db
            .prepare(
              "SELECT * FROM subtasks WHERE task_id = ? ORDER BY position",
            )
            .all((t as any).id)
            .map(withSubtaskState);
          return {
            ...withAgentStale(t, childSubtasks),
            labels: childLabels,
            subtasks: childSubtasks,
          };
        });
      const comments = db
        .prepare(
          `SELECT c.*, u.name as user_name, u.avatar_color as user_color, u.avatar_url as user_avatar_url, u.initials as user_initials
           FROM comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = ? ORDER BY c.created_at`,
        )
        .all(task.id) as any[];

      // Вложения раскладываются по своим комментариям. Одним запросом на всю
      // задачу, а не по запросу на комментарий: файлов мало, а лишние
      // обращения к базе на каждое открытие карточки ни к чему. Байты сюда
      // не попадают — только имя, тип и размер; сам файл отдаётся отдельно
      // (GET /api/attachments/:id), иначе карточка тащила бы за собой все
      // приложенные скриншоты разом.
      const attachments = db
        .prepare(
          `SELECT id, comment_id, kind, file_name, mime, size, created_at
           FROM attachments WHERE task_id = ? ORDER BY created_at`,
        )
        .all(task.id) as any[];
      for (const c of comments) {
        c.attachments = attachments.filter((a) => a.comment_id === c.id);
      }

      // Сообщения чатов, привязанных к этой задаче (владелец 21.09.2026:
      // «чтобы не комментарии они там писать в самой задаче, а в чате
      // переписываться»). Отдаются в ОБЩЕМ списке comments — той же формой,
      // что обычные комментарии, плюс пометка source='chat' и id чата: лента
      // задачи и веб рисуют их наравне с комментариями, а отличать могут по
      // пометке. Только канал 'chat' — старые owner/agents живут своей
      // жизнью и в ленту задачи не подмешиваются (их для этого никто и не
      // привязывал).
      const chatComments = db
        .prepare(
          `SELECT m.id, m.task_id, m.from_user_id AS user_id, m.text, m.created_at,
                  m.chat_id,
                  u.name AS user_name, u.avatar_color AS user_color,
                  u.avatar_url AS user_avatar_url, u.initials AS user_initials
             FROM chat_messages m
             LEFT JOIN users u ON u.id = m.from_user_id
            WHERE m.task_id = ? AND m.channel = 'chat'
            ORDER BY m.created_at`,
        )
        .all(task.id) as any[];
      if (chatComments.length) {
        // Вложения сообщений чата лежат не на задаче, а на самом сообщении
        // (`chat_message_id`), поэтому в общий `attachments` выше они не
        // попали — тянем их отдельным запросом.
        const chatFiles = db
          .prepare(
            `SELECT id, chat_message_id, kind, file_name, mime, size, created_at
               FROM attachments
              WHERE chat_message_id IN (${chatComments.map(() => "?").join(",")})
              ORDER BY created_at`,
          )
          .all(...chatComments.map((c) => c.id)) as any[];
        for (const c of chatComments) {
          c.source = "chat";
          c.attachments = chatFiles.filter((a) => a.chat_message_id === c.id);
        }
        comments.push(...chatComments);
        // Сортировка устойчивая (ES2019): при равных секундах комментарии
        // задачи сохраняют свой прежний порядок, а сообщения чата встают
        // после них — не перемешиваем две ленты внутри одной секунды.
        comments.sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)),
        );
      }
      // Файлы самой задачи — то, что приложено к её заметке (19.08.2026).
      // Разделение идёт по kind, а НЕ по «comment_id пустой»: пустой он и у
      // комментарийного файла, пока комментарий не отправлен, и брошенный
      // черновик иначе всплыл бы в карточке как вложение задачи.
      const taskAttachments = attachments.filter((a) => a.kind === "task");

      // Journal — same JOIN-users pattern as comments. actor_id can be NULL
      // (a system-authored entry), in which case the actor_* columns come
      // back NULL too and the frontend renders it as a system row.
      // ORDER BY created_at, rowid — created_at is second-resolution, so
      // several events written in the same transaction (e.g. claim's
      // 'claimed' + 'state_changed') need rowid as the tiebreaker to stay
      // in insertion order.
      const events = db
        .prepare(
          `SELECT e.*, u.name as actor_name, u.avatar_color as actor_color, u.initials as actor_initials
           FROM task_events e LEFT JOIN users u ON e.actor_id = u.id
           WHERE e.task_id = ? ORDER BY e.created_at, e.rowid`,
        )
        .all(task.id);

      // Шаг 6 карточки 8ca87c61, ревью 11.09.2026: GET /api/tasks/:id
      // собирает карточку вручную мимо hydrateTask, и без явного запроса
      // attempts лента попыток на этом пути молча пропадала.
      const attempts = db
        .prepare(
          `SELECT id, task_id, subtask_id, executor_id, runner, model,
                  started_at, ended_at, heartbeat_at, outcome, reason, reason_code,
                  consultation_suggested_reasons
             FROM attempts WHERE task_id = ? ORDER BY started_at DESC`,
        )
        .all(task.id);

      return {
        ...withAgentStale(full, subtasks, children),
        labels,
        subtasks,
        children,
        comments,
        // Чаты, привязанные к этой задаче. Нужны карточке, чтобы дать переход
        // в переписку («Чат по задаче»); сам чат в карточке не заводится и не
        // рисуется — для этого есть свой экран (владелец 21.09.2026, LOCK-195).
        chats: db
          .prepare(
            `SELECT c.id, c.title, c.kind, c.updated_at,
                    (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) AS members_count
               FROM chats c WHERE c.task_id = ? ORDER BY c.updated_at DESC`,
          )
          .all(task.id),
        attachments: taskAttachments,
        events,
        attempts,
        attempt_ladder: attemptLadderForTask(task.id),
        // Тот же расчёт, что в hydrateTask: карточка задачи собирается здесь
        // вручную и мимо него, и поле, добавленное только туда, на этом пути
        // молча пропало бы (ровно так уже терялось имя проекта).
        agent_started_at: agentStartedAt(full),
      };
    },
  );

  // Create task
  app.post<{
    Body: {
      title: string;
      description?: string;
      due_date?: string;
      // «ЧЧ:ММ» местного времени и целые минуты — оба необязательные и
      // осмысленны только вместе со сроком: время без даты некуда поставить
      // в календаре (проверка ниже).
      start_time?: string | null;
      duration_min?: number | null;
      project_id?: string;
      priority?: number;
      assignee_id?: string;
      label_ids?: string[];
      parent_id?: string;
      requires_reviewer_review?: boolean;
      // «Нужно глубокое исследование» (миграция 052): отметка при
      // постановке — владелец или Секретарь. По ней владелец запускает
      // серверный конвейер исследования (POST /api/tasks/:id/research).
      needs_research?: boolean;
      run_repeat?: string;
      repeat_until?: string | null;
      // Optional bulk-create for subtasks, created in the same transaction
      // as the task (see below). Accepts either plain titles or objects
      // shaped like { title } — TaskFormScreen currently sends plain
      // strings (see localSubtasks), objects are accepted too so a future
      // richer payload doesn't need a server change.
      preparation?: unknown;
      subtasks?: (string | { title?: string })[];
    };
  }>("/api/tasks", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const {
        title,
        description,
        due_date,
        start_time,
        duration_min,
        project_id,
        priority,
        assignee_id,
        label_ids,
        parent_id,
        requires_reviewer_review,
        needs_research,
        run_repeat,
        repeat_until,
        subtasks,
      } = req.body;

      const trimmedTitle = typeof title === "string" ? title.trim() : "";
      if (!trimmedTitle)
        return reply
          .code(400)
          .send({ error: "название задачи не может быть пустым" });

      if (
        due_date !== undefined &&
        due_date !== null &&
        (typeof due_date !== "string" || !isValidDateStr(due_date))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректная дата (ожидается формат ГГГГ-ММ-ДД)" });
      }

      if (priority !== undefined && !(priority >= 1 && priority <= 4)) {
        return reply
          .code(400)
          .send({ error: "priority must be between 1 and 4" });
      }

      if (
        start_time !== undefined &&
        start_time !== null &&
        (typeof start_time !== "string" || !isValidTimeStr(start_time))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректное время (ожидается формат ЧЧ:ММ)" });
      }

      if (
        duration_min !== undefined &&
        duration_min !== null &&
        !isValidDuration(duration_min)
      ) {
        return reply.code(400).send({
          error: "длительность — целые минуты от 1 до 1440",
        });
      }

      // Время без даты в календарь не поставить: сетка строится по дню.
      // Отсекаем здесь, а не молча сохраняем — иначе поле лежало бы в базе
      // и нигде не показывалось, и разбираться пришлось бы уже по факту
      // «я поставил время, а его нет на экране».
      if (start_time && !due_date) {
        return reply
          .code(400)
          .send({ error: "время начала имеет смысл только вместе со сроком" });
      }

      // project_id — свой проект, либо (для агента) проект того человека,
      // которому задача и адресована. См. getProjectForFiling в access.ts.
      if (project_id) {
        const project = getProjectForFiling(
          project_id,
          req.userId,
          assignee_id,
        );
        if (!project)
          return reply.code(400).send({ error: "invalid project_id" });
      }

      // label_ids must all belong to the caller.
      if (label_ids?.length && !allLabelsOwnedByUser(label_ids, req.userId)) {
        return reply.code(400).send({ error: "invalid label_ids" });
      }

      // assignee_id must reference an existing user.
      if (assignee_id) {
        const assignee = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(assignee_id);
        if (!assignee)
          return reply.code(400).send({ error: "invalid assignee_id" });
      }

      if (requires_reviewer_review !== undefined && typeof requires_reviewer_review !== "boolean") {
        return reply.code(400).send({ error: "requires_reviewer_review должен быть boolean" });
      }
      // Отметка «нужно глубокое исследование» при постановке. Раньше
      // принималась только PATCH'ем, поэтому созданная Секретарём/владельцем
      // карточка с флагом теряла его молча (найдено 21.09.2026 на живом
      // прогоне в симуляторе).
      if (needs_research !== undefined && typeof needs_research !== "boolean") {
        return reply.code(400).send({ error: "needs_research должен быть boolean" });
      }

      // Normalize+validate subtasks up front, before touching the DB, so a
      // bad entry 400s cleanly instead of failing mid-transaction.
      const subtaskTitles: string[] = [];
      if (subtasks !== undefined) {
        if (!Array.isArray(subtasks)) {
          return reply
            .code(400)
            .send({ error: "subtasks должен быть массивом" });
        }
        for (const item of subtasks) {
          const raw =
            typeof item === "string"
              ? item
              : typeof item?.title === "string"
                ? item.title
                : "";
          const t = raw.trim();
          if (!t)
            return reply
              .code(400)
              .send({ error: "у каждой подзадачи должно быть название" });
          subtaskTitles.push(t);
        }
      }

      let preparation:TaskPreparation|undefined;
      if (req.body.preparation!==undefined) {
        try {
          preparation=validatePreparation(req.body.preparation,PREPARATION_ROLES);
          if (preparation.representation==="child_cards") throw new Error("Для дерева карточек используйте импорт постановки, а не создание одной карточки");
          if (preparation.representation==="role_plan" && (subtaskTitles.length!==preparation.workstreams.length || subtaskTitles.some((t,i)=>t!==preparation!.workstreams[i].title))) throw new Error("Подзадачи не совпадают с результатами плана");
          if (preparation.representation==="role_plan" && assignee_id) throw new Error("План ролей нельзя назначить одному исполнителю при создании");
        } catch(error:any) { return reply.code(400).send({error:error.message}); }
      }
      const id = uid();
      // По умолчанию — общая настройка владельца «Сначала проверка
      // Reviewer» (Обзор → Система). Клиент флаг больше не шлёт, поэтому
      // решение тут, а не в форме карточки. Явное значение всё ещё
      // уважается (серверный контракт не ломаем).
      const ownerSetting = db
        .prepare("SELECT reviewer_first_default FROM users WHERE id = ?")
        .get(req.userId) as { reviewer_first_default?: number } | undefined;
      const requiresReviewerReview =
        requires_reviewer_review ?? ((ownerSetting?.reviewer_first_default ?? 1) === 1);
      // Расписание повторения карточки (карточка f8e8a055).
      const runRepeat =
        ["daily", "weekdays", "weekly", "monthly"].includes(String(run_repeat))
          ? String(run_repeat)
          : "none";
      const repeatUntil = repeat_until || null;

      // Task + labels + subtasks all land in one transaction — the frontend
      // used to POST the task, then POST each subtask separately (see
      // src/api/subtasks.ts createSubtaskRequest / TaskFormScreen), which
      // could leave an orphaned half-task if a later request failed. The
      // `subtasks` param lets a single request do it atomically instead;
      // omitting it keeps the exact old behavior (no subtasks written here).
      const createTaskTxn = db.transaction(() => {
        db.prepare(
          `
          INSERT INTO tasks (id, title, description, due_date, start_time, duration_min, project_id, priority, assignee_id, creator_id, parent_id, requires_reviewer_review, needs_research, run_repeat, repeat_until)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          id,
          trimmedTitle,
          description || null,
          due_date || null,
          start_time || null,
          // ?? , а не || — длительность приходит числом, и 0 через || стал бы
          // null молча. Ноль сюда всё равно не дойдёт (isValidDuration его
          // отсекает), но приём «числовое поле через ||» ошибочен сам по себе.
          duration_min ?? null,
          project_id || null,
          priority || 1,
          assignee_id || null,
          req.userId,
          parent_id || null,
          requiresReviewerReview ? 1 : 0,
          needs_research ? 1 : 0,
          runRepeat,
          repeatUntil,
        );

        if (label_ids?.length) {
          const ins = db.prepare(
            "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
          );
          for (const lid of label_ids) ins.run(id, lid);
        }

        if (subtaskTitles.length) {
          const insSub = db.prepare(
            "INSERT INTO subtasks (id, task_id, title, position) VALUES (?, ?, ?, ?)",
          );
          subtaskTitles.forEach((t, i) => insSub.run(uid(), id, t, i + 1));
        }
        if (preparation) persistPreparedPlan(id,req.userId,preparation);
      });
      createTaskTxn();

      // Первая запись ленты — «создал задачу»: до этого лента начиналась с
      // первого же изменения, и по ней нельзя было понять, кто и когда
      // задачу вообще завёл (просьба Максима 14.08.2026 — лента должна
      // фиксировать всё, начиная с создания). Исполнитель, назначенный
      // сразу при создании, пишется отдельной строкой — иначе назначение
      // «в момент заведения» осталось бы невидимым, в отличие от того же
      // назначения через правку задачи.
      logEvent({
        taskId: id,
        actorId: req.userId,
        kind: "task_created",
        field: "task",
        toValue: trimmedTitle,
      });

      // Владелец 28.09.2026: до этого предложить collaboration plan можно
      // было только руками через API — при создании задачи ничего не
      // считалось само. Для одиночного исполнителя план не создаётся
      // (см. autoProposeCollaborationPlanIfNeeded); утверждает план
      // по-прежнему только владелец. Ошибка здесь не должна ломать
      // создание задачи — отдельный try/catch.
      try {
        if (!preparation) autoProposeCollaborationPlanIfNeeded(id);
      } catch (error) {
        req.log?.error?.({ err: error, taskId: id }, "auto collaboration plan proposal failed");
      }

      if (assignee_id) {
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "field_changed",
          field: "assignee_id",
          fromValue: null,
          toValue: String(assignee_id),
        });
        // Назначение — тоже доставка (Reviewer 5f292e87: из реального потока
        // не создаётся event_type=assignment). Кладём поручение в inbox
        // исполнителю; chat_message_id синтетический (это не сообщение в чат).
        db.prepare(
          `INSERT INTO agent_inbox
             (id, chat_message_id, to_user_id, body_text, task_id,
              task_version, kind, event_type, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'text', 'assignment', 'sent', datetime('now'))`,
        ).run(
          uid(),
          `asg-${uid()}`,
          assignee_id,
          trimmedTitle,
          id,
          (
            db
              .prepare("SELECT current_revision FROM tasks WHERE id=?")
              .get(id) as any
          )?.current_revision ?? null,
        );
        registryRecord({
          source: "assignment",
          trigger: "POST /api/tasks",
          toUserId: assignee_id,
          data: { task_id: id },
          result: "inbox_sent",
        });
      }
      // Шаги, заведённые вместе с задачей, — одной строкой с их числом, а
      // не по строке на каждый: задача из десяти шагов иначе открывалась бы
      // лентой из десяти одинаковых записей, в которой не видно ничего
      // другого. Шаг, добавленный потом руками, по-прежнему пишется
      // отдельной строкой со своим названием (routes/subtasks.ts).
      if (subtaskTitles.length) {
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "subtasks_seeded",
          field: "subtask",
          toValue: String(subtaskTitles.length),
        });
      }

      // Create notification for assignee
      if (assignee_id && assignee_id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'assigned', ?, ?, ?)",
        ).run(
          notifId,
          assignee_id,
          id,
          `Новая задача назначена: ${trimmedTitle}`,
          req.userId,
        );
        broadcastToUsers([assignee_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: id,
        });
      }

      const task = getTaskRow(id);
      const hydrated = hydrateTask(task);
      const ownerRow = db
        .prepare("SELECT id FROM users WHERE role = 'owner'")
        .get() as any;
      const notifyUsers = new Set<string>(
        [req.userId, assignee_id, ownerRow?.id].filter(Boolean),
      );
      broadcastToUsers(Array.from(notifyUsers), {
        type: "task:created",
        task: hydrated,
      });

      if (parent_id) {
        const parentTask = getTaskRow(parent_id);
        if (parentTask) {
          const hydratedParent = hydrateTask(parentTask);
          const parentNotifyUsers = new Set<string>(
            [
              parentTask.creator_id,
              parentTask.assignee_id,
              ownerRow?.id,
            ].filter(Boolean),
          );
          broadcastToUsers(Array.from(parentNotifyUsers), {
            type: "task:updated",
            task: hydratedParent,
          });
        }
      }
      // Приём новой задачи: подобрать исполнителя и, если стоит
      // автоматический режим, поднять флаг и отдать в работу. Раньше это
      // делал только конвейер надиктовки, поэтому задача, заведённая
      // руками, оставалась без исполнителя и стояла даже после флага.
      //
      // Не ждём результата: подбор ходит за эмбеддингами по сети и занимает
      // около секунды, а создание задачи должно вернуться сразу. Готовую
      // карточку клиент получит по сокету.
      //
      // Импорт отложенный: dispatch.ts уже зависит от этого модуля,
      // статический импорт в обратную сторону замкнул бы круг.
      // Приём зовём ВСЕГДА, даже когда исполнитель указан при создании:
      // режим постановки — настройка владельца, и она должна действовать
      // одинаково для любой карточки. Раньше здесь стояло
      // `if (!assignee_id)`, и карточка с указанной ролью не получала ни
      // флага, ни приёма — её нельзя было взять в работу вообще.
      // Что подбор роли и раздачу чужому исполнителю делать не надо —
      // знает сам applyIntakeToNewTask.
      void (async () => {
        try {
          const { applyIntakeToNewTask } = await import("./dispatch.js");
          await applyIntakeToNewTask(id, req.userId);
          const after = getTaskRow(id);
          if (after) {
            broadcastToUsers(Array.from(notifyUsers), {
              type: "task:updated",
              task: hydrateTask(after),
            });
          }
        } catch (err) {
          // Приём — улучшение, а не условие создания: задача уже
          // заведена и видна. Молча ронять её из-за недоступной модели
          // подбора нельзя.
          console.warn(`приём задачи ${id} не удался:`, err);
        }
      })();

      return { task: hydrated };
    },
  });

  // Update task — caller must be creator or assignee. Only a fixed set of
  // columns is writable (no mass-assignment of id/creator_id/created_at/etc).
  app.patch<{
    Params: { id: string };
    Body: Partial<{
      title: string;
      description: string;
      due_date: string | null;
      start_time: string | null;
      duration_min: number | null;
      project_id: string | null;
      priority: number;
      assignee_id: string;
      status: string;
      label_ids: string[];
      // Manual sort order within a TaskBoard column (see db.ts's additive
      // migration). Any integer, including negative — TaskBoard reindexes a
      // whole column's cards to 0..n-1 on every drop, it never needs gaps.
      position: number | null;
      // Закрепить наверх списка внутри проекта (db.ts's additive migration,
      // 20.08.2026) — независимо от position, см. ProjectTasksScreen.
      pinned: boolean;
      // Признак готовности к самозахвату (миграция 026, карточка d598de9f).
      // Поднимает только владелец; пока false — claim отклоняется.
      ready_for_pickup: boolean;
      // «Нужно глубокое исследование» (миграция 052). Галочка в карточке;
      // по ней запускается серверный конвейер исследования. Ставит владелец
      // или Секретарь при постановке — см. POST /api/tasks/:id/research.
      needs_research: boolean;
    }>;
  }>("/api/tasks/:id", {
    preHandler: authPre,
    handler: async (req: any, reply) => {
      const { id } = req.params;
      const body = req.body || {};

      const existing = getTaskForWrite(id, req.userId);
      if (!existing) return reply.code(404).send({ error: "Not found" });

      // title, when sent, must not be blank — trim now so the ALLOWED_FIELDS
      // loop below writes the trimmed value.
      if (body.title !== undefined) {
        const trimmed = typeof body.title === "string" ? body.title.trim() : "";
        if (!trimmed)
          return reply
            .code(400)
            .send({ error: "название задачи не может быть пустым" });
        body.title = trimmed;
      }
      // due_date, when sent, must be a real "YYYY-MM-DD" date or null
      // (null clears the due date — see TaskFormScreen's dueDate state).
      if (
        body.due_date !== undefined &&
        body.due_date !== null &&
        (typeof body.due_date !== "string" || !isValidDateStr(body.due_date))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректная дата (ожидается формат ГГГГ-ММ-ДД)" });
      }

      // Те же правила, что при создании (см. POST выше): форма «ЧЧ:ММ»,
      // целые минуты, и время только вместе со сроком. Последнее здесь
      // сверяется с УЖЕ СОХРАНЁННЫМ сроком, если в этом же запросе его не
      // меняют — иначе «поставить время задаче, у которой срок уже есть»
      // отвергалось бы на ровном месте.
      if (
        body.start_time !== undefined &&
        body.start_time !== null &&
        (typeof body.start_time !== "string" ||
          !isValidTimeStr(body.start_time))
      ) {
        return reply
          .code(400)
          .send({ error: "некорректное время (ожидается формат ЧЧ:ММ)" });
      }
      if (
        body.duration_min !== undefined &&
        body.duration_min !== null &&
        !isValidDuration(body.duration_min)
      ) {
        return reply.code(400).send({
          error: "длительность — целые минуты от 1 до 1440",
        });
      }
      {
        const nextDue =
          body.due_date !== undefined ? body.due_date : existing.due_date;
        const nextStart =
          body.start_time !== undefined
            ? body.start_time
            : (existing as any).start_time;
        if (nextStart && !nextDue) {
          return reply.code(400).send({
            error: "время начала имеет смысл только вместе со сроком",
          });
        }
      }

      if (body.status !== undefined && !ALLOWED_STATUS.includes(body.status)) {
        return reply.code(400).send({ error: "invalid status" });
      }
      // ЗАКРЫТИЕ И ВОЗВРАТ В РАБОТУ — только владельцу (08.09.2026, задача
      // b6b57092). Закрытая карточка уходит с доски вместе со всей своей
      // историей, и если её сможет захлопнуть кто-то кроме человека, с глаз
      // уберут работу, которую владелец не видел.
      //
      // История решения — два отменённых режима:
      //  - 20.08.2026 закрывать разрешалось любому type='ai' («приёмка
      //    отдельным шагом — лишнее телодвижение»);
      //  - 29.08.2026 приёмку передали оркестратору (задача be329d8e).
      // 08.09.2026 владелец отменил и это: автономного оркестратора в системе
      // нет, декомпозиция описана как enricher плюс эскалация на владельца,
      // и строка «закрывать задачу — оркестратор» удалена из матрицы прав.
      // Ревьюер выносит вердикт, закрывает человек.
      //
      // Запрет держим на сервере: файл MCP общий, и агенту ничто не мешает
      // дёрнуть API напрямую, а описание инструмента — это соглашение,
      // которое легко забыть.
      //
      // Применяется к ОБОИМ переходам: completed (active→completed) и
      // active (completed→active, «вернуть в работу»). Возврат — та же
      // ручка, что и закрытие: нельзя закрыть «не глядя», нельзя и
      // заново открыть «не глядя».
      if (body.status !== undefined && body.status !== existing.status) {
        const actor = db
          .prepare("SELECT role FROM users WHERE id = ?")
          .get(req.userId) as { role?: string } | undefined;
        const role = actor?.role ?? "";
        if (role !== "owner") {
          return reply.code(403).send({
            error:
              "закрывать задачу и возвращать её в работу может только владелец: " +
              "исполнитель сдаёт через review, вердикт выносит ревьюер, закрывает человек",
          });
        }
      }

      if (
        body.status === "completed" &&
        existing.status !== "completed" &&
        (existing.agent_state === "review" || hasAnyResultVersion(id)) &&
        !hasApprovedCurrentVersion(id)
      ) {
        // Если close пришёл от владельца (это уже доказано веткой выше —
        // status менять может только owner), и есть актуальная версия
        // результата, но она ещё не одобрена — автоодобряем от его же
        // имени, а не возвращаем 409. Раньше клиенту приходилось слать
        // POST /reviews отдельным запросом; на iPhone это терялось в
        // гонке с локально устаревшим task.agentState, и карточка не
        // закрывалась. Логика совпадает с тем, что свайп «Принять и
        // закрыть» на iOS выражает одним действием: владелец закрыл =
        // владелец одобрил. Для переходов из review — это уже сделано в
        // routes/agent-state.ts через setState(review → null); здесь
        // покрываем кейс, когда agent_state уже null (например, после
        // явного «Принять сдачу» из чата/UI), а close приходит отдельно.
        const owner = db
          .prepare("SELECT role FROM users WHERE id = ?")
          .get(req.userId) as { role?: string } | undefined;
        if (owner?.role === "owner" && !existing.completed_at) {
          const current = currentResultVersion(id);
          if (current) {
            db.prepare(
              `INSERT INTO reviews
                 (id, task_id, version_id, task_revision, reviewer_id,
                  artifact_hash, criteria_version, verdict, findings,
                  created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
            ).run(
              uid(),
              id,
              current.id,
              current.task_revision,
              req.userId,
              current.artifact_hash,
              "1",
              "approved",
            );
            logEvent({
              taskId: id,
              actorId: req.userId,
              kind: "review_recorded",
              field: "result_version",
              toValue: `${current.version_no}:approved`,
            });
          } else {
            // Нет версии — закрывать нельзя, оставляем 409 с понятным текстом.
            return reply.code(409).send({
              error:
                "нельзя закрыть задачу: у неё нет актуальной версии результата, которую можно одобрить",
            });
          }
        } else {
          return reply.code(409).send({
            error:
              "нельзя принять задачу: у актуальной версии результата нет одобрения Reviewer/владельца",
          });
        }
      }

      if (
        body.priority !== undefined &&
        !(body.priority >= 1 && body.priority <= 4)
      ) {
        return reply
          .code(400)
          .send({ error: "priority must be between 1 and 4" });
      }
      // Тот же допуск, что и при создании (getProjectForFiling): исполнитель
      // берётся из тела, а если его там нет — из уже сохранённой задачи,
      // иначе перенос задачи в проект её же владельца ломался бы только
      // потому, что assignee_id не переслали повторно.
      if (body.project_id) {
        const project = getProjectForFiling(
          body.project_id,
          req.userId,
          body.assignee_id !== undefined
            ? body.assignee_id
            : existing.assignee_id,
        );
        if (!project)
          return reply.code(400).send({ error: "invalid project_id" });
      }
      // position, when sent, must be a plain integer — null is allowed (an
      // explicit "un-order" this task), but not e.g. a fraction or NaN.
      if (
        body.position !== undefined &&
        body.position !== null &&
        !Number.isInteger(body.position)
      ) {
        return reply.code(400).send({ error: "position must be an integer" });
      }
      if (body.assignee_id) {
        const assignee = db
          .prepare("SELECT id FROM users WHERE id = ?")
          .get(body.assignee_id);
        if (!assignee)
          return reply.code(400).send({ error: "invalid assignee_id" });
      }
      if (
        body.label_ids?.length &&
        !allLabelsOwnedByUser(body.label_ids, req.userId)
      ) {
        return reply.code(400).send({ error: "invalid label_ids" });
      }

      // better-sqlite3 rejects a raw JS boolean as a bind parameter — same
      // normalization as subtasks.ts's `done` before it reaches ALLOWED_FIELDS.
      if (body.pinned !== undefined) {
        body.pinned = body.pinned ? 1 : 0;
      }

      // Тот же приём, что у pinned: JS-булево better-sqlite3 не примет
      // параметром. Флаг глубокого исследования — обычное поле карточки,
      // менять его может тот, кому доступна запись задачи (владелец либо
      // исполнитель), отдельного owner-guard'а здесь нет: это не рубильник
      // сервиса, а отметка на карточке.
      if (body.needs_research !== undefined) {
        body.needs_research = body.needs_research ? 1 : 0;
      }

      if (body.requires_reviewer_review !== undefined) {
        if (!isOwner(req.userId)) {
          return reply.code(403).send({ error: "маршрут ревью может менять только владелец трекера" });
        }
        if (typeof body.requires_reviewer_review !== "boolean") {
          return reply.code(400).send({ error: "requires_reviewer_review должен быть boolean" });
        }
        body.requires_reviewer_review = body.requires_reviewer_review ? 1 : 0;
      }

      // ФЛАГ ГОТОВНОСТИ К САМОЗАХВАТУ (миграция 026, карточка d598de9f):
      // поднимает только владелец трекера. Если body.ready_for_pickup
      // передано — обрабатываем здесь и НЕ пропускаем в общий UPDATE ниже
      // (там это поле не в whitelist, и владельцу не нужно право «сменить
      // чужое решение задним числом» через редактирование задачи как обычное
      // поле). ready_for_pickup, ready_set_at и ready_set_by меняются
      // синхронно — три поля одной транзакцией, чтобы лента не показала
      // промежуточного состояния «флаг поднят, но без автора».
      if (body.ready_for_pickup !== undefined) {
        if (!isOwner(req.userId)) {
          return reply.code(403).send({
            error:
              "поднять или снять флаг готовности может только владелец трекера",
          });
        }
        if (typeof body.ready_for_pickup !== "boolean") {
          return reply
            .code(400)
            .send({ error: "ready_for_pickup должно быть boolean" });
        }
        const newValue = body.ready_for_pickup ? 1 : 0;
        const previous = existing.ready_for_pickup ?? 0;
        if (previous === newValue) {
          // идемпотентность: повтор того же значения не пишет лишнего события
          // и не трогает ready_set_at/by — это не «подтверждение», это пустой
          // PATCH.
        } else {
          const txn = db.transaction(() => {
            if (newValue === 1) {
              db.prepare(
                `UPDATE tasks
                    SET ready_for_pickup = 1,
                        ready_set_at = datetime('now'),
                        ready_set_by = ?,
                        updated_at = datetime('now')
                  WHERE id = ?`,
              ).run(req.userId, id);
              // Владелец 30.09.2026: «Запустить исполнителя» и «Утвердить
              // план» — одно из двух. Ручной запуск здесь означает явный
              // отказ от предложенного плана командной работы (если он
              // есть и ещё не утверждён) — гасим черновик, чтобы он не
              // висел «утверди меня» рядом с уже занятой одним
              // исполнителем карточкой. approve на superseded/draft-only
              // плане и так откажет 409 (task-collaboration-plans.ts:349).
              db.prepare(
                "UPDATE task_collaboration_plans SET status = 'superseded' WHERE task_id = ? AND status = 'draft'",
              ).run(id);
            } else {
              db.prepare(
                `UPDATE tasks
                    SET ready_for_pickup = 0,
                        ready_set_at = NULL,
                        ready_set_by = NULL,
                        updated_at = datetime('now')
                  WHERE id = ?`,
              ).run(id);
            }
            logEvent({
              taskId: id,
              actorId: req.userId,
              kind: "ready_flag_changed",
              field: "ready_for_pickup",
              fromValue: String(previous),
              toValue: String(newValue),
            });
            if (newValue === 1 && existing.assignee_id) {
              enqueueRoleRunJob({
                taskId: id,
                reason: "assigned",
                actorId: req.userId,
                dedupeKey: `ready:${id}:${uid()}`,
                manualStart: true,
              });
            }
          });
          txn();
        }
        // Флаг поднят владельцем — значит задача готова ехать. Раньше она
        // на этом и останавливалась: отдать в работу нужно было отдельным
        // действием, и про него легко забывалось. Сам подбор исполнителя
        // сидит внутри отдачи, так что ручной и автоматический режимы
        // расходятся ровно в одном — кто поднял флаг.
        // Исполнитель уже назначен — флаг и есть запуск: роль будит сервер.
        if (newValue === 1 && previous !== 1 && !existing.assignee_id) {
          try {
            const { dispatchTaskToPi } = await import("./dispatch.js");
            await dispatchTaskToPi(id, req.userId, { manualStart: true });
          } catch (err) {
            // Отказ отдачи не отменяет поднятия флага: владелец своё
            // действие сделал, и карточка обязана остаться готовой.
            console.warn(`отдача задачи ${id} после флага не удалась:`, err);
          }
        }
        // готово, остальные поля PATCH не трогают флаг — он своя ось.
        // Но если в этом же запросе передали, скажем, title — общий UPDATE
        // ниже всё равно отработает, и это нормально: это два независимых
        // действия в одном HTTP-вызове, не «одна операция».
      }

      // ВЫБОР РОЛИ ВЛАДЕЛЬЦЕМ (миграция 038, карточка 5ceda583).
      // Та же логика «только владелец трекера», что и у ready_for_pickup,
      // но это НЕЗАВИСИМАЯ ось: можно поднять роль заранее, готовность —
      // позже (или наоборот). Назначение роли само по себе работу не
      // запускает — оно лишь говорит диспетчеру, какую из 8 ролей выбрал
      // владелец, если тот доберётся до задачи. Валидация против
      // ROLE_NAMES идёт здесь, а не в SQL: CHECK на этой колонке запер бы
      // список ролей в схеме (миграция 005 уже показала, что
      // CHECK(role IN (...)) сменить дороже, чем переписать таблицу), а
      // роль добавить — операция дешевле, чем миграция через пересборку.
      if (body.owner_selected_role !== undefined) {
        if (!isOwner(req.userId)) {
          return reply.code(403).send({
            error: "выбрать роль задачи может только владелец трекера",
          });
        }

        const raw = body.owner_selected_role;
        if (raw !== null) {
          if (
            typeof raw !== "string" ||
            !ROLE_NAMES.includes(raw as RoleName)
          ) {
            return reply.code(400).send({
              error: `owner_selected_role должен быть одной из ролей: ${ROLE_NAMES.join(", ")}`,
            });
          }
        }
        const newValue = raw === null ? null : (raw as string);
        const previous = existing.owner_selected_role ?? null;
        if (previous === newValue) {
          // идемпотентность: повтор того же значения не пишет лишнего
          // события и не трогает карточку. Это не «подтверждение», это
          // пустой PATCH.
        } else {
          db.prepare(
            `UPDATE tasks SET owner_selected_role = ?, updated_at = datetime('now') WHERE id = ?`,
          ).run(newValue, id);
          logEvent({
            taskId: id,
            actorId: req.userId,
            kind: "owner_role_changed",
            field: "owner_selected_role",
            fromValue: previous ?? "",
            toValue: newValue ?? "",
          });
        }
        // готово, остальные поля PATCH не трогают owner_selected_role — это
        // своя ось. Но если в этом же запросе передали, скажем, title —
        // общий UPDATE ниже всё равно отработает, и это нормально: это два
        // независимых действия в одном HTTP-вызове.
      }

      // СМЕНА ИСПОЛНИТЕЛЯ — владелец или оркестратор трекера. Правило
      // AGENT-PROTOCOL.md «assignee_id не переписываем» защищает агента от
      // самоснятия, но заодно блокировало и владельца: он не мог
      // переназначить зависшую задачу (например, карточка ушла на Claude_Bot
      // по шаблону, а реально работает Pi Agent). Владелец системы и
      // оркестратор должны менять assignee_id в любой момент — это их
      // ручка, не агентская. Валидация «такой user существует» уже сделана выше
      // (вернёт 400 invalid assignee_id), здесь — только право на смену.
      if (
        body.assignee_id !== undefined &&
        body.assignee_id !== existing.assignee_id
      ) {
        if (!isOwner(req.userId) && !isOrchestrator(req.userId)) {
          return reply.code(403).send({
            error:
              "сменить исполнителя задачи может только владелец или оркестратор трекера",
          });
        }
      }

      // Whitelisted columns only — request body keys never reach raw SQL.
      const ALLOWED_FIELDS = [
        "title",
        "description",
        "due_date",
        "start_time",
        "duration_min",
        "project_id",
        "parent_id",
        "priority",
        "assignee_id",
        "status",
        "position",
        "pinned",
        "requires_reviewer_review",
        "needs_research",
        "run_repeat",
        "repeat_until",
        "recurrence_spawned",
      ] as const;
      const fields: string[] = [];
      const values: any[] = [];
      for (const key of ALLOWED_FIELDS) {
        if (body[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(body[key]);
        }
      }

      // completed_at tracks the moment the task became 'completed',
      // independent of updated_at (which is bumped on every PATCH below,
      // including unrelated edits). Set it only on the active→completed
      // transition; clear it back to NULL on completed→active, so a task
      // pulled back into work doesn't linger in a "completed on that day"
      // history. A repeated status:"completed" PATCH against an
      // already-completed task leaves it untouched — otherwise editing a
      // finished task (e.g. its description) would re-stamp completed_at
      // to now and slide it into "today" on an Activity screen grouped by
      // completion day, which is exactly the bug this column exists to fix.
      // Задачу перестал вести агент — гасим отметки о работе и на её шагах
      // (см. ниже, releaseSubtaskWork).
      let releasesAgentWork = false;
      if (body.status !== undefined) {
        if (body.status === "completed" && existing.status !== "completed") {
          fields.push("completed_at = datetime('now')");
          // A completed task is done — any in-flight agent_state (usually
          // 'review', it's the owner accepting) no longer means anything.
          fields.push("agent_state = NULL");
          releasesAgentWork = true;
        } else if (body.status === "active") {
          fields.push("completed_at = NULL");
          // completed -> active is "вернуть в работу" (AGENT-PROTOCOL.md
          // transition matrix) — starts clean, nobody's mid-lease on it.
          if (existing.status === "completed") {
            fields.push("agent_state = NULL");
            releasesAgentWork = true;
          }
        }
      }

      if (fields.length) {
        fields.push("updated_at = datetime('now')");
        values.push(id);
        db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(
          ...values,
        );
      }

      // Гашение agent_state у самой задачи выше очищало только её колонку, а
      // незакрытый шаг в in_progress/blocked продолжал поднимать состояние
      // наверх роллапом (withAgentStale) — уже на ЗАКРЫТОЙ задаче. Владелец
      // видел «Агент пропал» на карточке, с которой работа давно снята, а
      // заново открытая задача сразу выглядела занятой.
      if (releasesAgentWork) {
        releaseSubtaskWork(id);
      }

      // Карточку закрыли — значит следующая в очереди дождалась своей
      // предшественницы и может ехать. Без этого автоматический режим
      // делал ровно один шаг дерева и вставал: остальные карточки висели
      // готовыми, но никто их не брал.
      //
      // Только на active→completed: возврат задачи в работу очередь не
      // двигает, иначе «вернуть в работу» запускало бы следующий шаг.
      if (body.status === "completed" && existing.status !== "completed") {
        bumpContextVersion(id);
        // Дочерняя сдана — может, пора исполнять родителя (его свои пункты).
        void import("./dispatch.js")
          .then((m) => m.admitParentAfterChildren(id))
          .catch((err) => console.warn("родитель после дочерней:", err));
        try {
          // Импорт отложенный: dispatch.ts уже зависит от этого модуля
          // (getTaskRow, hydrateTask), и статический импорт в обратную
          // сторону замкнул бы круг.
          const { releaseQueuedSuccessors } = await import("./dispatch.js");
          await releaseQueuedSuccessors(id, req.userId);
        } catch (err) {
          // Очередь — надстройка над закрытием задачи, а не его часть.
          // Если она упала, закрытие всё равно должно состояться: иначе
          // владелец не сможет закрыть карточку из-за проблемы в соседней.
          req.log?.warn(
            { err: String(err) },
            `не удалось продвинуть очередь после закрытия ${id}`,
          );
        }
      }

      // Status changes go in the journal too — the "смена состояния"
      // journal row isn't only about agent_state, `status` counts as well
      // (this is how a human's own active<->completed toggles show up in
      // the task's history feed alongside the agent transitions).
      if (body.status !== undefined && body.status !== existing.status) {
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "state_changed",
          field: "status",
          fromValue: existing.status,
          toValue: body.status,
        });
      }

      // Родитель — зонтик над дочерними, своей работы у него нет: он ждёт,
      // пока закроются дети. Закрылась последняя — родитель сам уходит на
      // приёмку к владельцу. Замысел владельца 10.09.2026, дословно: «как
      // только все дочерние поставили галочки — что приходит на родителя?
      // Ревью сразу же. А не какие-то ещё эфемерные шаги».
      //
      // Именно review, а НЕ completed: закрывает задачу только владелец
      // (решение 08.09.2026, проверка выше по этому же файлу). Автомат
      // доводит работу до его стола, но не принимает её за него.
      //
      // actor_id = NULL у события — это не действие того, кто закрыл
      // ребёнка, а следствие, которое его закрытие вскрыло: тот же довод,
      // что у lease_expired в agent-state.ts.
      if (
        body.status === "completed" &&
        existing.status !== "completed" &&
        existing.parent_id
      ) {
        const parent = getTaskRow(existing.parent_id) as any;
        // Родителя трогаем, только пока он сам активен и ещё не на приёмке:
        // повторное закрытие ребёнка (или закрытие уже закрытого родителя)
        // не должно поднимать карточку обратно на доску.
        if (
          parent &&
          parent.status === "active" &&
          parent.agent_state !== "review"
        ) {
          const siblings = db
            .prepare("SELECT status FROM tasks WHERE parent_id = ?")
            .all(existing.parent_id) as Array<{ status: string }>;
          const allDone =
            siblings.length > 0 &&
            siblings.every((s) => s.status === "completed");
          // Предохранитель (владелец 22.09.2026): у родителя есть свои
          // невыполненные пункты — его работа ещё не сделана, и закрытие
          // дочерних на проверку его не отправляет. Уйдёт туда сам, когда
          // исполнитель закроет последний свой пункт (routes/subtasks.ts).
          const openOwnSteps = (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ? AND done = 0",
              )
              .get(parent.id) as { n: number }
          ).n;
          if (allDone && openOwnSteps === 0) {
            const beforeVersion = currentResultVersion(parent.id);
            const version = ensureResultVersionForReview(
              parent.id,
              req.userId,
              resultFromSubtasks(parent.id),
            );
            db.prepare(
              "UPDATE tasks SET agent_state = 'review', updated_at = datetime('now') WHERE id = ?",
            ).run(parent.id);
            bumpContextVersion(parent.id);
            if (!beforeVersion) {
              logEvent({
                taskId: parent.id,
                actorId: req.userId,
                kind: "result_version_created",
                field: "result_version",
                toValue: String(version.version_no),
              });
            }
            logEvent({
              taskId: parent.id,
              actorId: null,
              kind: "state_changed",
              field: "agent_state",
              fromValue: parent.agent_state ?? null,
              toValue: "review",
            });
            db.prepare(
              "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,?,?)",
            ).run(
              uid(),
              parent.id,
              null,
              `Все дочерние задачи закрыты (${siblings.length}) — задача ушла на приёмку.`,
            );
          }
        }
      }

      // Остальные правки задачи — в тот же журнал. До этого писался ровно
      // один вид записи (смена status выше) плюс переходы agent_state в
      // agent-state.ts, поэтому назначение исполнителя не оставляло в ленте
      // никакого следа: уведомление адресату уходило (ниже), а владелец,
      // открыв ленту, не видел, что ответственный вообще менялся. Найдено
      // Максимом 14.08.2026 — он назначил исполнителя, и лента промолчала.
      //
      // Пишем те поля, изменение которых человек воспринимает как событие:
      // исполнитель, срок, приоритет, проект, название. description и
      // position сознательно не журналируем — первое даёт «портянку» из
      // текста в ленте (для этого есть комментарии), второе меняется при
      // каждом перетаскивании карточки и забило бы ленту служебным шумом.
      const JOURNALLED = [
        "assignee_id",
        "due_date",
        "priority",
        "project_id",
        "title",
      ] as const;
      for (const key of JOURNALLED) {
        if (body[key] === undefined) continue;
        const before = existing[key] ?? null;
        const after = body[key] ?? null;
        // Числа и строки из тела запроса сравниваем по строковому виду:
        // priority приходит числом, а в SQLite лежит числом же, но из JSON
        // может прийти и строкой — String() снимает этот класс ложных
        // «изменений» без изменения того, что реально пишется в базу.
        if (String(before) === String(after)) continue;
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "field_changed",
          field: key,
          fromValue: before === null ? null : String(before),
          toValue: after === null ? null : String(after),
        });
        // Смена исполнителя — тоже доставка (5f292e87): assignment в inbox
        // новому исполнителю.
        if (key === "assignee_id" && after) {
          db.prepare(
            `INSERT INTO agent_inbox
               (id, chat_message_id, to_user_id, body_text, task_id,
                task_version, kind, event_type, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'text', 'assignment', 'sent', datetime('now'))`,
          ).run(
            uid(),
            `asg-${uid()}`,
            String(after),
            existing.title,
            id,
            (
              db
                .prepare("SELECT current_revision FROM tasks WHERE id=?")
                .get(id) as any
            )?.current_revision ?? null,
          );
          registryRecord({
            source: "assignment",
            trigger: "PATCH /api/tasks/:id",
            toUserId: String(after),
            data: { task_id: id },
            result: "inbox_sent",
          });
        }
      }

      // Описание — фактом, без текста: «изменил описание». Сам текст в
      // ленте был бы портянкой (и дублировал бы то, что видно выше в
      // карточке), но и молчать нельзя — правка описания такое же
      // телодвижение, как остальные.
      if (
        body.description !== undefined &&
        (body.description ?? "") !== (existing.description ?? "")
      ) {
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "description_changed",
          field: "description",
        });
      }

      // Update labels
      if (body.label_ids) {
        const before = (
          db
            .prepare("SELECT label_id FROM task_labels WHERE task_id = ?")
            .all(id) as Array<{ label_id: string }>
        )
          .map((r) => r.label_id)
          .sort();
        const after = [...body.label_ids].sort();
        if (before.join(",") !== after.join(",")) {
          logEvent({
            taskId: id,
            actorId: req.userId,
            kind: "labels_changed",
            field: "labels",
            fromValue: String(before.length),
            toValue: String(after.length),
          });
        }
        db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(id);
        const ins = db.prepare(
          "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
        );
        for (const lid of body.label_ids) ins.run(id, lid);
      }

      // Notification for assignee change
      if (body.assignee_id && body.assignee_id !== req.userId) {
        const notifId = uid();
        db.prepare(
          "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?, ?, 'assigned', ?, ?, ?)",
        ).run(
          notifId,
          body.assignee_id,
          id,
          `Вас назначили на: ${existing.title || id}`,
          req.userId,
        );
        broadcastToUsers([body.assignee_id], {
          type: "notification:new",
          notificationId: notifId,
          taskId: id,
        });
      }

      const task = getTaskRow(id);
      const hydrated = hydrateTask(task);
      const eventType =
        body.status === "completed" ? "task:completed" : "task:updated";
      // Notify old + new assignee, and the creator, so nobody's client goes stale.
      broadcastTaskEvent(
        [existing.creator_id, existing.assignee_id, task.assignee_id],
        {
          type: eventType,
          task: hydrated,
        },
      );

      return { task: hydrated };
    },
  });

  // Delete task — creator only (assignees complete tasks, they don't delete them).
  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    { preHandler: authPre },
    async (req: any, reply) => {
      const task = getTaskForOwnerDelete(req.params.id, req.userId);
      if (!task) return reply.code(404).send({ error: "Not found" });

      db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(req.params.id);
      db.prepare("DELETE FROM comments WHERE task_id = ?").run(req.params.id);
      db.prepare("DELETE FROM notifications WHERE task_id = ?").run(
        req.params.id,
      );
      // Must run before DELETE FROM tasks — task_events.task_id references
      // tasks(id) and foreign_keys = ON (db.ts), so deleting the parent row
      // first would fail the FK check.
      db.prepare("DELETE FROM task_events WHERE task_id = ?").run(
        req.params.id,
      );
      db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);

      broadcastTaskEvent([task.creator_id, task.assignee_id], {
        type: "task:deleted",
        id: req.params.id,
      });
      return { ok: true };
    },
  );
}
