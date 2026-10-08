// server/src/lib/taskArchive.ts
//
// Архив задач вместо удаления (карточка 57c69735…). Логика — здесь, роуты
// — в routes/tasks.ts. Один модуль на все три действия (archive / restore /
// purge) держит правила вместе: где снимается работа, что чистится, что
// пишется в `task_purge_log`. Роуты вызывают функции ниже как ворота в БД,
// а сами проверяют только право и формируют ответ.
//
// Сценарии и границы — в `docs/architecture/57c69735-task-archive-contract.md`,
// §2 (модель, дерево, текущее выполнение) и §3 (API). Тесты —
// server/test/taskArchive.test.ts.

import crypto from "node:crypto";
import db from "../db.js";
import { logEvent, releaseSubtaskWork } from "../agentState.js";
import { cancelPendingRoleRunJob } from "../runtime/roleRunQueue.js";
import { purgeTasks } from "./taskPurge.js";

/** UUID для строк task_purge_log, чтобы шарить и принимать из тестов. */
const purgeUid = () => `plg_${crypto.randomUUID()}`;

/**
 * Отправить карточку в архив.
 *
 * Что происходит в одной транзакции:
 *   1. `archived_at`/`archived_by` ставятся (если уже стоят — функция
 *      идемпотентна и возвращает существующее значение без побочных
 *      эффектов; роуты проверяют состояние на 409/200 раздельно).
 *   2. `agent_state` на самой задаче сбрасывается в NULL — глобальная
 *      метка «агент работает» гасится, иначе карточка продолжала бы
 *      показываться в активных уведомлениях/списке.
 *   3. `releaseSubtaskWork(taskId)` освобождает аренду подзадач
 *      (in_progress/blocked → NULL) — отдельная ручка уже отвечает за
 *      правильное «кто отпустил» и снимает lease без потери результата.
 *   4. Все PENDING-задачи в `role_run_jobs` для этой карточки —
 *      cancelled, чтобы планировщик не подхватил архивную карточку после
 *      рестарта. Running-job намеренно не трогаем: для отмены бегущего
 *      шага нужен подтверждённый abort конкретной Pi-сессии — это за
 *      пределами архивирования.
 *   5. Шаги плана (`subtasks.collaboration_plan_id`) и сам план
 *      (`task_collaboration_plans`) остаются как история, но ни одна
 *      выборка их не возьмёт: подзадачи помечены NOT NULL только на
 *      аренду; выполненные остаются done=1, невыполненные остаются как
 *      были, и при restore их состояние не меняется (это явное решение:
 *      восстановление возвращает карточку, а не возобновляет автоматику).
 *   6. В `task_events` записывается `task:archived` с указанием актора —
 *      для ленты задачи и чтобы журнал был такой же, как у других
 *      переходов.
 *
 * Поведение «дерево не трогаем» зашито здесь: дочерние карточки
 * остаются живыми (сироты). Если их позже тоже архивируют — отдельно,
 * без рекурсии.
 *
 * @returns Снимок задачи после изменения (текущая archived_at/archived_by).
 */
export function archiveTask(taskId: string, actorId: string): {
  task_id: string;
  archived_at: string;
  archived_by: string;
  already_archived: boolean;
} {
  const txn = db.transaction((id: string, by: string) => {
    const row = db.prepare("SELECT id, archived_at FROM tasks WHERE id = ?").get(id) as
      | { id: string; archived_at: string | null }
      | undefined;
    if (!row) {
      const err = new Error("task_not_found");
      (err as any).code = "not_found";
      throw err;
    }

    if (row.archived_at) {
      // Идемпотентно. Повторный DELETE (или POST /archive) на архивную
      // задачу — 200, без снятия аренды и без новой метки в журнале.
      return {
        task_id: id,
        archived_at: row.archived_at,
        archived_by: by,
        already_archived: true,
      };
    }

    const stamp = db
      .prepare(
        "UPDATE tasks SET archived_at = datetime('now'), archived_by = ?, " +
          "agent_state = NULL, agent_heartbeat_at = NULL, ready_for_pickup = 0 " +
          "WHERE id = ? AND archived_at IS NULL",
      )
      .run(by, id);
    if (stamp.changes !== 1) {
      // Гонка: параллельный архивирующий успел раньше. Считаем
      // идемпотентно — пусть роут прочитает текущее состояние.
      const current = db
        .prepare("SELECT archived_at, archived_by FROM tasks WHERE id = ?")
        .get(id) as { archived_at: string; archived_by: string } | undefined;
      return {
        task_id: id,
        archived_at: current?.archived_at ?? "",
        archived_by: current?.archived_by ?? by,
        already_archived: true,
      };
    }

    // Аренды подзадач (in_progress/blocked) снимаются — это «работа
    // остановлена», как и требует §2 контракта.
    releaseSubtaskWork(id);

    // Отложенные запуски — cancelled. Если у шага уже был running job,
    // он сам дойдёт до проверки archived и завершится (roleRunWorker
    // смотрит на archived_at).
    const pending = db
      .prepare(
        "SELECT id FROM role_run_jobs WHERE task_id = ? AND status IN ('queued', 'retry_wait')",
      )
      .all(id) as Array<{ id: string }>;
    for (const p of pending) cancelPendingRoleRunJob(p.id);

    // Журнал задачи: один kind на оба случая (DELETE и POST /archive),
    // потому что для ленты задачи это одно и то же действие.
    logEvent({
      taskId: id,
      actorId: by,
      kind: "task:archived",
      field: "archived_at",
      fromValue: null,
      toValue: "now",
    });

    const cur = db
      .prepare("SELECT archived_at FROM tasks WHERE id = ?")
      .get(id) as { archived_at: string };
    return {
      task_id: id,
      archived_at: cur.archived_at,
      archived_by: by,
      already_archived: false,
    };
  });
  return txn(taskId, actorId);
}

/**
 * Восстановить карточку из архива.
 *
 * Условия (кроме прав доступа, которые проверяют ворота):
 *   - карточка в архиве (NOT NULL archived_at), иначе — 409 not_archived;
 *   - проект карточки живой (NULL archived_at), иначе — 409
 *     project_archived: восстановление задачи в архивный проект не
 *     имеет смысла (контракт §3).
 *
 * Что делается:
 *   - `archived_at`/`archived_by` снимаются в NULL;
 *   - в `task_events` пишется `task:restored`;
 *   - existing-работы НЕ возобновляются: план и подзадачи остаются как
 *     были, как требует §2 контракта.
 *
 * Транзакция защищает от гонки: если параллельно кто-то уже
 * восстановил, мы получим 0 изменений и отдадим 409.
 */
export function restoreTask(taskId: string, actorId: string): {
  task_id: string;
  project_archived?: boolean;
  reason?: string;
} {
  const txn = db.transaction((id: string, by: string) => {
    const row = db
      .prepare(
        "SELECT id, archived_at, project_id FROM tasks WHERE id = ?",
      )
      .get(id) as
      | { id: string; archived_at: string | null; project_id: string | null }
      | undefined;
    if (!row) {
      const err = new Error("task_not_found");
      (err as any).code = "not_found";
      throw err;
    }
    if (!row.archived_at) {
      return { task_id: id, reason: "not_archived" };
    }
    if (row.project_id) {
      const proj = db
        .prepare("SELECT archived_at FROM projects WHERE id = ?")
        .get(row.project_id) as { archived_at: string | null } | undefined;
      if (proj?.archived_at) {
        return { task_id: id, project_archived: true };
      }
    }
    const upd = db
      .prepare(
        "UPDATE tasks SET archived_at = NULL, archived_by = NULL " +
          "WHERE id = ? AND archived_at IS NOT NULL",
      )
      .run(id);
    if (upd.changes !== 1) {
      return { task_id: id, reason: "not_archived" };
    }
    logEvent({
      taskId: id,
      actorId: by,
      kind: "task:restored",
      field: "archived_at",
      fromValue: "archived",
      toValue: null,
    });
    return { task_id: id };
  });
  return txn(taskId, actorId);
}

/**
 * Окончательно удалить архивную карточку.
 *
 * Условия (после проверки права и архивности в роуте):
 *   - ровно ноль дочерних (`WHERE parent_id = ?`), иначе 409 has_children;
 *   - ровно ноль активной работы (`agent_state IS NULL` или
 *     незалогированных шагов), иначе 409 still_running.
 *
 * Перед удалением — запись в `task_purge_log` (отдельная таблица,
 * единственный след после purge). В журнал складываем числа того, что
 * ушло из БД вместе с задачей: subtasks, comments, attachments, events.
 * Подсчёт делается ДО delete'ов.
 *
 * Физическая чистка идёт через `purgeTasks` из lib/taskPurge.ts — он
 * разрывает кольцо «подзадача ↔ план» и зачищает журнальные таблицы.
 *
 * Ошибки-как-409 возвращаются как структурированный объект: роут сам
 * выбирает HTTP-код по полю `reason`, логика же одна.
 */
export function purgeArchivedTask(taskId: string, actorId: string): {
  ok: boolean;
  reason?: "not_archived" | "has_children" | "still_running";
  child_count?: number;
  running_subtask?: { id: string; agent_state: string };
  counts?: { subtasks: number; comments: number; attachments: number; events: number };
  task_id: string;
  title: string;
} {
  // Шаги 1–3 — без транзакции: они read-only, и их ошибки лучше увидеть
  // отдельным кодом, чем откатывать журнал. Шаг 4 (purge) — тоже без
  // общей: свою транзакцию держит сам `purgeTasks`.
  const row = db
    .prepare("SELECT id, title, archived_at, project_id, agent_state FROM tasks WHERE id = ?")
    .get(taskId) as
    | {
        id: string;
        title: string;
        archived_at: string | null;
        project_id: string | null;
        agent_state: string | null;
      }
    | undefined;
  if (!row) return { ok: false, reason: "not_archived", task_id: taskId, title: "" };
  if (!row.archived_at) {
    return { ok: false, reason: "not_archived", task_id: taskId, title: row.title };
  }

  const kids = (
    db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get(taskId) as { n: number }
  ).n;
  if (kids > 0) {
    return { ok: false, reason: "has_children", child_count: kids, task_id: taskId, title: row.title };
  }

  // Активная работа: либо agent_state на самой задаче, либо незакрытая
  // подзадача с активной арендой. Архивирование уже снимает оба, но
  // повторная проверка на purge — обязательна (требование §3.2 контракта).
  if (row.agent_state) {
    return {
      ok: false,
      reason: "still_running",
      running_subtask: { id: taskId, agent_state: row.agent_state },
      task_id: taskId,
      title: row.title,
    };
  }
  const liveSub = db
    .prepare(
      "SELECT id, agent_state FROM subtasks WHERE task_id = ? AND done = 0 AND agent_state IN ('in_progress', 'blocked') LIMIT 1",
    )
    .get(taskId) as { id: string; agent_state: string } | undefined;
  if (liveSub) {
    return {
      ok: false,
      reason: "still_running",
      running_subtask: liveSub,
      task_id: taskId,
      title: row.title,
    };
  }

  // Считаем заранее — потомков уносит каскад, и в changes это не попадает,
  // что и было замечено в `purgeTasks`.
  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const subtasks = count("SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?", taskId);
  const comments = count("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?", taskId);
  const attachments = count("SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?", taskId);
  const events = count("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?", taskId);

  db.prepare(
    `INSERT INTO task_purge_log
       (id, task_id, task_title, project_id, actor_id, subtasks, comments, attachments, events)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    purgeUid(),
    taskId,
    row.title,
    row.project_id,
    actorId,
    subtasks,
    comments,
    attachments,
    events,
  );

  // Физическая чистка: lib/taskPurge.purgeTasks уже умеет разрывать кольцо
  // «подзадача ↔ план» и чистить журнальные таблицы без каскада.
  purgeTasks([taskId]);

  return {
    ok: true,
    counts: { subtasks, comments, attachments, events },
    task_id: taskId,
    title: row.title,
  };
}

/**
 * Удобный помощник для тестов и роутов: список архивных задач
 * (только владелец, фильтр `archived=true`). Выдаёт строки в формате,
 * пригодном для hydrateTask, плюс `subtask_count` для iOS-чипа «есть
 * подзадачи». Сортировка — `archived_at DESC` (свежие сверху), как
 * требует §3 контракта.
 */
export function listArchivedTasks(input: {
  projectId?: string | null;
  assigneeId?: string | null;
  limit?: number;
} = {}): Array<{ id: string; archived_at: string; subtask_count: number }> {
  const where: string[] = ["t.archived_at IS NOT NULL"];
  const params: unknown[] = [];
  if (input.projectId) {
    where.push("t.project_id = ?");
    params.push(input.projectId);
  }
  if (input.assigneeId) {
    where.push("t.assignee_id = ?");
    params.push(input.assigneeId);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  return db
    .prepare(
      `SELECT t.id, t.archived_at,
              (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) AS subtask_count
         FROM tasks t
        WHERE ${where.join(" AND ")}
        ORDER BY t.archived_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    archived_at: string;
    subtask_count: number;
  }>;
}
