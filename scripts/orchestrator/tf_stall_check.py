#!/usr/bin/env python3
"""Контроль тихих зависаний шагов (правило 13.1): раз в 10 минут ищет шаги,
которые в `in_progress`/`todo`, а пульс старше порога, и шлёт сводку Максиму
в Telegram. Один раз на шаг (состояние в ~/.local/state/taskflow-stall.json).
Только чтение базы, ничего не чинит. `--dry` — не отправлять, только печатать."""
import json, os, sqlite3, subprocess, sys

DB = "/home/maksim/Проекты/New-Todoist/server/taskflow.db"
STATE = os.path.expanduser("~/.local/state/taskflow-stall.json")
SEND = os.path.expanduser("~/.claude/skills/notify-telegram/send.sh")
LIMIT_MIN = 15
dry = "--dry" in sys.argv

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
rows = db.execute(
    """SELECT s.id, substr(t.title,1,40), substr(s.title,1,40), s.agent_state,
              CAST((julianday('now')-julianday(COALESCE(s.agent_heartbeat_at,t.updated_at)))*1440 AS INT)
         FROM subtasks s JOIN tasks t ON t.id=s.task_id
        WHERE s.agent_state IN ('in_progress','todo') AND t.status='active'"""
).fetchall()
stale = [r for r in rows if r[4] is not None and r[4] >= LIMIT_MIN]
try:
    seen = json.load(open(STATE))
except Exception:
    seen = {}
new = [r for r in stale if seen.get(r[0]) != r[3]]
if not dry:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump({r[0]: r[3] for r in stale}, open(STATE, "w"))
if new:
    lines = [f"⚠️ TaskFlow: шаг без пульса ≥{LIMIT_MIN} мин"] + [
        f"• {r[1]} → {r[2]} ({r[3]}, {r[4]} мин)" for r in new[:8]
    ]
    if dry:
        print("\n".join(lines))
    else:
        subprocess.run(["bash", SEND, "\n".join(lines)], timeout=60)
print(f"идущих {len(rows)}, без пульса {len(stale)}, новых {len(new)}")
