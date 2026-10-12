import crypto from "node:crypto";
import db from "../db.js";
import { raiseIncident } from "./incidents.js";

// Deliberately no FK to tasks: statistical facts outlive task purge.
export const REVIEW_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_review_history (
 task_id TEXT PRIMARY KEY,
 submitted_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
 source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_review_history_date ON task_review_history(submitted_at);
CREATE TRIGGER IF NOT EXISTS review_history_event AFTER INSERT ON task_events
WHEN NEW.field='agent_state' AND NEW.to_value='review'
BEGIN
 INSERT INTO task_review_history(task_id,submitted_at) VALUES(NEW.task_id,NEW.created_at)
 ON CONFLICT(task_id) DO UPDATE SET submitted_at=excluded.submitted_at
 WHERE julianday(excluded.submitted_at)<julianday(task_review_history.submitted_at);
END;
CREATE TRIGGER IF NOT EXISTS review_history_state AFTER UPDATE OF agent_state ON tasks
WHEN NEW.agent_state='review' AND OLD.agent_state IS NOT 'review'
BEGIN
 INSERT OR IGNORE INTO task_review_history(task_id,submitted_at) VALUES(NEW.id,datetime('now'));
END;
CREATE TRIGGER IF NOT EXISTS review_history_insert AFTER INSERT ON tasks
WHEN NEW.agent_state='review'
BEGIN
 INSERT OR IGNORE INTO task_review_history(task_id,submitted_at) VALUES(NEW.id,datetime('now'));
END;
INSERT INTO task_review_history(task_id,submitted_at,source)
 SELECT task_id,MIN(created_at),'existing-events' FROM task_events
 WHERE field='agent_state' AND to_value='review' AND created_at IS NOT NULL
 GROUP BY task_id
 ON CONFLICT(task_id) DO UPDATE SET submitted_at=excluded.submitted_at
 WHERE julianday(excluded.submitted_at)<julianday(task_review_history.submitted_at);
`;
export function installReviewHistory() { db.exec(REVIEW_HISTORY_SCHEMA); }
export function readReviewHistory() {
 return db.prepare("SELECT task_id,submitted_at FROM task_review_history ORDER BY submitted_at,task_id").all();
}
export function checkReviewHistory(): {ok:boolean;reason?:string} {
 const complete=new Error("rollback successful probe");
 try {
  db.transaction(()=>{
   const id="review-history-probe-"+crypto.randomUUID();
   db.prepare("INSERT INTO tasks(id,title) VALUES(?,?)").run(id,"History probe");
   db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(id);
   const first=db.prepare("SELECT submitted_at FROM task_review_history WHERE task_id=?").get(id) as any;
   if(!first)throw new Error("Review transition not recorded");
   db.prepare("INSERT INTO task_events(id,task_id,kind,field,to_value) VALUES(?,?,'state_changed','agent_state','review')").run(crypto.randomUUID(),id);
   db.prepare("DELETE FROM task_events WHERE task_id=?").run(id);
   db.prepare("DELETE FROM tasks WHERE id=?").run(id);
   const count=(db.prepare("SELECT COUNT(*) n FROM task_review_history WHERE task_id=?").get(id) as any).n;
   if(count!==1)throw new Error("History lost or duplicated after purge");
   throw complete;
  })();
 } catch(e) { return e===complete?{ok:true}:{ok:false,reason:String((e as Error).message)}; }
 return {ok:false,reason:"Probe did not finish"};
}
export function startReviewHistoryWatcher() {
 const check=()=>{
  const result=checkReviewHistory();if(result.ok)return;
  raiseIncident({key:"review-history-alert",title:"История сдачи задач не сохраняется",description:
   "## Работа\nПроба записи review и удаления задачи не прошла: "+result.reason+
   "\nПроверить миграцию132_review_history, триггеры review_history_* и checkReviewHistory.\n## Результат\nСтатистика переживает удаление карточки.\n## Критерии приёмки\nПроба записи и удаления успешна; история не дублируется.\n## Границы\nНе возвращать удалённые задачи в работу."});
 };
 check();const timer=setInterval(check,15*60*1000);timer.unref();return()=>clearInterval(timer);
}
