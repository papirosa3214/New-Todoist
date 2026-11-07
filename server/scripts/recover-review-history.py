#!/usr/bin/env python3
"""Recover only immutable review dates; never recreate tasks."""
import argparse,json,sqlite3,pathlib
parser=argparse.ArgumentParser()
parser.add_argument("--db",required=True)
parser.add_argument("--apply",action="store_true")
parser.add_argument("--report",required=True)
args=parser.parse_args()
root=pathlib.Path.home()/"Проекты/New-Todoist/server"
paths=set((root/"backups").rglob("*.db"))
paths.update((pathlib.Path.home()/"backups/taskflow").rglob("*.db"))
paths.update(pathlib.Path("/mnt/nas/backups/taskflow").glob("*/taskflow.db"))
facts={};errors=[];examined=[];old_ids=set()
for p in sorted(paths):
 try:
  c=sqlite3.connect("file:"+str(p)+"?mode=ro&immutable=1",uri=True)
  names={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
  if "tasks" not in names: c.close();continue
  old_ids.update(r[0] for r in c.execute("SELECT id FROM tasks"))
  if "task_events" in names:
   for id,date in c.execute("SELECT task_id,MIN(created_at) FROM task_events WHERE field=? AND to_value=? AND created_at IS NOT NULL GROUP BY task_id",("agent_state","review")):
    if date and (id not in facts or date<facts[id]["submitted_at"]):facts[id]={"task_id":id,"submitted_at":date,"source":str(p)}
  examined.append(str(p));c.close()
 except Exception as e:errors.append({"file":str(p),"error":str(e)})
live=sqlite3.connect(args.db,timeout=30)
ids={r[0] for r in live.execute("SELECT id FROM tasks")}
before=live.execute("SELECT COUNT(*) FROM task_review_history").fetchone()[0]
active_before=live.execute("SELECT COUNT(*) FROM tasks WHERE status=?",("active",)).fetchone()[0]
if args.apply:
 with live:
  for f in facts.values():
   live.execute("""INSERT INTO task_review_history(task_id,submitted_at,source) VALUES(?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET submitted_at=excluded.submitted_at,source=excluded.source
    WHERE julianday(excluded.submitted_at)<julianday(task_review_history.submitted_at)""",
    (f["task_id"],f["submitted_at"],"backup:"+f["source"]))
after=live.execute("SELECT COUNT(*) FROM task_review_history").fetchone()[0]
assert ids=={r[0] for r in live.execute("SELECT id FROM tasks")}
assert active_before==live.execute("SELECT COUNT(*) FROM tasks WHERE status=?",("active",)).fetchone()[0]
report={"apply":args.apply,"backups_examined":examined,"errors":errors,"known_deleted_tasks":len(old_ids-ids),
"backup_review_facts":len(facts),"deleted_tasks_with_review_facts":len(set(facts)-ids),
"ledger_before":before,"ledger_after":after,"active_before":active_before,"active_after":active_before,
"facts":list(facts.values())}
pathlib.Path(args.report).write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ("facts","backups_examined")},ensure_ascii=False))
