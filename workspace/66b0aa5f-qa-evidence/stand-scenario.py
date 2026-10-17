#!/usr/bin/env python3
"""QA-стенд карточки 66b0aa5f: план из трёх параллельных веток в копии живой базы."""
import json, sqlite3, sys, urllib.request, urllib.error

DB = "/tmp/66b0aa5f-qa/live-copy.db"
API = "http://127.0.0.1:4106"
TOKEN = open("/tmp/66b0aa5f-qa/token").read().strip()
TASK = open("/tmp/66b0aa5f-qa/task.id").read().strip()

def api(method, path, payload=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("User-Agent", "Mozilla/5.0 QA")
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
mode = sys.argv[1]

if mode == "seed":
    plan = "qa-plan-" + TASK[:8]
    db.execute(
        "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, rationale, created_by)"
        " VALUES (?, ?, 1, 'approved', 'manual', 'стенд QA', 'role_builder')", (plan, TASK))
    steps = {}
    for pos, (slot, role, title) in enumerate(
            [("build", "builder", "правка сервера"), ("analyze", "analyst", "разбор узких мест"),
             ("check", "qa", "проверка на стенде")], start=1):
        sid = "qa-step-%s-%s" % (slot, TASK[:8])
        db.execute("INSERT INTO subtasks (id, task_id, title, position, collaboration_plan_id, plan_node_key, done, admission_cycle)"
                   " VALUES (?, ?, ?, ?, ?, ?, 0, 1)", (sid, TASK, title, pos, plan, slot))
        db.execute("INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result)"
                   " VALUES (?, ?, ?, ?, 1, ?)", ("qa-node-%s-%s" % (slot, TASK[:8]), plan, slot, role, title))
        db.execute("UPDATE subtasks SET agent_id=? WHERE id=?", ("role_" + role, sid))
        steps[slot] = sid
    db.commit()
    json.dump(steps, open("/tmp/66b0aa5f-qa/steps.json", "w"))
    print("seeded", steps)
elif mode == "start":
    for slot, sid in steps.items() if False else json.load(open("/tmp/66b0aa5f-qa/steps.json")).items():
        print(slot, api("POST", "/api/subtasks/%s/work" % sid, {"state": "in_progress"}))
elif mode == "submit":
    for slot, sid in json.load(open("/tmp/66b0aa5f-qa/steps.json")).items():
        print(slot, api("PATCH", "/api/subtasks/%s" % sid, {"done": True, "result": "готово"}))
elif mode == "blocked":
    for slot, sid in json.load(open("/tmp/66b0aa5f-qa/steps.json")).items():
        print(slot, "block", api("POST", "/api/subtasks/%s/work" % sid, {"state": "blocked", "result": "жду стенд"}))
        print(slot, "block-again", api("POST", "/api/subtasks/%s/work" % sid, {"state": "blocked", "result": "жду стенд"}))
elif mode == "undo-redo":
    sid = json.load(open("/tmp/66b0aa5f-qa/steps.json"))["build"]
    print("release", api("POST", "/api/subtasks/%s/work" % sid, {"state": "in_progress"}))
    print("undo", api("PATCH", "/api/subtasks/%s" % sid, {"done": False}))
    print("redo", api("PATCH", "/api/subtasks/%s" % sid, {"done": True, "result": "вторая попытка"}))
elif mode == "repeat-all":
    for slot, sid in json.load(open("/tmp/66b0aa5f-qa/steps.json")).items():
        api("POST", "/api/subtasks/%s/work" % sid, {"state": "in_progress"})
        api("PATCH", "/api/subtasks/%s" % sid, {"done": True, "result": "готово"})
    print("повторы прогнаны")
elif mode == "dump":
    rows = db.execute("SELECT m.rowid, m.text, m.message_type, m.from_user_id FROM chat_messages m"
                      " JOIN chats c ON c.id=m.chat_id WHERE m.task_id=? AND c.parent_chat_id IS NOT NULL ORDER BY m.rowid", (TASK,)).fetchall()
    for r in rows:
        print("%3d | %-7s | %-18s | %s" % (r["rowid"], r["message_type"] or "-", r["from_user_id"], r["text"]))
    print("--- строк в общем чате chat-common по этой карточке:",
          db.execute("SELECT COUNT(*) c FROM chat_messages WHERE chat_id='chat-common' AND task_id=?", (TASK,)).fetchone()["c"])
    print("--- дедупликатор:")
    for r in db.execute("SELECT subtask_id, notice_key, message_id FROM step_topic_progress WHERE subtask_id LIKE ? ORDER BY subtask_id, notice_key", ("qa-step-%" + TASK[:8],)):
        print("   ", r["subtask_id"], r["notice_key"], (r["message_id"] or "")[:8])
