import type Database from 'better-sqlite3';

/** TEMP outbox rolls back with writes; flush follows the synchronous transaction.
 * No timer or persistent migration. Covers route and worker writes alike. */
export function installRealtimeInvalidation(db: Database.Database, emit: (taskID: string, topic: string) => void) {
  let scheduled = false;
  // Без PRIMARY KEY намеренно. Это «грязный» набор, а не справочник: одна и
  // та же пара (topic, task_id) приходит из нескольких триггеров одного
  // каскадного DELETE, и PRIMARY KEY превращал совпадение в ошибку
  // SQLITE_CONSTRAINT_PRIMARYKEY, хотя вставки идут с OR IGNORE
  // (24.10.2026: DELETE /api/tasks/:id падал 500 «UNIQUE constraint failed:
  // tf_realtime_dirty.topic, tf_realtime_dirty.task_id» на карточке с планом
  // совместной работы). Дубли не нужны и не вредны: сброс ниже склеивает их
  // через SELECT DISTINCT и Map по `${topic}:${id}`.
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS tf_realtime_dirty(topic TEXT NOT NULL, task_id TEXT NOT NULL)`);
  db.function('tf_schedule_realtime', () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const rows = db.prepare('SELECT DISTINCT topic,task_id FROM temp.tf_realtime_dirty').all() as Array<{topic:string;task_id:string}>;
        db.prepare('DELETE FROM temp.tf_realtime_dirty').run();
        const events = new Map<string, {topic:string;taskID:string}>();
        for (const row of rows) {
          const ids = row.task_id ? db.prepare(`WITH RECURSIVE family(id,parent_id) AS (
            SELECT id,parent_id FROM tasks WHERE id=? UNION SELECT t.id,t.parent_id FROM tasks t JOIN family f ON t.id=f.parent_id
          ) SELECT id FROM family`).all(row.task_id) as Array<{id:string}> : [];
          for (const id of new Set([row.task_id,...ids.map(r=>r.id)])) events.set(`${row.topic}:${id}`,{topic:row.topic,taskID:id});
        }
        for (const e of events.values()) emit(e.taskID,e.topic);
      });
    }
    return 0;
  });
  const watched: Array<[string,string,string,string[]?]> = [
    ['tasks','id','task:changed',['updated_at','agent_heartbeat_at','agent_lease_until','composed_prompt_snapshot']],
    ['subtasks','task_id','task:changed',['updated_at','agent_heartbeat_at','lease_until']],
    ['task_events','task_id','task:changed'],
    ['comments','task_id','task:changed'],
    ['task_reports','task_id','task:changed'],
    ['task_preparation_jobs','task_id','task:changed',['updated_at','worker_id','lease_until']],
    ['task_collaboration_plans','task_id','task:changed',['updated_at']],
    ['task_collaboration_plan_nodes','(SELECT task_id FROM task_collaboration_plans WHERE id=ROW.plan_id)','task:changed'],
    ['task_collaboration_plan_edges','(SELECT task_id FROM task_collaboration_plans WHERE id=ROW.plan_id)','task:changed'],
    ['roles',"''",'roles:changed',['updated_at']],
    ['role_run_jobs','task_id','role-jobs:changed',['updated_at','lease_expires_at','lease_owner']],
  ];
  for (const [table,key,topic,excluded=[]] of watched) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;
    if (!columns.length) continue;
    const changed = columns.filter(c=>!excluded.includes(c.name)).map(c=>`OLD."${c.name}" IS NOT NEW."${c.name}"`).join(' OR ');
    // Когда ключ — это подзапрос к таблице, которая может быть удалена в той
    // же транзакции (например, task_collaboration_plan_nodes/edges →
    // task_collaboration_plans), перед записью в dirty проверяем, что
    // ссылочный план ещё существует. Иначе COALESCE(NULL,'') даёт ключ
    // (topic,''), и при каскадном удалении нод/эджей от разных таблиц
    // получается UNIQUE-конфликт в tf_realtime_dirty.
    //   Замечание лайф-тестировщика 2026-10-09 (карточка 57c69735, P0
    //   server): DELETE архивной карточки из дерева parent→child→
    //   grandchild падал на этом — purgeTasks удаляет план, каскад
    //   сносит ноды/эджи, и оба триггера пишут (task:changed,'').
    const isSubquery = key.startsWith('(') && key.includes('ROW.');
    for (const op of ['INSERT','UPDATE','DELETE']) {
      const row = op==='DELETE'?'OLD':'NEW';
      const expression = key==="''"?key:key.startsWith('(')?key.replaceAll('ROW.',`${row}.`):`${row}.${key}`;
      const parent = table==='tasks'?`INSERT OR IGNORE INTO tf_realtime_dirty VALUES ('${topic}', COALESCE(${row}.parent_id,''));`:'';
      // WHEN-условие для подзапросов: ссылочный plan_id должен указывать
      // на ещё живую запись task_collaboration_plans. На INSERT/DELETE
      // ключ ROW.plan_id не используется, условие не нужно; на UPDATE
      // — нужно, потому что plan_id мог измениться.
      const subqueryGuard =
        isSubquery && op === 'DELETE'
          ? `WHEN EXISTS (SELECT 1 FROM task_collaboration_plans WHERE id = OLD.plan_id) `
          : '';
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS tf_realtime_${table}_${op} AFTER ${op} ON main.${table}
        ${subqueryGuard}${op==='UPDATE'?`WHEN ${changed}`:''} BEGIN
          INSERT OR IGNORE INTO tf_realtime_dirty VALUES ('${topic}', COALESCE(${expression},''));
          ${parent}
          SELECT tf_schedule_realtime();
        END;`);
    }
  }
}
