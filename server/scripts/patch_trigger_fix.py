import re

file_path = "/Volumes/Home-1/Проекты/New-Todoist/server/scripts/trigger.py"
with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Fix run_orchestrator
old_ro = """def run_orchestrator(task: dict, reason: str, agent: dict) -> None:
    \"\"\"Сначала бессмертная сессия, и только если её нет — разовый заход.\"\"\"
    if not wake_resident(task, reason, agent):
        run_external(task, reason, agent)"""

new_ro = """def run_orchestrator(task: dict, reason: str, agent: dict) -> None:
    \"\"\"Сначала бессмертная сессия, и только если её нет — разовый заход.\"\"\"
    if agent.get("claude_cli") and wake_resident(task, reason, agent):
        return
    run_external(task, reason, agent)"""

if old_ro in content:
    content = content.replace(old_ro, new_ro)

# 2. Fix parent_task_id
old_ptid = """def parent_task_id(task: dict) -> str:
    \"\"\"id координационной задачи, куском которой является эта, или пусто.\"\"\"
    m = CHILD_LINK.search(task.get("description") or "")
    return m.group(1) if m else \"\""""

new_ptid = """def parent_task_id(task: dict) -> str:
    \"\"\"id координационной задачи, куском которой является эта, или пусто.\"\"\"
    if task.get("parent_id"):
        return str(task["parent_id"])
    m = CHILD_LINK.search(task.get("description") or "")
    return m.group(1) if m else \"\""""

if old_ptid in content:
    content = content.replace(old_ptid, new_ptid)

# 3. Fix wake_parent
old_wp_head = """def wake_parent(child: dict, owner_id: str) -> bool:
    \"\"\"Ребёнок сдался — поднять оркестратора на ЕГО карточке. True, если разбудили."""

# We redefine wake_parent to check parent_id properly
wake_parent_full = """def wake_parent(child: dict, owner_id: str) -> bool:
    \"\"\"Ребёнок сдался — поднять оркестратора на ЕГО карточке. True, если разбудили.\"\"\"
    state = child.get("agent_state")
    if state not in ("review", "blocked"):
        return False
    parent_id = parent_task_id(child)
    if not parent_id or parent_id == child.get("id"):
        return False
    parent = get_task(parent_id)
    if not parent:
        return False
    parent_assignee = parent.get("assignee_id")
    parent_agent = EXTERNAL_AGENTS.get(parent_assignee or "")
    if not parent_agent or parent_agent.get("role") != "orchestrator":
        return False

    what = "сдал работу на проверку" if state == "review" else "упёрся и ждёт решения"
    log(f"  ребёнок {str(child.get('id'))[:8]} {what} → бужу оркестратора на задаче {parent_id[:8]}")
    handle_task(parent_id, f"ребёнок «{child.get('title')}» {what}", kind="child_state_changed", owner_id=parent_assignee)
    return True"""

pattern_wp = r"def wake_parent\(child: dict, owner_id: str\) -> bool:.*?(?=\ndef wake_creator)"
content = re.sub(pattern_wp, wake_parent_full + "\n\n", content, flags=re.DOTALL)

# 4. Fix handle_task to call wake_parent
old_ht = """def handle_task(task_id: str, why: str, kind: str = "", actor_id: str = "",
                owner_id: str = "") -> None:
    \"\"\"owner_id — чьё соединение принесло событие. Нужен ровно для одного:
    отличить «пришло по МОЕЙ задаче» от «пришло по задаче, которую я создал».
    Второе — единственный сигнал оркестратору, что кусок работы готов.\"\"\"
    task = get_task(task_id)
    ok, reason = decide(task, kind, actor_id)"""

new_ht = """def handle_task(task_id: str, why: str, kind: str = "", actor_id: str = "",
                owner_id: str = "") -> None:
    \"\"\"owner_id — чьё соединение принесло событие.\"\"\"
    task = get_task(task_id)
    if not task:
        return

    # Если сдан ребёнок — будим Оркестратора на родительской карточке!
    if task.get("agent_state") in ("review", "blocked") and parent_task_id(task):
        if wake_parent(task, owner_id):
            return

    ok, reason = decide(task, kind, actor_id)"""

if old_ht in content:
    content = content.replace(old_ht, new_ht)

# 5. Fix _on_message to handle chat:new
old_on_msg = """    if kind != "notification:new":
        return"""

new_on_msg = """    if kind == "chat:new":
        message = event.get("message") or {}
        to_user_id = message.get("to_user_id")
        task_id = message.get("task_id")
        if task_id and to_user_id:
            agent = EXTERNAL_AGENTS.get(to_user_id)
            if agent and agent.get("role") == "orchestrator":
                log(f"  чат: новое сообщение для оркестратора по задаче {task_id[:8]} → бужу оркестратора")
                handle_task(task_id, f"чат от {message.get('from_user_name', 'агента')}", kind="chat", owner_id=to_user_id)
        return
    if kind != "notification:new":
        return"""

if old_on_msg in content:
    content = content.replace(old_on_msg, new_on_msg, 1)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patch applied successfully!")
