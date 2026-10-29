#!/usr/bin/env python3
"""TaskFlow event journal -> durable delivery queue -> ordinary Apple Reminders."""
import argparse
import datetime
import fcntl
import json
import logging
import os
from pathlib import Path
import sqlite3
import time
from client import send

LOG=logging.getLogger("taskflow.apple")
BLOCKS={"subtask_blocked","review_run_blocked","plan_subtask_stalled_blocked",
        "test_budget_blocked","dependency_context_blocked","stalled_step_blocked"}

def event_notice(row):
    kind=row.get("kind"); value=row.get("to_value"); field=row.get("field")
    label=None
    if kind=="state_changed" and field=="agent_state":
        label={"blocked":"Задача заблокирована","review":"Задача сдана на проверку"}.get(value)
    elif kind=="state_changed" and field=="status" and value=="completed":
        label="Задача выполнена"
    elif kind in BLOCKS:
        label="Задача заблокирована"
    elif kind=="step_outcome":
        try:
            if json.loads(value or "{}").get("outcome")=="blocked":
                label="Задача заблокирована"
        except (ValueError,AttributeError):
            pass
    elif kind=="orchestrator_woken":
        label="Заминки — проснулся оркестратор"
    if not label:
        return None
    title=row.get("title") or row["task_id"]
    notes=f'{row.get("actor") or "TaskFlow"}: {title}\n{value or ""}\nЗадача: {row["task_id"]}'
    return dict(key="event:"+row["id"],mode="normal",title=(label+": "+title)[:200],notes=notes[:3900])

def collect(source,since):
    notices=[]
    for row in source.execute("""
       SELECT e.*,t.title,coalesce(u.name,'TaskFlow') AS actor
       FROM task_events e JOIN tasks t ON t.id=e.task_id
       LEFT JOIN users u ON u.id=e.actor_id
       WHERE e.created_at>=? AND coalesce(t.service_hidden,0)=0
       AND e.kind IN ('state_changed','subtask_blocked','review_run_blocked',
       'plan_subtask_stalled_blocked','test_budget_blocked','dependency_context_blocked',
       'stalled_step_blocked','step_outcome','orchestrator_woken')
       ORDER BY e.created_at,e.id
    """,(since,)):
        n=event_notice(dict(row))
        if n:
            notices.append(n)
    for row in source.execute("""
        SELECT q.*,u.name AS role_name FROM chat_questions q
        LEFT JOIN users u ON u.id=q.role_id WHERE q.created_at>=?
    """,(since,)):
        payload=json.loads(row["payload_json"])
        text="\n".join(str(q.get("question","")) for q in payload.get("questions",[]))
        notice=dict(key="question:"+row["id"],mode="urgent",
            title=("Нужен твой ответ: "+(row["role_name"] or "роль"))[:200],
            notes=(text+"\nОткрой вопрос в TaskFlow. Чат: "+row["chat_id"])[:3900])
        if row["status"]!="open":
            notice.update(queue_key="question-resolved:"+row["id"],operation="complete")
        notices.append(notice)
    return notices

def open_state(path,started):
    state=sqlite3.connect(path)
    state.execute("create table if not exists settings(key text primary key,value text not null)")
    state.execute("""create table if not exists outbox(
        key text primary key,payload text not null,delivered integer not null default 0,
        attempts integer not null default 0,next_attempt real not null default 0,
        last_error text,result text)""")
    state.execute("insert or ignore into settings values('started',?)",(started,))
    # Probe real persistence rather than only checking that the file exists.
    state.execute("insert or replace into settings values('probe','ok')")
    assert state.execute("select value from settings where key='probe'").fetchone()[0]=="ok"
    state.commit()
    return state

def enqueue(state,notices):
    for n in notices:
        if n.get("operation")=="complete":
            state.execute("update outbox set delivered=2 where key=? and delivered=0",(n["key"],))
        state.execute("insert or ignore into outbox(key,payload) values(?,?)",(n.get("queue_key",n["key"]),json.dumps(n,ensure_ascii=False)))
    state.commit()

def deliver(state,now):
    for key,payload,attempts in state.execute(
        "select key,payload,attempts from outbox where delivered=0 and next_attempt<=? order by rowid limit 10",(now,)).fetchall():
        try:
            result=send(json.loads(payload))
            state.execute("update outbox set delivered=1,result=?,last_error=null where key=?",(json.dumps(result),key))
            LOG.info("Delivered %s",key)
        except Exception as error:
            retry=now+min(300,15*2**min(attempts,5))
            state.execute("update outbox set attempts=attempts+1,next_attempt=?,last_error=? where key=?",
                          (retry,str(error)[:1000],key))
            LOG.warning("Pending %s: %s",key,error)
            state.commit()
            break
        state.commit()

def health(state,task_db,folder,now):
    # Local state probe every loop plus a heartbeat for systemd/operator checks.
    state.execute("insert or replace into settings values('heartbeat',?)",(str(now),))
    state.commit()
    temporary=folder/"heartbeat.tmp"
    temporary.write_text(str(now));temporary.replace(folder/"heartbeat")
    failed=state.execute("select count(*) from outbox where delivered=0 and attempts>=3").fetchone()[0]
    if not failed:
        return
    alert(state,task_db,f"Apple-уведомления не доставлены: {failed}. Mac недоступен или не создал напоминание. Очередь сохранена; проверь журнал taskflow-apple-reminders.service.",now)

def alert(state,task_db,message,now):
    last=state.execute("select value from settings where key='last_alert'").fetchone()
    if last and now-float(last[0])<86400:
        return
    # The owner must hear about broken delivery through TaskFlow itself.
    import uuid
    with sqlite3.connect(task_db,timeout=5) as db:
        owner=db.execute("select id from users where role='owner' order by created_at limit 1").fetchone()
        if owner:
            db.execute("insert into notifications(id,user_id,type,text) values(?,?,?,?)",
                (str(uuid.uuid4()),owner[0],"apple_reminders_delivery_failed",
                 message[:1000]))
    state.execute("insert or replace into settings values('last_alert',?)",(str(now),));state.commit()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--db",required=True)
    parser.add_argument("--state",default=str(Path.home()/".local/state/taskflow-apple-reminders"))
    parser.add_argument("--once",action="store_true")
    args=parser.parse_args()
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s")
    folder=Path(args.state);folder.mkdir(parents=True,exist_ok=True)
    with (folder/"worker.lock").open("w") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        started=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        state=open_state(folder/"queue.db",started)
        since=state.execute("select value from settings where key='started'").fetchone()[0]
        while True:
            try:
                source=sqlite3.connect(Path(args.db).resolve().as_uri()+"?mode=ro",uri=True,timeout=5)
                source.row_factory=sqlite3.Row
                try:
                    enqueue(state,collect(source,since))
                finally:
                    source.close()
                deliver(state,time.time())
                health(state,args.db,folder,time.time())
            except Exception as error:
                LOG.exception("Delivery loop failed; will retry")
                try:
                    alert(state,args.db,"Не работает обработчик Apple-уведомлений: "+str(error)[:500],time.time())
                except Exception:
                    LOG.exception("Could not alert owner")
                if args.once:
                    raise
            if args.once:
                break
            time.sleep(10)
if __name__=="__main__":
    main()
