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
//
// Политика дерева при архивировании (замечание владельца 08.10.2026, шаг
// builder_2): когда архивируется карточка с дочерними, всё поддерево
// (корень + дети + внуки) уходит в архив атомарно. Это совпадает с уже
// работающим `purgeTasks` (`WITH RECURSIVE` по `parent_id`) и снимает
// зависшие «сироты» с активной работой и в очереди. Restore возвращает
// всё поддерево вместе с `parent_id` — связи сохраняются.

import { enqueueLinearLifecycle } from "./linearLifecycle.js";
import crypto from "node:crypto";
import db from "../db.js";
import { logEvent, releaseSubtaskWork } from "../agentState.js";
import { INCIDENT_NOTIFICATION_TYPE } from "./incidents.js";
import { cancelPendingRoleRunJob } from "../runtime/roleRunQueue.js";
import { purgeTasks } from "./taskPurge.js";

/** UUID для строк task_purge_log, чтобы шарить и принимать из тестов. */
const purgeUid = () => `plg_${crypto.randomUUID()}`;

/**
 * Собрать поддерево задач: сама `rootId` и все её потомки по `parent_id`,
 * в любом порядке. Используется в `archiveTask` и `restoreTask` —
 * операция применяется ко всему набору атомарно.
 *
 * `parent_id` у найденных узлов сохраняется как есть; это нужно, чтобы
 * restore возвращал ровно ту же структуру, что была до архивирования.
 * Каскадной починки внешних ключей не делаем: `tasks.parent_id` ссылается
 * на `tasks.id` с `ON DELETE CASCADE`, обратной ссылки нет — то есть
 * самосогласованность поддерева целиком сохраняется.
 */
function subtreeTaskIds(rootId: string): string[] {
  // WITH RECURSIVE — тот же приём, что в `purgeTasks` (lib/taskPurge.ts).
  // Используем временную таблицу, чтобы переиспользовать набор id и
  // дальше по нему выполнять UPDATE/SELECT.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _arch_subtree(id TEXT PRIMARY KEY)");
  db.exec("DELETE FROM _arch_subtree");
  db.prepare("INSERT OR IGNORE INTO _arch_subtree(id) VALUES (?)").run(rootId);
  db.exec(`
    WITH RECURSIVE kids(id) AS (
      SELECT t.id FROM tasks t JOIN _arch_subtree p ON t.parent_id = p.id
      UNION
      SELECT t.id FROM tasks t JOIN kids k ON t.parent_id = k.id
    )
    INSERT OR IGNORE INTO _arch_subtree(id) SELECT id FROM kids;
  `);
  return (db.prepare("SELECT id FROM _arch_subtree").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** Снять временную таблицу, если она есть. Безопасно вызывать многократно. */
function dropSubtree(): void {
  db.exec("DELETE FROM _arch_subtree");
  db.exec("DROP TABLE IF EXISTS _arch_subtree");
}

/**
 * Отправить карточку в архив (с поддеревом, см. политику выше).
 *
 * Что происходит в одной транзакции:
 *   1. Собирается поддерево `subtreeTaskIds(rootId)` — корень + все
 *      потомки по `parent_id` (любая глубина).
 *   2. На каждой записи поддерева в `tasks`:
 *      - `archived_at = datetime('now')`, `archived_by = actorId`
 *        (если уже стоят — функция идемпотентна и возвращает
 *        существующее значение без побочных эффектов; роуты проверяют
 *        состояние на 409/200 раздельно);
 *      - `agent_state` сбрасывается в NULL, `agent_heartbeat_at` —
 *        туда же, `ready_for_pickup = 0`. Глобальная метка «агент
 *        работает» гасится на всём поддереве, иначе карточка
 *        продолжала бы показываться в активных уведомлениях/списке.
 *   3. `releaseSubtaskWork(taskId)` для каждого узла поддерева
 *      освобождает аренду подзадач (in_progress/blocked → NULL) —
 *      работа остановлена на всём поддереве.
 *   4. Все PENDING-задачи в `role_run_jobs` для каждого узла поддерева —
 *      cancelled, чтобы планировщик не подхватил ни одну из архивных
 *      карточек после рестарта. Running-job намеренно не трогаем: для
 *      отмены бегущего шага нужен подтверждённый abort конкретной
 *      Pi-сессии — это за пределами архивирования.
 *   5. Шаги плана (`subtasks.collaboration_plan_id`) и сам план
 *      (`task_collaboration_plans`) остаются как история, но ни одна
 *      выборка их не возьмёт: подзадачи снимаются по аренде;
 *      выполненные остаются done=1, невыполненные остаются как были,
 *      и при restore их состояние не меняется (это явное решение:
 *      восстановление возвращает карточку, а не возобновляет
 *      автоматику).
 *   6. В `task_events` пишется `task:archived` для каждого узла
 *      поддерева с указанием актора и `parent_id` (для связи в ленте).
 *   7. Для карточек починки (`incident_key IS NOT NULL`) удаляется
 *      уведомление о поломке (`notifications.type = 'incident'`).
 *      Архивная карточка починки — это «починка не нужна» (владелец
 *      20.10.2026): поломка закрыта, и её запись не должна висеть в ленте
 *      уведомлений навсегда. Раньше уведомление оставалось в базе до
 *      скончания времён, и клиенты с кэшем (iOS `NotificationStore`)
 *      показывали его до перезагрузки.
 *
 * `parent_id` у потомков сохраняется, чтобы `restoreTask` вернул ровно
 * ту же структуру, что была до архивирования.
 *
 * @returns Снимок корневой задачи после изменения
 *   (текущая archived_at/archived_by) и число архивированных потомков.
 */
export function archiveTask(taskId: string, actorId: string): {
  task_id: string;
  archived_at: string;
  archived_by: string;
  already_archived: boolean;
  archived_subtree_count: number;
} {
  const txn = db.transaction((id: string, by: string) => {
    // Сначала — проверка существования корня. Это делаем ДО subtreeTaskIds,
    // чтобы неархивируемой не было: сначала убеждаемся, что корень вообще
    // есть и в каком состоянии.
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
      // Поддерево уже тоже в архиве — не трогаем ничего.
      return {
        task_id: id,
        archived_at: row.archived_at,
        archived_by: by,
        already_archived: true,
        archived_subtree_count: 0,
      };
    }

    const subtree = subtreeTaskIds(id);
    // Помечаем timestamp раз — чтобы все узлы поддерева получили ровно
    // одну и ту же метку времени (это видно в ленте и в журнале).
    const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
    const update = db.prepare(
      "UPDATE tasks SET archived_at = ?, archived_by = ?, " +
        "agent_state = NULL, agent_heartbeat_at = NULL, ready_for_pickup = 0 " +
        "WHERE id = ? AND archived_at IS NULL",
    );
    let touched = 0;
    for (const tid of subtree) {
      const r = update.run(stamp, by, tid);
      touched += r.changes;
    }
    if (touched === 0) {
      // Гонка: параллельный архивирующий успел раньше. Считаем
      // идемпотентно — пусть роут прочитает текущее состояние.
      const current = db
        .prepare("SELECT archived_at, archived_by FROM tasks WHERE id = ?")
        .get(id) as { archived_at: string; archived_by: string } | undefined;
      dropSubtree();
      return {
        task_id: id,
        archived_at: current?.archived_at ?? "",
        archived_by: current?.archived_by ?? by,
        already_archived: true,
        archived_subtree_count: 0,
      };
    }

    // Уведомление о поломке уходит вместе с карточкой починки: поломка
    // закрыта — записи в ленте быть не должно. Трогаем ТОЛЬКО уведомления
    // типа `incident` по карточкам с `incident_key`; остальные уведомления
    // по карточке (наблюдения, комментарии) остаются как есть.
    const incidentCards = db
      .prepare(
        `SELECT id FROM tasks
          WHERE incident_key IS NOT NULL
            AND id IN (SELECT id FROM _arch_subtree)`,
      )
      .all() as Array<{ id: string }>;
    const dropIncidentNotification = db.prepare(
      "DELETE FROM notifications WHERE type = ? AND task_id = ?",
    );
    for (const card of incidentCards) {
      dropIncidentNotification.run(INCIDENT_NOTIFICATION_TYPE, card.id);
    }

    // Аренды подзадач (in_progress/blocked) снимаются — это «работа
    // остановлена» на всём поддереве.
    for (const tid of subtree) releaseSubtaskWork(tid);

    // Отложенные запуски — cancelled. Если у шага уже был running job,
    // он сам дойдёт до проверки archived и завершится (roleRunWorker
    // смотрит на archived_at).
    const pending = db
      .prepare(
        "SELECT id FROM role_run_jobs WHERE task_id = ? AND status IN ('queued', 'retry_wait')",
      )
      .all(id) as Array<{ id: string }>;
    for (const p of pending) cancelPendingRoleRunJob(p.id);
    // Дочерние узлы поддерева тоже могут иметь свои pending jobs
    // (например, комментарий, оставленный в момент архивирования).
    for (const tid of subtree) {
      if (tid === id) continue;
      const kids = db
        .prepare(
          "SELECT id FROM role_run_jobs WHERE task_id = ? AND status IN ('queued', 'retry_wait')",
        )
        .all(tid) as Array<{ id: string }>;
      for (const p of kids) cancelPendingRoleRunJob(p.id);
    }

    // Журнал задачи: одно событие на каждый узел поддерева. Так лента
    // задачи и iOS получают полную картину, что именно ушло в архив
    // (для помощника владельца это тоже полезно — он видит, какие дети «ушли
    // вместе»).
    for (const tid of subtree) {
      logEvent({
        taskId: tid,
        actorId: by,
        kind: "task:archived",
        field: "archived_at",
        fromValue: null,
        toValue: "now",
      });
    }

    const cur = db
      .prepare("SELECT archived_at FROM tasks WHERE id = ?")
      .get(id) as { archived_at: string };
    dropSubtree();
    return {
      task_id: id,
      archived_at: cur.archived_at,
      archived_by: by,
      already_archived: false,
      archived_subtree_count: subtree.length,
    };
  });
  const out = txn(taskId, actorId);
  if (!out.already_archived) enqueueLinearLifecycle(subtreeTaskIds(taskId), "archive");
  return out;
}

/**
 * Восстановить карточку из архива (с поддеревом).
 *
 * Условия (кроме прав доступа, которые проверяют ворота):
 *   - карточка в архиве (NOT NULL archived_at), иначе — 409 not_archived;
 *   - проект карточки живой (NULL archived_at), иначе — 409
 *     project_archived: восстановление задачи в архивный проект не
 *     имеет смысла (контракт §3).
 *
 * Что делается:
 *   - поддерево корня (`subtreeTaskIds(rootId)`) снимается с архива
 *     атомарно: `archived_at`/`archived_by` → NULL на каждом узле.
 *     `parent_id` сохраняется — структура дерева возвращается ровно
 *     такой, какой была до архивирования;
 *   - в `task_events` пишется `task:restored` для каждого узла
 *     поддерева;
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
  restored_subtree_count?: number;
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

    // Поддерево: корень + все архивные потомки (родительский archived
    // уже подтверждён, дети тоже в архиве — иначе нарушена инвариантность
    // политики B).
    const subtree = subtreeTaskIds(id);
    const upd = db.prepare(
      "UPDATE tasks SET archived_at = NULL, archived_by = NULL " +
        "WHERE id = ? AND archived_at IS NOT NULL",
    );
    let touched = 0;
    for (const tid of subtree) {
      const r = upd.run(tid);
      touched += r.changes;
    }
    if (touched === 0) {
      dropSubtree();
      return { task_id: id, reason: "not_archived" };
    }
    for (const tid of subtree) {
      logEvent({
        taskId: tid,
        actorId: by,
        kind: "task:restored",
        field: "archived_at",
        fromValue: "archived",
        toValue: null,
      });
    }
    dropSubtree();
    return { task_id: id, restored_subtree_count: subtree.length };
  });
  const out = txn(taskId, actorId);
  if (out.restored_subtree_count) enqueueLinearLifecycle(subtreeTaskIds(taskId), "unarchive");
  return out;
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
  // Связь с Linear удалится вместе с карточкой — задание ставим до чистки.
  enqueueLinearLifecycle([taskId], "delete");
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
 * (только владелец, фильтр `archived=true`).
 *
 * Политика дерева (см. шапку файла): при архивировании корня всё
 * поддерево уходит в архив атомарно. Чтобы в UI архива не дублировать
 * одну и ту же «операцию» N раз (родитель + каждый ребёнок), здесь
 * отдаются только корни архивных поддеревьев: запись t, у которой
 * `parent_id IS NULL` либо указывает на не-архивную карточку.
 * Число архивных потомков корня возвращается как
 * `archived_subtree_count` — для iOS-чипа «в архиве с детьми».
 *
 * Сортировка — `archived_at DESC` (свежие сверху), как требует §3
 * контракта.
 */
export function listArchivedTasks(input: {
  projectId?: string | null;
  assigneeId?: string | null;
  limit?: number;
} = {}): Array<{
  id: string;
  archived_at: string;
  subtask_count: number;
  archived_subtree_count: number;
}> {
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
  // Отбираем только корни: либо нет parent_id, либо parent_id указывает
  // на НЕархивную карточку. Это исключает «промежуточные» узлы
  // архивного поддерева.
  where.push(
    "(t.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id AND p.archived_at IS NOT NULL))",
  );
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  // Считаем архивных потомков корня рекурсивно (включая сам корень):
  // для каждой записи t, у которой выполнен where-предикат «архивный
  // корень» (см. выше), выдаём 1 + число архивных узлов, чьим
  // ближайшим предком в архиве является t. Альтернатива — отдельный
  // рекурсивный проход в JS, но он уступает SQLite CTE по объёму
  // кода и по гарантии «выполнилось всё в одной транзакции».
  return db
    .prepare(
      `WITH RECURSIVE arch_roots(id) AS (
         SELECT t.id FROM tasks t WHERE ${where.join(" AND ")}
       ),
       arch_subtree(root_id, id) AS (
         SELECT id, id FROM arch_roots
         UNION
         SELECT a.root_id, d.id
           FROM arch_subtree a
           JOIN tasks d ON d.parent_id = a.id
          WHERE d.archived_at IS NOT NULL
       )
      SELECT r.id, r.archived_at,
             (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = r.id) AS subtask_count,
             (SELECT COUNT(*) FROM arch_subtree s WHERE s.root_id = r.id) AS archived_subtree_count
        FROM tasks r
       WHERE r.id IN (SELECT id FROM arch_roots)
       ORDER BY r.archived_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    archived_at: string;
    subtask_count: number;
    archived_subtree_count: number;
  }>;
}
