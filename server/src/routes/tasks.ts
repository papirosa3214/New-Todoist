import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import db from "../db.js";
import { authOrApiToken, sessionOf } from "../auth.js";
import { broadcastToUsers } from "../ws.js";
import {
  getTaskForRead,
  getTaskForWrite,
  getTaskForOwnerDelete,
  allLabelsOwnedByUser,
  getProjectForFiling,
  seesEveryTask,
} from "../access.js";
import { isStale, logEvent } from "../agentState.js";

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
// Второй заход (та же дата, чуть позже): PATCH /api/subtasks/:id (done)
// трогает только колонку done, agent_state НЕ сбрасывает — см.
// routes/subtasks.ts. Значит у любой когда-либо взятой в работу подзадачи
// agent_state так и остаётся "in_progress"/"blocked" навсегда, даже после
// done. Без фильтра !s.done роллап считал давно закрытые шаги живой
// работой — задача с одним взятым и закрытым шагом из девяти показывала
// бы «агент пропал» бесконечно, хотя там объективно нечему быть пропавшим.
function withAgentStale(task: any, subtasks?: any[]) {
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

  return {
    ...task,
    agent_state,
    agent_heartbeat_at,
    agent_stale: agent_state === "in_progress" && isStale(agent_heartbeat_at),
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

export function hydrateTask(task: any) {
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
  return { ...withAgentStale(task, subtasks), labels, subtasks };
}

// ═══════ TASKS CRUD ═══════

export function registerTaskRoutes(app: FastifyInstance) {
  const authPre = authOrApiToken;

  // Список задач. Кому что видно — правило в access.ts (шапка файла):
  // владельцу и его агентам видны ВСЕ задачи, самостоятельно
  // зарегистрированному человеку — только свои. Раньше правило было одно
  // для всех, и задача, заведённая агентом без проекта и без исполнителя,
  // не показывалась владельцу вообще.
  app.get("/api/tasks", { preHandler: authPre }, async (req: any) => {
    const userId = req.userId;
    const columns = `t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.avatar_url as assignee_avatar_url, u.initials as assignee_initials,
             p.name as project_name, p.color as project_color`;
    const joins = `FROM tasks t
      LEFT JOIN users u ON t.assignee_id = u.id
      LEFT JOIN projects p ON t.project_id = p.id`;

    const tasks = (
      seesEveryTask(userId)
        ? db
            .prepare(`SELECT ${columns} ${joins} ORDER BY t.created_at DESC`)
            .all()
        : db
            .prepare(
              `SELECT ${columns} ${joins}
      WHERE t.creator_id = ? OR t.assignee_id = ?
         OR t.project_id IN (SELECT id FROM projects WHERE owner_id = ?)
      ORDER BY t.created_at DESC`,
            )
            .all(userId, userId, userId)
    ) as any[];

    const stmtLabels = db.prepare(`
      SELECT l.id, l.name, l.color FROM labels l
      JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?
    `);
    const stmtSub = db.prepare(
      "SELECT * FROM subtasks WHERE task_id = ? ORDER BY position",
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
      const bySubtask = subtasks.some(
        (s: any) => s.agent_session_id && s.agent_session_id === session,
      );
      return {
        ...withAgentStale(t, subtasks),
        mine: session ? t.agent_session_id === session || bySubtask : null,
        labels: stmtLabels.all(t.id),
        subtasks,
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

      const full = db
        .prepare(
          `SELECT t.*, u.name as assignee_name, u.avatar_color as assignee_color, u.avatar_url as assignee_avatar_url, u.initials as assignee_initials
           FROM tasks t LEFT JOIN users u ON t.assignee_id = u.id WHERE t.id = ?`,
        )
        .get(task.id) as any;

      const labels = db
        .prepare(
          `SELECT l.* FROM labels l JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ?`,
        )
        .all(task.id);
      const subtasks = db
        .prepare("SELECT * FROM subtasks WHERE task_id = ? ORDER BY position")
        .all(task.id)
        .map(withSubtaskState);
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

      return {
        ...withAgentStale(full, subtasks),
        labels,
        subtasks,
        comments,
        attachments: taskAttachments,
        events,
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
      // Optional bulk-create for subtasks, created in the same transaction
      // as the task (see below). Accepts either plain titles or objects
      // shaped like { title } — TaskFormScreen currently sends plain
      // strings (see localSubtasks), objects are accepted too so a future
      // richer payload doesn't need a server change.
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

      const id = uid();

      // Task + labels + subtasks all land in one transaction — the frontend
      // used to POST the task, then POST each subtask separately (see
      // src/api/subtasks.ts createSubtaskRequest / TaskFormScreen), which
      // could leave an orphaned half-task if a later request failed. The
      // `subtasks` param lets a single request do it atomically instead;
      // omitting it keeps the exact old behavior (no subtasks written here).
      const createTaskTxn = db.transaction(() => {
        db.prepare(
          `
          INSERT INTO tasks (id, title, description, due_date, start_time, duration_min, project_id, priority, assignee_id, creator_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      if (assignee_id) {
        logEvent({
          taskId: id,
          actorId: req.userId,
          kind: "field_changed",
          field: "assignee_id",
          fromValue: null,
          toValue: String(assignee_id),
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

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      broadcastToUsers([req.userId, assignee_id], {
        type: "task:created",
        task: hydrateTask(task),
      });
      return { task };
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
      // Задачу закрывает тот, кто её сделал, — включая агента. Решение
      // Максима 20.08.2026 по итогам живой работы с конвейером: приёмка
      // отдельным шагом оказалась лишним телодвижением, недовольство
      // результатом он выражает комментарием или новой задачей, а не
      // отказом закрыть старую. Прежний запрет (403 для type='ai') снят
      // здесь же — см. симметричную правку в routes/subtasks.ts.
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

      // Whitelisted columns only — request body keys never reach raw SQL.
      const ALLOWED_FIELDS = [
        "title",
        "description",
        "due_date",
        "start_time",
        "duration_min",
        "project_id",
        "priority",
        "assignee_id",
        "status",
        "position",
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
      if (body.status !== undefined) {
        if (body.status === "completed" && existing.status !== "completed") {
          fields.push("completed_at = datetime('now')");
          // A completed task is done — any in-flight agent_state (usually
          // 'review', it's the owner accepting) no longer means anything.
          fields.push("agent_state = NULL");
        } else if (body.status === "active") {
          fields.push("completed_at = NULL");
          // completed -> active is "вернуть в работу" (AGENT-PROTOCOL.md
          // transition matrix) — starts clean, nobody's mid-lease on it.
          if (existing.status === "completed") {
            fields.push("agent_state = NULL");
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

      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(id) as any;
      const eventType =
        body.status === "completed" ? "task:completed" : "task:updated";
      // Notify old + new assignee, and the creator, so nobody's client goes stale.
      broadcastToUsers(
        [existing.creator_id, existing.assignee_id, task.assignee_id],
        {
          type: eventType,
          task: hydrateTask(task),
        },
      );

      return { task };
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

      broadcastToUsers([task.creator_id, task.assignee_id], {
        type: "task:deleted",
        id: req.params.id,
      });
      return { ok: true };
    },
  );
}
