import re

with open('/Volumes/Home-1/Проекты/New-Todoist/server/scripts/trigger.py', 'rb') as f:
    raw = f.read()

text = raw.decode('utf-8', errors='replace')

corrupted_pattern = r'max_runs = \(1 if reply_only else\s+MAX_def run_orchestrator.*?(?=\ndef wake_creator|\ndef catch_up)'

proper_run_external_and_orchestrator = r'''max_runs = (1 if reply_only else
                    MAX_RUNS_ORCHESTRATOR if agent.get("role") == "orchestrator"
                    else MAX_RUNS)
        for run in range(1, max_runs + 1):
            before = activity_mark(task_id)
            if run > 1:
                log(f"  зову «{agent['name']}» снова (заход {run} из {max_runs})")
                if claude_cli:
                    cmd = make_cmd(resume_text(get_task(task_id) or task),
                                   ["--resume", session_sid])
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                env=run_env,
                cwd=str(HOME) if claude_cli else str(HOME / "Проекты/New-Todoist"),
            )
            with LOCK:
                RUNNING[task_id] = (proc, assignee_id)
            box = {"proc": proc}
            hush = threading.Event()
            threading.Thread(
                target=silence_watch,
                args=(task_id, box, hush, agent["name"]),
                daemon=True,
            ).start()
            try:
                out, _ = proc.communicate(timeout=3600)
            finally:
                hush.set()
            tail = (out or "").strip()[-400:]
            log(f"  «{agent['name']}» закончил заход {run} (код {proc.returncode}): {tail}")
            spent = read_usage(usage_path)
            if spent:
                log(f"  расход захода: {spent}")
                note(task_id, f"Расход захода: {spent}", token=token)
            elif model and (flag or dsh_home):
                shown = model
                if dsh_home:
                    route = dsh_model_route(model)
                    if route:
                        shown = f"{route[1]} ({route[0]})"
                if run == 1:
                    note(task_id, f"Модель: {shown}", token=token)
            if reply_only:
                break
            if proc.returncode != 0:
                log(f"  «{agent['name']}» завершился с ошибкой (код {proc.returncode}) — цепочку останавливаю")
                break
            cont, why = should_continue(task_id, before)
            if not cont:
                log(f"  цепочку останавливаю: {why}")
                break
    finally:
        stop.set()
        with LOCK:
            RUNNING.pop(task_id, None)


def run_hermes(task: dict, reason: str, agent: dict) -> None:
    """Сначала живая сессия, и только если её нет — разовый заход."""
    if not wake_hermes(task, reason, agent):
        run_external(task, reason, agent)


def run_orchestrator(task: dict, reason: str, agent: dict) -> None:
    """Сначала бессмертная сессия, и только если её нет — разовый заход."""
    if agent.get("claude_cli") and wake_resident(task, reason, agent):
        return
    run_external(task, reason, agent)


def agent_id_of(agent: dict) -> str:
    """id учётки агента в TaskFlow по его записи в карте."""
    for uid, spec in EXTERNAL_AGENTS.items():
        if spec is agent:
            return uid
    return ""


# Нить «родитель-ребёнок».
CHILD_LINK = re.compile(r"координационной задачи\s*#?\s*([0-9a-fA-F-]{36})")


def parent_task_id(task: dict) -> str:
    """id координационной задачи, куском которой является эта, или пусто."""
    if task.get("parent_id"):
        return str(task["parent_id"])
    m = CHILD_LINK.search(task.get("description") or "")
    return m.group(1) if m else ""


def wake_parent(child: dict, owner_id: str) -> bool:
    """Ребёнок сдался — поднять оркестратора на ЕГО карточке. True, если разбудили."""
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
    return True


def handle_task(task_id: str, why: str, kind: str = "", actor_id: str = "",
                owner_id: str = "") -> None:
    """owner_id — чьё соединение принесло событие."""
    task = get_task(task_id)
    if not task:
        return

    # Если сдан ребёнок — будим Оркестратора на родительской карточке!
    if task.get("agent_state") in ("review", "blocked") and parent_task_id(task):
        if wake_parent(task, owner_id):
            return

    ok, reason = decide(task, kind, actor_id)
    if not ok:
        log(f"  {why}: {reason} — не берусь")
        return

    agent = EXTERNAL_AGENTS.get(task.get("assignee_id") or "")
    if agent and agent.get("role") == "orchestrator" and reason != REPLY_ONLY:
        threading.Thread(
            target=run_orchestrator, args=(task, reason, agent), daemon=True
        ).start()
    elif agent and agent.get("resident") and reason != REPLY_ONLY:
        threading.Thread(
            target=run_hermes, args=(task, reason, agent), daemon=True
        ).start()
    elif agent:
        threading.Thread(
            target=run_external, args=(task, reason, agent), daemon=True
        ).start()
    else:
        threading.Thread(target=run_claude, args=(task, reason), daemon=True).start()'''

text = re.sub(corrupted_pattern, lambda m: proper_run_external_and_orchestrator + "\n\n", text, flags=re.DOTALL)

with open('/Volumes/Home-1/Проекты/New-Todoist/server/scripts/trigger.py', 'wb') as f:
    f.write(text.encode('utf-8'))

print("Trigger fixed successfully!")
