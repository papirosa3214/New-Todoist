#!/usr/bin/env python3
"""Будильник TaskFlow: доска сама зовёт Клода в работу.

Тот же смысл, что у kaneo-trigger, но без вебхуков — TaskFlow уже отдаёт
живой поток событий по WebSocket, а уведомления вдобавок хранятся в базе.
Это надёжнее вебхука: пока служба лежала, события не потерялись — при старте
она добирает непрочитанные уведомления и разбирает их.

Что делает:
  1. Держит WebSocket агентским токеном. Пока сокет открыт, Клод показан
     «онлайн» на экране агентов (server/src/ws.ts) — отдельного пинга не надо.
  2. Ловит notification:new (назначение задачи, комментарий).
  3. Решает, повод ли это (см. decide) и запускает `claude -p` по задаче.
  4. Пока Клод работает, задача живёт по AGENT-PROTOCOL.md: claim →
     heartbeat → review. Аренду продлевает эта же служба, чтобы работа не
     помечалась брошенной, пока процесс жив.

Токен приходит в окружении (TASKFLOW_TOKEN) — служба запускается через
vault-run.py, значение нигде не печатается и на диске не лежит.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import websocket  # websocket-client

API = os.environ.get("TASKFLOW_API", "http://localhost:3001")
WS_URL = API.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
TOKEN = os.environ.get("TASKFLOW_TOKEN", "").strip()
HOME = Path.home()
CLAUDE_BIN = str(HOME / ".npm-global/bin/claude")
STATE_DIR = HOME / ".local/state/taskflow-trigger"
LOG_FILE = STATE_DIR / "trigger.log"

ME = "u2"        # Claude_Bot
OWNER = "u1"     # Максим
HEARTBEAT_SEC = 90    # аренда живёт 5 минут — сигнал втрое чаще, с запасом
                      # на пару пропущенных подряд (сеть, занятый сервер)
# Сколько ждать, пока занятая сессия освободится, прежде чем работать
# форком. Ход агента редко длится дольше пары минут; ждать бесконечно
# нельзя — задача повиснет молча.
BUSY_WAIT_SEC = 8 * 60
BUSY_POLL_SEC = 15
PROJECTS_DIR = HOME / ".claude/projects"
RUNNING: dict[str, subprocess.Popen] = {}
LOCK = threading.Lock()


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with LOG_FILE.open("a") as f:
        f.write(line + "\n")


def api(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        log(f"  API {method} {path} → {e.code}: {e.read().decode()[:160]}")
        return None
    except Exception as e:  # сеть/таймаут — не роняем службу
        log(f"  API {method} {path} → {e}")
        return None


def get_task(task_id: str):
    d = api("GET", f"/api/tasks/{task_id}")
    if not d:
        return None
    return d.get("task", d)


def decide(task: dict) -> tuple[bool, str]:
    """Браться ли за задачу. Тумблер тот же, что у Максима на доске Kaneo:
    явное назначение агента исполнителем и есть «этой задачей заниматься
    можно». Без назначения служба молчит, что бы в задаче ни происходило."""
    if not task:
        return False, "задачи нет"
    if task.get("assignee_id") != ME:
        return False, "исполнитель не я"
    if task.get("status") != "active":
        return False, "задача не активна"
    state = task.get("agent_state")
    if state == "in_progress":
        return False, "уже в работе"
    if state == "review":
        return False, "ждёт проверки владельца"
    if state == "blocked":
        return False, "заблокирована, ждёт владельца"
    return True, "назначена на меня"


def live_sessions() -> dict:
    """Живые сессии Claude Code: {session_id: "busy"|"idle"|...}.

    `claude agents --json` для того и сделан — печатает и интерактивные, и
    фоновые сессии без TTY. Пусто (или сбой) — считаем, что живых нет:
    для нас это лишь подсказка «занята ли», а не источник истины о том,
    существует ли сессия вообще (та живёт транскриптом на диске).
    """
    try:
        out = subprocess.run(
            [CLAUDE_BIN, "agents", "--json"],
            capture_output=True, text=True, timeout=30,
        )
        items = json.loads(out.stdout or "[]")
    except Exception as e:
        log(f"  не смог получить список сессий: {e}")
        return {}
    return {
        it.get("sessionId"): (it.get("status") or it.get("state") or "unknown")
        for it in items if it.get("sessionId")
    }


def transcript_exists(session_id: str) -> bool:
    """Сессию можно продолжить, пока цел её транскрипт — даже если процесса
    давно нет. Имя файла = <session_id>.jsonl, папка зависит от каталога,
    в котором сессия работала, поэтому ищем по всем проектам."""
    if not session_id:
        return False
    return any(PROJECTS_DIR.glob(f"**/{session_id}.jsonl"))


def wait_until_free(session_id: str) -> str:
    """Дождаться, пока сессия перестанет быть занятой.

    Перебить чужой ход невозможно: процесс досчитает начатое. Поэтому
    «будильник главнее» реализуется ожиданием, а не насилием — и только
    если сессия не освободилась за BUSY_WAIT_SEC, заход уходит в форк
    (там свой номер, оригинал не трогается: два процесса на одном номере
    писали бы в один транскрипт).
    """
    waited = 0
    while waited < BUSY_WAIT_SEC:
        status = live_sessions().get(session_id)
        if status != "busy":
            return status or "нет живого процесса"
        time.sleep(BUSY_POLL_SEC)
        waited += BUSY_POLL_SEC
        if waited % 60 == 0:
            log(f"  сессия {session_id[:8]} всё ещё занята, жду ({waited // 60} мин)")
    return "busy"


def build_resume_prompt(task: dict, reason: str) -> str:
    """Промпт для ПРОДОЛЖЕНИЯ своей же сессии: она помнит и задачу, и что
    уже сделано, поэтому пересказывать карточку целиком не нужно — нужен
    только повод и свежая лента."""
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}"
        for c in (task.get("comments") or [])[-3:]
    )
    return f"""Доска TaskFlow снова зовёт по задаче «{task.get('title')}»: {reason}.

Это та же задача, над которой ты уже работал в этой сессии — контекст у
тебя есть, начинать заново не нужно.

Свежее в ленте:
{comments or '  (пусто)'}

Задача уже взята в работу службой, аренду продлевает она же. Закончил —
review с комментарием; упёрся — blocked с объяснением. Задачу #{task.get('id')}
принимает только Максим.
"""


def build_prompt(task: dict, reason: str) -> str:
    subtasks = task.get("subtasks") or []
    steps = "\n".join(
        f"  {'[x]' if s.get('done') else '[ ]'} {s.get('title')}" for s in subtasks
    )
    comments = "\n".join(
        f"  {c.get('user_name')}: {c.get('text')}" for c in (task.get("comments") or [])[-8:]
    )
    return f"""Тебя разбудила доска TaskFlow: {reason}.

ЗАДАЧА #{task.get('id')}
Название: {task.get('title')}
Описание:
{task.get('description') or '(пусто)'}

Шаги:
{steps or '  (нет)'}

Лента (последние комментарии):
{comments or '  (пусто)'}

КАК РАБОТАТЬ (конвейер снизу вверх, AGENT-PROTOCOL.md проекта ~/Проекты/New-Todoist,
кратко — скилл taskflow-work): задачу уже взяли в работу за тебя (claim сделан
службой), аренду тоже продлевает служба — heartbeat слать не нужно. У тебя
подключён MCP-сервер taskflow — работай его инструментами, не сырым API.

- ПЕРЕД тем как коснуться шага — taskflow_subtask_work(state="in_progress").
  Это включает анимацию у шага в ленте — Максим должен видеть, какой шаг идёт.
- Сделал шаг → taskflow_subtask_work(state="review", result="…") — одно-два
  предложения по-человечески, что было и что стало, без жаргона.
- Упёрся на шаге → taskflow_subtask_work(state="blocked", result="…") —
  конкретно, что мешает и какого действия ждёшь.
- ⛔ Галочку done на подзадаче НЕ ставь сам — сервер вернёт 403, это приёмка
  только Максима.
- Все шаги сданы (или шагов не было) → taskflow_state(review, comment="…").
  Не можешь продолжить вообще → taskflow_state(blocked, comment="…"). Никогда
  не оставляй задачу в in_progress, уходя.
- Принять задачу (completed) может только Максим. Сам не принимай.
- Стоп-линия: прод, удаление данных, деньги, действия наружу — не делай
  сам, опиши в комментарии и уйди в blocked.
- Инструментов taskflow_* нет в списке (MCP не переподключился) → не городи
  обход сырым curl, сразу уйди в blocked с этой же причиной — тебя спросить
  некому, ты один.
"""


def heartbeat_loop(task_id: str, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_SEC):
        api("POST", f"/api/tasks/{task_id}/heartbeat", {})


def run_claude(task: dict, reason: str) -> None:
    task_id = task["id"]
    # Сухой прогон (TASKFLOW_TRIGGER_DRY=1): проверить, что служба видит
    # события и правильно решает, кого будить, — не запуская настоящего
    # Клода и ничего не меняя в задаче. Нужен, когда над той же задачей уже
    # идёт живая сессия: два агента на одной карточке — гарантированная каша.
    with LOCK:
        if task_id in RUNNING:
            log(f"  задача {task_id[:8]} уже выполняется — пропускаю")
            return
        RUNNING[task_id] = None  # место занято до старта процесса
    # Проверка стоит ПОСЛЕ занятия слота, чтобы сухой прогон показывал ту же
    # дедупликацию, что и боевой режим: два уведомления по одной задаче дают
    # один заход, а не два.
    if os.environ.get("TASKFLOW_TRIGGER_DRY") == "1":
        log(f"[сухой прогон] взялся бы за «{task.get('title')}» ({reason})")
        return

    # Куда возвращаться: номер прошлой сессии по этой задаче. Читаем ДО
    # claim — claim перезаписывает agent_session_id тем, что пришло в теле
    # (пустое тело обнулило бы его), поэтому ниже отдаём номер обратно.
    prev_sid = (task.get("agent_session_id") or "").strip()
    resume_sid = prev_sid if transcript_exists(prev_sid) else ""
    fork = False

    if resume_sid:
        status = live_sessions().get(resume_sid)
        if status == "busy":
            log(f"  сессия {resume_sid[:8]} занята — жду, пока освободится")
            if wait_until_free(resume_sid) == "busy":
                # Не дождались: работаем форком, чтобы не писать вторым
                # процессом в тот же транскрипт. Контекст сохраняется,
                # номер будет новый.
                fork = True
                log(f"  сессия {resume_sid[:8]} так и занята — иду форком")
    else:
        # Сессии нет (никогда не было или транскрипт не сохранился) —
        # честная пометка в ленту, чтобы это не выглядело как «агент забыл
        # всё, что обсуждали», и новый номер, заданный нами: тогда
        # следующий заход будет куда возвращаться.
        if prev_sid:
            note = (f"Прежней сессии {prev_sid[:8]}… больше нет на диске — "
                    "начинаю с чистого листа, помню только то, что записано в карточке.")
        else:
            note = ("По этой задаче ещё не было сессии агента — начинаю с чистого листа, "
                    "помню только то, что записано в карточке.")
        api("POST", f"/api/tasks/{task_id}/comments", {"text": note})

    new_sid = str(uuid.uuid4()) if not resume_sid or fork else resume_sid

    # Номер сессии уходит в claim — карточка всегда знает, куда возвращаться.
    claimed = api("POST", f"/api/tasks/{task_id}/claim",
                  {"session_id": new_sid if (not resume_sid or fork) else resume_sid})
    if claimed is None:
        log(f"  не удалось взять задачу {task_id[:8]} в работу — отменяю заход")
        with LOCK:
            RUNNING.pop(task_id, None)
        return

    log(f"→ берусь за «{task.get('title')}» ({reason})")
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(task_id, stop), daemon=True).start()

    if resume_sid and not fork:
        log(f"  продолжаю сессию {resume_sid[:8]} — контекст на месте")
        cmd = [
            CLAUDE_BIN, "-p", build_resume_prompt(task, reason),
            "--resume", resume_sid,
            "--permission-mode", "bypassPermissions",
        ]
    elif resume_sid and fork:
        cmd = [
            CLAUDE_BIN, "-p", build_resume_prompt(task, reason),
            "--resume", resume_sid, "--fork-session",
            "--session-id", new_sid,
            "--permission-mode", "bypassPermissions",
        ]
    else:
        cmd = [
            CLAUDE_BIN, "-p", build_prompt(task, reason),
            "--session-id", new_sid,
            "--permission-mode", "bypassPermissions",
        ]
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, cwd=str(HOME),
        )
        with LOCK:
            RUNNING[task_id] = proc
        out, _ = proc.communicate(timeout=60 * 60)
        log(f"← Клод закончил по {task_id[:8]}, код {proc.returncode}")
        if out:
            (STATE_DIR / f"task-{task_id[:8]}.log").write_text(out)
    except subprocess.TimeoutExpired:
        proc.kill()
        log(f"← превышен час работы по {task_id[:8]} — процесс снят")
        api("POST", f"/api/tasks/{task_id}/state",
            {"state": "blocked", "comment": "Работа прервана по таймауту (час). Нужно решение Максима: продолжать или дробить задачу."})
    except Exception as e:
        log(f"← сбой запуска по {task_id[:8]}: {e}")
    finally:
        stop.set()
        with LOCK:
            RUNNING.pop(task_id, None)
        # Задача не должна остаться «в работе», если Клод ушёл молча:
        # честнее показать владельцу, что заход закончился без результата.
        fresh = get_task(task_id)
        if fresh and fresh.get("agent_state") == "in_progress":
            api("POST", f"/api/tasks/{task_id}/state",
                {"state": "blocked", "comment": "Заход завершился, а задача осталась в работе — нужен взгляд Максима."})


def handle_task(task_id: str, why: str) -> None:
    task = get_task(task_id)
    ok, reason = decide(task)
    if not ok:
        log(f"  {why}: {reason} — не берусь")
        return
    threading.Thread(target=run_claude, args=(task, reason), daemon=True).start()


def catch_up() -> None:
    """Непрочитанные уведомления, накопившиеся пока службы не было."""
    items = api("GET", "/api/notifications") or []
    pending = [n for n in items if not n.get("read") and n.get("actor_id") != ME]
    if pending:
        log(f"добираю пропущенное: {len(pending)} уведомлений")
    for n in pending:
        if n.get("task_id"):
            handle_task(n["task_id"], f"пропущенное уведомление ({n.get('type')})")
        # Сухой прогон ничего не меняет — в том числе не гасит непрочитанные
        # уведомления владельца: проверка службы не должна вычищать за него
        # колокольчик.
        if os.environ.get("TASKFLOW_TRIGGER_DRY") != "1":
            api("PATCH", f"/api/notifications/{n['id']}/read", {})


def on_message(_ws, raw: str) -> None:
    try:
        event = json.loads(raw)
    except Exception:
        return
    kind = event.get("type")
    if kind == "connected":
        log("сокет открыт — Клод «онлайн» на экране агентов")
        catch_up()
        return
    if kind != "notification:new":
        return
    task_id = event.get("taskId")
    if not task_id:
        return
    # Уведомление приходит только адресату, но действие мог совершить и сам
    # агент (например, комментарий от себя) — такие поводы пропускаем, иначе
    # отчёт разбудил бы сам себя.
    items = api("GET", "/api/notifications") or []
    this = next((n for n in items if n.get("id") == event.get("notificationId")), None)
    if this and this.get("actor_id") == ME:
        log("  моё же действие — не повод")
        return
    actor = (this or {}).get("actor_name") or "кто-то"
    handle_task(task_id, f"{actor}: {(this or {}).get('type', 'событие')}")


def main() -> None:
    if not TOKEN:
        print("Нет TASKFLOW_TOKEN в окружении — служба запускается через vault-run.py", file=sys.stderr)
        sys.exit(1)
    log("будильник TaskFlow запущен")
    while True:
        try:
            ws = websocket.WebSocketApp(
                f"{WS_URL}?token={TOKEN}",
                on_message=on_message,
                on_error=lambda _w, e: log(f"сокет: сбой {e}"),
                on_close=lambda _w, *_: log("сокет закрыт — переподключаюсь"),
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            log(f"цикл соединения упал: {e}")
        time.sleep(5)


if __name__ == "__main__":
    main()
