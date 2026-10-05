import os,json,sys,time,urllib.request
T=os.environ["T"]; ids=sys.argv[1:]
A=T
def get(t):
    r=urllib.request.Request(f"http://localhost:3001/api/tasks/{t}",headers={"Authorization":"Bearer "+A})
    d=json.load(urllib.request.urlopen(r)); return d.get("task",d)
import datetime
STUCK={}
def stale(sub):
    st=sub.get("agent_state"); hb=sub.get("agent_heartbeat_at")
    if sub.get("done"): return False
    if st=="in_progress" and hb:
        age=(datetime.datetime.now(datetime.UTC).replace(tzinfo=None)-datetime.datetime.strptime(hb[:19],"%Y-%m-%d %H:%M:%S")).total_seconds()
        return age>600
    import sqlite3
    try:
        q=sqlite3.connect("file:/home/maksim/Проекты/New-Todoist/server/taskflow.db?mode=ro",uri=True).execute("select 1 from role_run_jobs where task_id=? and status in ('queued','running','retry_wait')",(sub.get("task_id"),)).fetchone()
        if q: STUCK.pop(sub["id"],None); return False
    except Exception: pass
    if st=="todo":
        k=sub["id"]; STUCK.setdefault(k,time.time()); return time.time()-STUCK[k]>600
    return False
def snap(t):
    x=get(t); subs=[(s.get("title","")[:40],"stuck" if stale(s) else (s.get("state") or s.get("status"))) for s in x.get("subtasks",[])]
    return x["title"][:60], x.get("agent_state"), x.get("blocked_reason"), subs
ME="6848a89b-04fe-4015-bb1c-61b03782c378"
def chatmsgs():
    out=[]
    r=urllib.request.Request("http://localhost:3001/api/chat?limit=30",headers={"Authorization":"Bearer "+T})
    d=json.load(urllib.request.urlopen(r)); d=d if isinstance(d,list) else d.get("messages",[])
    out+=[m for m in d if m.get("to_user_id")==ME]
    for t in ids:
        x=get(t)
        for c in x.get("chats",[]):
          try:
            r=urllib.request.Request(f"http://localhost:3001/api/chats/{c['id']}/messages",headers={"Authorization":"Bearer "+T})
            dd=json.load(urllib.request.urlopen(r)); dd=dd if isinstance(dd,list) else dd.get("messages",[])
            out+=[m for m in dd if m.get("from_user_id")!=ME and ("Оркестратор" in (m.get("text") or "") or m.get("to_user_id")==ME)]
          except Exception: pass
    return {m["id"]:m for m in out}
seen=set(chatmsgs())
prev={}
for t in ids:
    try: prev[t]=snap(t)
    except Exception: prev[t]=None
import sqlite3 as _sq
def jobs_running(t):
    try: return bool(_sq.connect("file:/home/maksim/Проекты/New-Todoist/server/taskflow.db?mode=ro",uri=True).execute("select 1 from role_run_jobs where task_id=? and status in ('queued','running','retry_wait')",(t,)).fetchone())
    except Exception: return None
was_running={t:jobs_running(t) for t in ids}
start=time.time(); down=0
while time.time()-start<6600:
    time.sleep(60)
    try:
        urllib.request.urlopen("http://localhost:3001/api/health",timeout=10); down=0
    except Exception as e:
        down+=1
        if down>=2: print("SERVER_DOWN", str(e)[:200]); sys.exit(0)
        continue
    try:
        new=[m for k,m in chatmsgs().items() if k not in seen]
        if new: print("CHAT",json.dumps([(m.get("from_user_id"),m.get("task_id"),(m.get("text") or "")[:400]) for m in new],ensure_ascii=False)); sys.exit(0)
    except Exception as e: pass
    for t in ids:
        jr=jobs_running(t)
        if was_running.get(t) and jr is False and not get(t).get("subtasks"):
            print("SINGLE_DONE",t); sys.exit(0)
        if jr is not None: was_running[t]=jr
    for t in ids:
        try: s=snap(t)
        except Exception as e: continue
        title,st,blk,subs=s
        states=[x[1] for x in subs]
        finished = subs and all(x=="done" for x in states)
        stuck = blk or st=="blocked" or any(x in ("blocked","failed","rework","stuck") for x in states)
        if finished or stuck:
            print("EVENT",t,json.dumps(s,ensure_ascii=False)); sys.exit(0)
        prev[t]=s
print("TIMEOUT")
