import db from "../db.js";

/**
 * Удаление карточек со всем, что на них держится, — одно место для корзины
 * карточки и для вычистки проекта (владелец 07.10.2026).
 *
 * Зачем отдельная функция: подзадача ссылается на план
 * (subtasks.collaboration_plan_id), а шаг плана — на подзадачу
 * (task_collaboration_plan_nodes.source_subtask_id), и обе ссылки без
 * каскада. Это кольцо: план нельзя удалить из-за подзадач, подзадачи — из-за
 * шагов плана, и карточка с планом не удалялась вовсе. Здесь кольцо сначала
 * разрывается (ссылки обнуляются), потом уходят планы, журнальные таблицы
 * без каскада и сами карточки; остальное добирает каскад.
 *
 * Дочерние карточки удаляются вместе с родителем (tasks.parent_id — каскад),
 * поэтому в набор попадают и все потомки: у них те же журнальные таблицы.
 * Вызывать внутри своей транзакции или без неё — функция сама атомарна.
 */
export function purgeTasks(taskIds: string[]): number {
  if (!taskIds.length) return 0;
  const run = db.transaction((ids: string[]) => {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS purge_task_ids(id TEXT PRIMARY KEY)");
    db.exec("DELETE FROM purge_task_ids");
    const add = db.prepare("INSERT OR IGNORE INTO purge_task_ids(id) VALUES(?)");
    for (const id of ids) add.run(id);
    db.exec(`
      WITH RECURSIVE kids(id) AS (
        SELECT t.id FROM tasks t JOIN purge_task_ids p ON t.parent_id = p.id
        UNION SELECT t.id FROM tasks t JOIN kids k ON t.parent_id = k.id
      )
      INSERT OR IGNORE INTO purge_task_ids(id) SELECT id FROM kids;
    `);
    const SET = "(SELECT id FROM purge_task_ids)";
    const PLANS = `(SELECT id FROM task_collaboration_plans WHERE task_id IN ${SET})`;
    // Разрыв кольца «подзадача ↔ план» — в обе стороны, включая чужие
    // подзадачи на этих планах и чужие шаги на этих подзадачах.
    db.exec(`UPDATE subtasks SET collaboration_plan_id = NULL WHERE task_id IN ${SET} OR collaboration_plan_id IN ${PLANS}`);
    db.exec(`UPDATE task_collaboration_plan_nodes SET source_subtask_id = NULL WHERE source_subtask_id IN (SELECT id FROM subtasks WHERE task_id IN ${SET})`);
    // Сначала удалить ноды и эджи планов задач из SET. Их AFTER-триггеры
    // tf_realtime_task_collaboration_plan_{nodes,edges}_DELETE (см.
    // lib/realtimeInvalidation.ts) берут task_id плана через подзапрос
    // (SELECT task_id FROM task_collaboration_plans WHERE id=ROW.plan_id).
    // Если сначала удалить сам план (следующий DELETE) — каскад снесёт
    // ноды/эджи и подзапрос вернёт NULL → COALESCE даст '', а две разные
    // таблицы для одного (topic,'') дают UNIQUE-конфликт в
    // tf_realtime_dirty. Удаляя ноды/эджи заранее, мы успеваем снять
    // dirty по реальному task_id плана, а сам план потом при своём DELETE
    // повторяет запись (она идемпотентна). Сценарий-источник — purge
    // grandchild с планом совместной работы в архивном дереве
    // (parent→child→grandchild), карточка 57c69735, P0 server 2026-10-09.
    db.exec(`DELETE FROM task_collaboration_plan_edges WHERE plan_id IN ${PLANS}`);
    db.exec(`DELETE FROM task_collaboration_plan_nodes WHERE plan_id IN ${PLANS}`);
    db.exec(`DELETE FROM task_collaboration_plans WHERE task_id IN ${SET}`);
    db.exec(`DELETE FROM consultation_log WHERE task_id IN ${SET} OR attempt_id IN (SELECT id FROM attempts WHERE task_id IN ${SET})`);
    for (const table of ["task_embeddings", "task_events", "notifications"]) {
      db.exec(`DELETE FROM ${table} WHERE task_id IN ${SET}`);
    }
    // Считаем до удаления: потомков уносит каскад, а он в changes не попадает.
    const removed = (db.prepare(`SELECT count(*) n FROM tasks WHERE id IN ${SET}`).get() as { n: number }).n;
    db.exec(`DELETE FROM tasks WHERE id IN ${SET}`);
    db.exec("DELETE FROM purge_task_ids");
    return removed;
  });
  return run(taskIds);
}
