import crypto from "node:crypto";
import db from "../db.js";
import { logEvent } from "../agentState.js";
import { raiseIncident, openIncidentTaskId } from "./incidents.js";
import { reinstallTaskChangesLedger } from "./taskChanges.js";

// Deliberately no FK to tasks: statistical facts outlive task purge.
export const REVIEW_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_review_history (
 task_id TEXT PRIMARY KEY,
 submitted_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
 source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_review_history_date ON task_review_history(submitted_at);
INSERT INTO task_review_history(task_id,submitted_at,source)
 SELECT task_id,MIN(created_at),'existing-events' FROM task_events
 WHERE field='agent_state' AND to_value='review' AND created_at IS NOT NULL
 GROUP BY task_id
 ON CONFLICT(task_id) DO UPDATE SET submitted_at=excluded.submitted_at
 WHERE julianday(excluded.submitted_at)<julianday(task_review_history.submitted_at);
`;

// Триггеры ПЕРЕСОЗДАЁМ, а не «создаём, если нет»: CREATE TRIGGER IF NOT EXISTS
// не заменяет уже лежащее в базе определение — старое пережило бы правку кода
// навсегда. Ровно эта ловушка стоила пробы истории 25.10 (карточка
// 2e1e0988): сборка d96358f9 (журнал изменений) ставила условие «колонка
// изменилась» и на INSERT-триггеры, где строки OLD нет, — любая вставка в
// task_events падала с «no such column: OLD.id», и проба истории не могла
// пройти. Та же ошибка теперь названа своим шагом, а триггеры лечатся
// переустановкой (см. repairReviewHistoryTriggers).
export const REVIEW_HISTORY_TRIGGERS = `
DROP TRIGGER IF EXISTS review_history_event;
DROP TRIGGER IF EXISTS review_history_state;
DROP TRIGGER IF EXISTS review_history_insert;
CREATE TRIGGER review_history_event AFTER INSERT ON task_events
WHEN NEW.field='agent_state' AND NEW.to_value='review'
BEGIN
 INSERT INTO task_review_history(task_id,submitted_at) VALUES(NEW.task_id,NEW.created_at)
 ON CONFLICT(task_id) DO UPDATE SET submitted_at=excluded.submitted_at
 WHERE julianday(excluded.submitted_at)<julianday(task_review_history.submitted_at);
END;
CREATE TRIGGER review_history_state AFTER UPDATE OF agent_state ON tasks
WHEN NEW.agent_state='review' AND OLD.agent_state IS NOT 'review'
BEGIN
 INSERT OR IGNORE INTO task_review_history(task_id,submitted_at) VALUES(NEW.id,datetime('now'));
END;
CREATE TRIGGER review_history_insert AFTER INSERT ON tasks
WHEN NEW.agent_state='review'
BEGIN
 INSERT OR IGNORE INTO task_review_history(task_id,submitted_at) VALUES(NEW.id,datetime('now'));
END;
`;

export function installReviewHistory() { db.exec(REVIEW_HISTORY_SCHEMA); db.exec(REVIEW_HISTORY_TRIGGERS); }

/** Только триггеры: дёшево, можно на каждой выкладке и в самолечении. */
export function ensureReviewHistoryTriggers() { db.exec(REVIEW_HISTORY_TRIGGERS); }

/**
 * Переустановить оба набора триггеров, которые умеют сломать пробу:
 * свой (история сдачи) и журнала изменений. Второй — тот самый случай 25.10,
 * поэтому чинить надо оба.
 */
export function repairReviewHistoryTriggers() {
 ensureReviewHistoryTriggers();
 reinstallTaskChangesLedger();
}

export function readReviewHistory() {
 return db.prepare("SELECT task_id,submitted_at FROM task_review_history ORDER BY submitted_at,task_id").all();
}

/**
 * Проба: записать карточку, сдать её на проверку, повторить событие, удалить
 * событие и карточку — и убедиться, что остался ровно один факт.
 * Откат транзакции возвращает базу в исходное состояние.
 * В ответе — шаг, на котором сломалось: без него тревога приходит с голым
 * «no such column: OLD.id» и не говорит, что именно чинить.
 */
export function checkReviewHistory(): {ok:boolean;reason?:string;step?:string} {
 const complete=new Error("rollback successful probe");
 let step="";
 try {
  db.transaction(()=>{
   const id="review-history-probe-"+crypto.randomUUID();
   step="создание карточки";
   db.prepare("INSERT INTO tasks(id,title) VALUES(?,?)").run(id,"History probe");
   step="переход карточки в review";
   db.prepare("UPDATE tasks SET agent_state='review' WHERE id=?").run(id);
   step="проверка записи факта";
   const first=db.prepare("SELECT submitted_at FROM task_review_history WHERE task_id=?").get(id) as any;
   if(!first)throw new Error("Review transition not recorded");
   step="повторная запись события";
   db.prepare("INSERT INTO task_events(id,task_id,kind,field,to_value) VALUES(?,?,'state_changed','agent_state','review')").run(crypto.randomUUID(),id);
   step="удаление события";
   db.prepare("DELETE FROM task_events WHERE task_id=?").run(id);
   step="удаление карточки";
   db.prepare("DELETE FROM tasks WHERE id=?").run(id);
   step="проверка единственной записи";
   const count=(db.prepare("SELECT COUNT(*) n FROM task_review_history WHERE task_id=?").get(id) as any).n;
   if(count!==1)throw new Error("History lost or duplicated after purge");
   throw complete;
  })();
 } catch(e) {
  if(e===complete)return {ok:true};
  return {ok:false,reason:`шаг «${step}»: ${String((e as Error).message)}`,step};
 }
 return {ok:false,reason:"Probe did not finish"};
}

/**
 * Сторож: проба при старте и каждые 15 минут.
 * 1. Триггеры приводятся к коду (старое определение из базы могло пережить
 *    правку — ловушка 25.10).
 * 2. Если проба не прошла — триггеры переустанавливаются и проба повторяется:
 *    частая поломка лечится сама, тревога не поднимается зря.
 * 3. Результат каждой пробы пишется в журнал сервера: по нему видно, что
 *    сторож жив, даже когда тревоги нет.
 * 4. Когда поломка ушла, а карточка инцидента ещё открыта — в неё пишется
 *    событие «проба снова проходит». Раньше карточка висела пять дней:
 *    поломку починили, а карточку закрыть было некому (25.10 → 30.10).
 */
export function startReviewHistoryWatcher() {
 const noteRecovery=(taskId:string)=>{
  try{
   const seen=db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='review_history_recovered' LIMIT 1").get(taskId);
   if(seen)return;
   logEvent({taskId,actorId:null,kind:"review_history_recovered",field:"review_history",
    toValue:"Проба записи и удаления снова проходит — поломка ушла, карточку можно закрыть"});
  }catch{/* лента — по возможности */}
 };
 const check=()=>{
  let result=checkReviewHistory();
  if(!result.ok){
   try{ repairReviewHistoryTriggers(); }
   catch(e){ console.error(`[review-history] триггеры не пересоздались: ${String((e as Error).message)}`); }
   result=checkReviewHistory();
  }
  if(result.ok){
   console.log("[review-history] проба записи и удаления проходит");
   const card=openIncidentTaskId("review-history-alert");
   if(card)noteRecovery(card);
   return;
  }
  console.error(`[review-history] проба не прошла — ${result.reason}`);
  raiseIncident({key:"review-history-alert",title:"История сдачи задач не сохраняется",description:
   "## Работа\nПроба записи review и удаления задачи не прошла: "+result.reason+
   "\nПроверить миграцию132_review_history, триггеры review_history_* и checkReviewHistory."+
   "\n## Результат\nСтатистика переживает удаление карточки."+
   "\n## Критерии приёмки\nПроба записи и удаления успешна; история не дублируется."+
   "\n## Границы\nНе возвращать удалённые задачи в работу."});
 };
 try{ ensureReviewHistoryTriggers(); }
 catch(e){ console.error(`[review-history] триггеры не пересоздались при старте: ${String((e as Error).message)}`); }
 check();
 const timer=setInterval(check,15*60*1000);timer.unref();return()=>clearInterval(timer);
}
