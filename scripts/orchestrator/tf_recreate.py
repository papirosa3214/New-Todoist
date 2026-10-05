# usage: tf_recreate.py OLD_ID PARENT_ID roles_json   (A=agent, O=orchestrator)
import os,json,sys,sqlite3,subprocess,urllib.request,urllib.error
B="http://localhost:3001"
def req(tok,m,p,body=None):
    h={"Authorization":"Bearer "+tok}
    if body is not None: h["Content-Type"]="application/json"
    r=urllib.request.Request(B+p,method=m,headers=h,data=json.dumps(body).encode() if body is not None else None)
    try: return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e: return {"error":e.code,"body":e.read().decode()[:300]}
old,parent,roles=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])
db=sqlite3.connect("file:/home/maksim/Проекты/New-Todoist/server/taskflow.db?mode=ro",uri=True)
t=db.execute("select title,description,priority,project_id from tasks where id=?",(old,)).fetchone()
busy=db.execute("select count(*) from role_run_jobs where task_id=? and status in ('queued','running','retry_wait')",(old,)).fetchone()[0]+db.execute("select count(*) from subtasks where task_id=? and agent_state in ('in_progress','todo')",(old,)).fetchone()[0]
if busy: print("OLD BUSY, skip",old[:8]); sys.exit(1)
desc=t[1]+"\n\nРабота и тесты — только в своём worktree; основную копию `~/Проекты/New-Todoist` не трогать, `git stash` не использовать; результат — коммитом в своей ветке; файлы удалять только в Корзину (`gio trash`)."
spec={"title":t[0],"description":desc,"priority":t[2] or 2,"roles":roles}
json.dump(spec,open("/tmp/orch_spec_re.json","w"),ensure_ascii=False)
out=subprocess.run(["python3","/home/maksim/Проекты/New-Todoist/scripts/orchestrator/tf_launch.py","/tmp/orch_spec_re.json"],capture_output=True,text=True).stdout.strip(); print(out)
new=out.split()[1] if out.startswith("OK") else None
if not new: sys.exit(1)
print("parent",req(os.environ["A"],"PATCH",f"/api/tasks/{new}",{"parent_id":parent}).get("error","ok"))
print("delete old",req(os.environ["A"],"DELETE",f"/api/tasks/{old}"))
