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
import hashlib
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
# Токен Гермеса — вторым соединением. Уведомления сервер шлёт ТОЛЬКО
# адресату, поэтому служба, слушающая под учёткой Claude_Bot, про
# назначение задачи Гермесу не узнаёт вовсе: 21.08.2026 владелец назначил
# карточку и ничего не произошло — «не берёт в работу, будильник не зовёт».
# Одно соединение на агента, чьи задачи мы обслуживаем.
HERMES_TOKEN = os.environ.get("TASKFLOW_HERMES_TOKEN", "").strip()
HOME = Path.home()
CLAUDE_BIN = str(HOME / ".npm-global/bin/claude")
STATE_DIR = HOME / ".local/state/taskflow-trigger"
LOG_FILE = STATE_DIR / "trigger.log"

ME = "u2"        # Claude_Bot

# Кого будить под какую учётку.
#
# До 21.08.2026 будильник знал ровно одного исполнителя: задача, назначенная
# на Гермеса или DeepSeek Harness, молча игнорировалась («исполнитель не я»),
# и назначение выглядело как поломка — владелец назначил, а никто не пришёл.
#
# Ключ — id учётки в TaskFlow, значение — как запустить агента с одним
# заданием: у каждого свой флаг разового запроса, интерактивную сессию тут
# поднимать нечем.
#
# ⚠️ Claude идёт СВОИМ путём ниже (resume, форки, живые сессии) — у него
# один диалог продолжается между заходами. У остальных каждый заход
# самостоятельный, поэтому им хватает одной команды.
EXTERNAL_AGENTS = {
    "u3": {
        "name": "Гермес",
        "token_env": "TASKFLOW_HERMES_TOKEN",
        "cmd": [
            str(HOME / ".hermes/hermes-agent/.venv/bin/python"),
            "-m", "hermes_cli.main", "-z",
        ],
        # Каким флагом ему сказать модель, если на задаче висит метка.
        # У каждого агента он свой, поэтому живёт здесь, а не в коде запуска.
        "model_flag": "-m",
    },
    # DeepSeek Harness. Запускается из кеша npx — путь там меняется при
    # обновлении, поэтому ищем, а не зашиваем; PATH подменяем на Node 22,
    # на 18-м dsh падает с «node:util не отдаёт parseEnv».
    "b85212d6-abab-4afb-a4c6-0d379b6537a4": {
        "name": "DeepSeek Harness",
        "token_env": "TASKFLOW_DEEPSEEK_TOKEN",
        "cmd": None,          # соберётся при старте, см. find_dsh()
        "env": {"PATH": "/home/maksim/.nvm/versions/node/v22.23.1/bin:"
                        + os.environ.get("PATH", "")},
    },
    "5b9d47c1-25c7-4a7c-a276-70e21f7d7816": {
        "name": "Antigravity",
        "token_env": "TASKFLOW_ANTIGRAVITY_TOKEN",
        "token_static": "tf_e0d4ae5529f272a989c85bad13208b5a4288a273bc760b046f226b580ebe0c38",
        "cmd": [
            "/usr/bin/python3",
            "/home/maksim/Проекты/New-Todoist/server/scripts/antigravity_agent.py",
            "-z",
        ],
        "model_flag": "-m",
        "env": {
            "HTTPS_PROXY": "http://127.0.0.1:10811",
            "HTTP_PROXY": "http://127.0.0.1:10811",
            "https_proxy": "http://127.0.0.1:10811",
            "http_proxy": "http://127.0.0.1:10811",
            "ALL_PROXY": "socks5://127.0.0.1:10808",
            "all_proxy": "socks5://127.0.0.1:10808",
        },
    },
}


# Модель задаётся МЕТКОЙ НА ЗАДАЧЕ. Решение владельца 21.08.2026: «меткой
# гораздо гибче и проще менять, чем каждый раз заходить в настройки перед
# назначением» — метка вешается и снимается в один тап, в том числе с
# телефона и уже после назначения.
#
# Метки нет — ничего не подставляем: у CLI своё умолчание (модель подписки),
# и подменять его догадкой значит менять поведение там, где никто не просил.
#
# Имена совпадают с псевдонимами Claude Code; Гермесу они не подойдут — ему
# метку вешать с его собственным именем модели, поэтому распознаём и
# произвольное значение через префикс «модель:».
MODEL_LABELS = {"opus", "sonnet", "haiku", "fable"}


def model_of(task: dict) -> str:
    """Модель из меток задачи или пустая строка.

    Понимаем два вида метки: короткое имя из списка выше («Sonnet») и явную
    форму «модель: что-угодно» — вторая нужна тем исполнителям, у кого свои
    имена моделей, длинные и с косыми чертами.

    Все прочие метки владельца («Важно», «UX/UI», «Дом») проходят мимо: они
    не совпадают ни со списком, ни с префиксом. Метки — его инструмент, и
    заводить их он должен свободно, не оглядываясь на будильник.
    """
    found: list[str] = []
    for label in task.get("labels") or []:
        name = str(label.get("name") or "").strip()
        low = name.lower()
        if low in MODEL_LABELS:
            found.append(low)
            continue
        for prefix in ("модель:", "model:"):
            if low.startswith(prefix):
                value = name[len(prefix):].strip()
                if value:
                    found.append(value)
                break
    if not found:
        return ""
    # Две метки моделей сразу — не ошибка владельца, а недосмотр: скорее
    # всего забыл снять прежнюю. Берём первую и ГОВОРИМ об этом в журнале,
    # иначе задача молча уйдёт не на той модели, а по карточке не понять,
    # почему.
    if len(found) > 1:
        log(f"  ⚠️ на задаче несколько меток модели ({', '.join(found)})"
            f" — беру первую: {found[0]}")
    return found[0]


def find_dsh() -> list[str] | None:
    """Команда запуска dsh в headless-режиме или None, если его нет."""
    direct = HOME / ".npm-global/bin/dsh"
    if direct.exists():
        return [str(direct), "--profile", "headless"]
    cache = HOME / ".npm/_npx"
    if cache.is_dir():
        for entry in sorted(cache.iterdir()):
            candidate = entry / "node_modules/.bin/dsh"
            if candidate.exists():
                return [str(candidate), "--profile", "headless"]
    return None
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


def api(method: str, path: str, body=None, token: str = ""):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token or TOKEN}"}
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
    task_id = task.get("id")
    assignee = task.get("assignee_id")
    if assignee != ME and assignee not in EXTERNAL_AGENTS:
        return False, "исполнитель не я"
    if task.get("status") != "active":
        return False, "задача не активна"
    
    with LOCK:
        proc = RUNNING.get(task_id)
        is_running = task_id in RUNNING and (proc is None or proc.poll() is None)
    if is_running:
        return False, "уже в работе (процесс активен)"

    state = task.get("agent_state")
    if state == "review":
        return False, "ждёт проверки владельца"
    if state == "blocked":
        return False, "заблокирована, ждёт владельца"
    return True, "назначена на меня / требует выполнения"


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
закрывай шаги и саму задачу (completed) сам, с result; упёрся —
blocked с объяснением, чего ждёшь от Максима (не от другого агента/сессии —
на пира просто оставайся in_progress).
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
- Сделал шаг → закрывай сам: taskflow_subtask_done(result="…") — одно-два
  предложения по-человечески, что было и что стало, без жаргона. Сдавать на
  приёмку не нужно — с 20.08.2026 галочку ставит и агент. review остаётся
  добровольной опцией (taskflow_subtask_work(state="review", result="…")),
  если работу стоит показать до закрытия, — не обязательный шаг конвейера.
- Упёрся на шаге → taskflow_subtask_work(state="blocked", result="…") —
  конкретно, что мешает и какого решения ждёшь ОТ МАКСИМА. Ждёшь ответа от
  другого агента/сессии (не от Максима) — это не blocked, оставайся
  in_progress и продолжай остальные шаги; blocked означает «встал, нужен
  владелец», а не «жду коллегу».
- Все шаги сделаны (или шагов не было) → закрывай саму задачу сам:
  taskflow_state(completed) — с 20.08.2026 доступно и агенту, приёмка
  владельцем отменена. Не можешь продолжить вообще → taskflow_state(blocked,
  comment="…"). Никогда не оставляй задачу в in_progress, уходя.
- Стоп-линия: прод, удаление данных, деньги, действия наружу — не делай
  сам, опиши в комментарии и уйди в blocked.
- Инструментов taskflow_* нет в списке (MCP не переподключился) → не городи
  обход сырым curl, сразу уйди в blocked с этой же причиной — тебя спросить
  некому, ты один.
"""


# Сколько заходов подряд служба делает по одной задаче и сколько ждёт между
# ними. Предел нужен не «на всякий случай»: заход это расход у провайдера
# агента, и агент, застрявший на одном шаге, будет жечь его молча.
MAX_RUNS = 8
RUN_GAP_SEC = 10


# Сторож тишины ВНУТРИ хода. Аренда теперь продлевается, пока жив процесс,
# и поэтому больше не ловит зависший ход: процесс дышит, а работа стоит.
# Отличаем одно от другого движением на карточке — закрытые шаги и
# комментарии. Пороги подобраны под живые заходы: 20 минут тишины бывают у
# крупного шага, 45 — это уже не работа.
SILENT_WARN_MIN = 20
SILENT_KILL_MIN = 45

# Хвост вывода агента, по которому видно, что он не работал, а отказал:
# так о себе говорит его собственный CLI, когда не может пойти к модели
# (нет провайдера, отвергнут ключ, кончился лимит).
FAILURE_MARKS = ("agent failed", "no llm provider", "rate limit",
                 "quota exceeded", "insufficient", "unauthorized")


def closed_steps(task_id: str) -> int:
    """Сколько шагов задачи закрыто — мерка продвижения между заходами."""
    task = api("GET", f"/api/tasks/{task_id}") or {}
    subs = task.get("subtasks") or []
    return sum(1 for s in subs if s.get("done"))


# Репозитории, в которых работают агенты. Правка файлов — такое же
# движение, как отметка на доске, и куда более частое: агент может целый
# заход писать код внутри одного шага.
REPOS = [
    HOME / "Проекты" / "AI-Control-Center",
    HOME / "Проекты" / "New-Todoist",
]


def worktree_mark() -> tuple:
    """Отпечаток рабочего дерева: последний коммит и состояние правок.

    ⚠️ Без этого мерка движения врала. Прецедент 21.08.2026: Гермес целый
    заход писал экран настроек (новый файл, правки в трёх соседних), но не
    успел закоммитить и закрыть шаг — доска молчала, и служба дважды
    ошиблась: сторож объявил тишину, а цепочка встала с «не сдвинул ни
    одного шага». Работа при этом шла.
    """
    marks = []
    for repo in REPOS:
        try:
            head = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            dirty = subprocess.run(
                ["git", "-C", str(repo), "status", "--porcelain"],
                capture_output=True, text=True, timeout=15,
            ).stdout
            marks.append((head, hashlib.md5(dirty.encode()).hexdigest()))
        except Exception:  # репозитория нет или git занят — не мерка, но и не сбой
            marks.append(("", ""))
    return tuple(marks)


def activity_mark(task_id: str) -> tuple:
    """Отпечаток движения: доска плюс рабочее дерево.

    Меняется на любое осмысленное действие агента — закрытый шаг, отметку
    начала, комментарий, правку файла, коммит. Аренда для этого не годится:
    её шлём мы сами, и она горит даже у зависшего хода.
    """
    subs = api("GET", f"/api/tasks/{task_id}/subtasks") or []
    comments = api("GET", f"/api/tasks/{task_id}/comments") or []
    closed = sum(1 for s in subs if s.get("done"))
    working = sum(1 for s in subs if s.get("agent_state") == "in_progress")
    return (closed, working, len(comments), worktree_mark())


def set_state(task_id: str, state: str, comment: str, token: str = "") -> None:
    """Состояние работы по задаче — от имени того, за кого мы её ведём."""
    api("POST", f"/api/tasks/{task_id}/state",
        {"state": state, "comment": comment}, token=token)


def silence_watch(task_id: str, proc_box: dict, stop: threading.Event,
                  agent_name: str) -> None:
    """Смотрит, движется ли работа, пока идёт ход, и вмешивается по порогам.

    Предупреждение — комментарием в карточку: владелец видит «идёт долго
    без движения» и решает сам. Снятие — только на втором пороге и с
    объяснением: висящий ход держит задачу и жжёт расход у провайдера
    агента, а сказать об этом некому, кроме нас.
    """
    last = activity_mark(task_id)
    since = time.time()
    warned = False
    while not stop.wait(60):
        now = activity_mark(task_id)
        if now != last:
            last, since, warned = now, time.time(), False
            continue
        idle_min = (time.time() - since) / 60
        if idle_min >= SILENT_KILL_MIN:
            proc = proc_box.get("proc")
            log(f"  ⛔ «{agent_name}»: {int(idle_min)} мин без движения — снимаю ход")
            set_state(task_id, "blocked",
                      f"Будильник снял ход: {int(idle_min)} минут ни одного "
                      f"движения по задаче — ни закрытого шага, ни комментария. "
                      f"Процесс был жив, но работа стояла. Что делать дальше — "
                      f"решай ты: перезапустить или разобраться, на чём он встал.")
            if proc and proc.returncode is None:
                proc.terminate()
            return
        if idle_min >= SILENT_WARN_MIN and not warned:
            warned = True
            log(f"  ⚠️ «{agent_name}»: {int(idle_min)} мин без движения")
            note(task_id,
                 f"Будильник: «{agent_name}» работает, но {int(idle_min)} минут "
                 f"не было ни одного движения по задаче. Пока не трогаю — если "
                 f"тишина продлится до {SILENT_KILL_MIN} минут, ход сниму.")


def note(task_id: str, text: str) -> None:
    """Записка в карточку от службы — чтобы решение было видно владельцу."""
    api("POST", f"/api/tasks/{task_id}/comments", {"text": text})


def should_continue(task_id: str, before: tuple) -> tuple[bool, str]:
    """Звать ли агента снова после того, как он завершил заход.

    Три причины НЕ звать, и все они честные состояния, а не догадки:
    агент сам сказал «жду владельца» (blocked) или сдал работу
    (review/completed); все шаги закрыты; заход не сдвинул ни одного шага —
    значит агент топчется, и следующий заход, скорее всего, потратит расход
    впустую.
    """
    task = api("GET", f"/api/tasks/{task_id}")
    if not task:
        return False, "задачу больше не видно"
    state = task.get("agent_state")
    if state in ("blocked", "review", "completed"):
        return False, f"агент сам поставил «{state}»"
    if task.get("status") != "active":
        return False, "задача больше не активна"
    subs = task.get("subtasks") or []
    if subs and all(s.get("done") for s in subs):
        return False, "все шаги закрыты"
    # Движение меряем полным отпечатком — доска И рабочее дерево. По одним
    # закрытым шагам мерить нельзя: заход целиком уходит внутрь одного
    # крупного шага, и работа видна только в файлах (см. worktree_mark).
    if activity_mark(task_id) == before:
        return False, "заход не оставил следов — ни на доске, ни в файлах"
    return True, ""


def heartbeat_loop(task_id: str, stop: threading.Event, token: str = "") -> None:
    """Сигнал «работа идёт», пока жив запущенный нами процесс.

    token — ключ ТОГО агента, за которого держим аренду: сервер продлевает
    её только владельцу аренды, чужим ключом сигнал не считается.
    """
    while not stop.wait(HEARTBEAT_SEC):
        api("POST", f"/api/tasks/{task_id}/heartbeat", {}, token=token)


def run_external(task: dict, reason: str, agent: dict) -> None:
    """Позвать не-Claude агента одним разовым запросом.

    У Гермеса и dsh нет продолжаемой сессии: каждый заход самостоятелен,
    поэтому им отдаётся тот же вводный текст, что и Клоду при первом
    заходе (build_prompt) — там и правила конвейера, и что за задача.

    Аренду держим ПОКА ЖИВ ЕГО ПРОЦЕСС, его же ключом.

    ⚠️ Раньше её не держали вовсе — считалось, что хватит продления на
    каждое действие агента по задаче (комментарий, закрытие шага). Не
    хватило: 21.08.2026 Гермес взял задачу по большому ТЗ, отметил первый
    шаг и ушёл читать задание и писать код. Через пять минут молчания доска
    показала «брошена», хотя процесс работал, — владелец увидел ровно то же,
    что и в прошлый раз: «что-то он пропал». Длинный шаг — это норма, а не
    признак пропажи, и отличить работающего агента от исчезнувшего может
    только тот, кто его запустил.
    """
    task_id = task["id"]
    with LOCK:
        if task_id in RUNNING:
            log(f"  задача {task_id[:8]} уже выполняется — пропускаю")
            return
        RUNNING[task_id] = None

    if os.environ.get("TASKFLOW_TRIGGER_DRY") == "1":
        log(f"[сухой прогон] позвал бы «{agent['name']}» на «{task.get('title')}» ({reason})")
        with LOCK:
            RUNNING.pop(task_id, None)
        return

    # Взять карточку в работу ЗА него — его же ключом, иначе claim ляжет на
    # учётку службы. Без этого агент работал, а доска показывала «не взята»:
    # владелец смотрит на неё и видит, что ничего не происходит.
    token = agent.get("token") or ""
    claimed = api("POST", f"/api/tasks/{task_id}/claim", {}, token=token)
    if claimed is None and task.get("agent_state") != "in_progress":
        log(f"  не удалось взять задачу {task_id[:8]} за «{agent['name']}» — отменяю заход")
        with LOCK:
            RUNNING.pop(task_id, None)
        return

    # Метка модели — только если этот агент умеет её принимать флагом.
    # У dsh модель задаётся профилем, а не аргументом: молча подставлять ему
    # чужой флаг значит уронить запуск, поэтому у него model_flag нет.
    model = model_of(task)
    prefix = list(agent["cmd"])
    flag = agent.get("model_flag")
    if model and flag:
        # Флаг разового запроса («-z», «--profile headless») идёт последним и
        # забирает следующий аргумент как задание — модель вставляем ПЕРЕД
        # ним, иначе она уедет в текст задачи.
        prefix = prefix[:-1] + [flag, model, prefix[-1]]
    cmd = prefix + [build_prompt(task, reason)]
    log(f"  зову «{agent['name']}» на задачу {task_id[:8]}"
        + (f", модель {model}" if model and flag else ""))
    stop = threading.Event()
    threading.Thread(
        target=heartbeat_loop, args=(task_id, stop, token), daemon=True
    ).start()
    try:
        # ЦЕПОЧКА ЗАХОДОВ. Решение владельца 21.08.2026: «когда он сам
        # закончит, пусть выходит, а служба перезапустит».
        #
        # Почему так, а не «пусть работает до конца»: у Гермеса и dsh нет
        # продолжаемой сессии — каждый заход это разовый запрос, агент
        # отвечает столько, сколько считает нужным, и выходит. На большой
        # задаче он честно останавливается посреди работы («работа не
        # готова, а остановлена» — его же слова на задаче по переносу чата),
        # и без внешнего повтора карточка так и замирает на середине.
        for run in range(1, MAX_RUNS + 1):
            before = activity_mark(task_id)
            if run > 1:
                log(f"  зову «{agent['name']}» снова (заход {run} из {MAX_RUNS})")
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                env={**os.environ, **agent.get("env", {})},
            )
            with LOCK:
                RUNNING[task_id] = proc
            # Сторож на время этого захода: процесс отдаём коробкой, чтобы
            # он мог снять именно текущий, а не тот, что был в прошлом.
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

            # ОТКАЗ, а не работа: агент не смог пойти к модели (нет
            # провайдера, отвергнут ключ, кончился лимит) либо вышел с
            # ошибкой. Раньше это оставалось в журнале службы, куда владелец
            # не смотрит, и на доске выглядело как «агент молча пропал».
            low = (out or "").lower()
            failed = proc.returncode not in (0, -15, 143) or any(
                m in low for m in FAILURE_MARKS
            )
            if failed:
                reason = next((m for m in FAILURE_MARKS if m in low), "")
                log(f"  ⛔ «{agent['name']}» отказал: {reason or 'код ' + str(proc.returncode)}")
                set_state(task_id, "blocked",
                          f"Ход «{agent['name']}» не состоялся: "
                          + (f"он ответил «{tail[-200:]}»" if tail
                             else f"процесс вышел с кодом {proc.returncode}")
                          + ". Это отказ на его стороне, а не работа — "
                            "цепочку заходов останавливаю, чтобы не повторять "
                            "одно и то же.",
                          token=token)
                break

            keep, why = should_continue(task_id, before)
            if not keep:
                log(f"  цепочка окончена: {why}")
                # Записку пишем только когда цепочка встала НЕ по-хорошему:
                # «все шаги закрыты» и «агент сдал работу» владелец и так
                # видит по карточке, лишний комментарий там только шум.
                if why == "заход не сдвинул ни одного шага":
                    note(task_id,
                         f"Будильник: остановил цепочку — последний заход "
                         f"«{agent['name']}» не закрыл ни одного шага "
                         f"(заходов сделано: {run}). Работа не двигается: "
                         f"либо шаг слишком крупный, либо агент упёрся и не "
                         f"сказал об этом.")
                break
            if run == MAX_RUNS:
                log(f"  цепочка окончена: предел {MAX_RUNS} заходов")
                note(task_id,
                     f"Будильник: остановил цепочку — сделано {MAX_RUNS} заходов "
                     f"подряд, а работа не закончена. Дальше нужно твоё решение: "
                     f"продолжить (сними и верни исполнителя) или разобрать, "
                     f"почему шаги не двигаются.")
                break
            # Небольшая пауза: агент только что писал в карточку, дадим
            # серверу дописать событие, а себе — не долбить запусками.
            time.sleep(RUN_GAP_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        log(f"  «{agent['name']}» не уложился в час — снят")
    except Exception as e:
        log(f"  «{agent['name']}» не запустился: {e}")
    finally:
        # Процесс кончился — сигнал прекращаем сразу: дальше «в работе»
        # держит уже сам агент своими действиями, а если он не закрыл
        # задачу, она честно должна остыть в брошенную.
        stop.set()
        with LOCK:
            RUNNING.pop(task_id, None)


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

    # Метка модели с карточки. Пусто — флаг не передаём вовсе (см. model_of).
    model = model_of(task)
    model_args = ["--model", model] if model else []
    if model:
        log(f"  модель с метки: {model}")

    if resume_sid and not fork:
        log(f"  продолжаю сессию {resume_sid[:8]} — контекст на месте")
        cmd = [
            CLAUDE_BIN, "-p", build_resume_prompt(task, reason),
            "--resume", resume_sid,
            "--permission-mode", "bypassPermissions",
            *model_args,
        ]
    elif resume_sid and fork:
        cmd = [
            CLAUDE_BIN, "-p", build_resume_prompt(task, reason),
            "--resume", resume_sid, "--fork-session",
            "--session-id", new_sid,
            "--permission-mode", "bypassPermissions",
            *model_args,
        ]
    else:
        cmd = [
            CLAUDE_BIN, "-p", build_prompt(task, reason),
            "--session-id", new_sid,
            "--permission-mode", "bypassPermissions",
            *model_args,
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
    # Кого звать — решает исполнитель задачи, а не то, кем служба запущена.
    agent = EXTERNAL_AGENTS.get(task.get("assignee_id") or "")
    if agent:
        threading.Thread(
            target=run_external, args=(task, reason, agent), daemon=True
        ).start()
    else:
        threading.Thread(target=run_claude, args=(task, reason), daemon=True).start()


def catch_up(owner_id: str = ME, token: str = "") -> None:
    """Непрочитанные уведомления, накопившиеся пока службы не было.

    ⚠️ Ходит ключом ТОГО соединения, которое её вызвало. Иначе соединение
    Гермеса добирало мои уведомления и не видело его собственных: 21.08.2026
    у него висели три непрочитанных «assigned», а служба молчала — «не берёт
    в работу, будильник не зовёт».
    """
    items = api("GET", "/api/notifications", token=token) or []
    pending = [n for n in items if not n.get("read") and n.get("actor_id") != owner_id]
    if pending:
        log(f"добираю пропущенное: {len(pending)} уведомлений")
    for n in pending:
        if n.get("task_id"):
            handle_task(n["task_id"], f"пропущенное уведомление ({n.get('type')})")
        # Сухой прогон ничего не меняет — в том числе не гасит непрочитанные
        # уведомления владельца: проверка службы не должна вычищать за него
        # колокольчик.
        if os.environ.get("TASKFLOW_TRIGGER_DRY") != "1":
            api("PATCH", f"/api/notifications/{n['id']}/read", {}, token=token)


def on_message_for(owner_id: str, token: str):
    """Обработчик под конкретную учётку: у каждого соединения свой адресат."""

    def handler(_ws, raw: str) -> None:
        _on_message(raw, owner_id, token)

    return handler


def _on_message(raw: str, owner_id: str = ME, token: str = "") -> None:
    try:
        event = json.loads(raw)
    except Exception:
        return
    kind = event.get("type")
    if kind == "connected":
        log(f"сокет открыт ({owner_id}) — агент «онлайн» на экране агентов")
        catch_up(owner_id, token)
        return
    if kind != "notification:new":
        return
    task_id = event.get("taskId")
    if not task_id:
        return
    # Уведомление приходит только адресату, но действие мог совершить и сам
    # агент (например, комментарий от себя) — такие поводы пропускаем, иначе
    # отчёт разбудил бы сам себя.
    items = api("GET", "/api/notifications", token=token) or []
    this = next((n for n in items if n.get("id") == event.get("notificationId")), None)
    if this and this.get("actor_id") == owner_id:
        log("  моё же действие — не повод")
        return
    actor = (this or {}).get("actor_name") or "кто-то"
    handle_task(task_id, f"{actor}: {(this or {}).get('type', 'событие')}")


def listen(owner_id: str, token: str, who: str) -> None:
    """Держать соединение за одну учётку и не отпускать.

    Своё соединение на каждого обслуживаемого агента: уведомления сервер
    доставляет только адресату, и чужие события в чужой сокет не приходят.
    """
    while True:
        try:
            ws = websocket.WebSocketApp(
                f"{WS_URL}?token={token}",
                on_message=on_message_for(owner_id, token),
                on_error=lambda _w, e, w=who: log(f"сокет {w}: сбой {e}"),
                on_close=lambda _w, *_, w=who: log(f"сокет {w} закрыт — переподключаюсь"),
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            log(f"цикл соединения {who} упал: {e}")
        time.sleep(5)


def main() -> None:
    # Ключи соседей — в карту: ими служба берёт задачу за них и читает их
    # уведомления. Своего ключа нет — агент просто не обслуживается.
    for uid, agent in list(EXTERNAL_AGENTS.items()):
        token = os.environ.get(agent.get("token_env", ""), "").strip()
        if not token and "token_static" in agent:
            token = agent["token_static"]
        agent["token"] = token
        if agent["cmd"] is None:
            agent["cmd"] = find_dsh()
        if not agent["token"] or not agent["cmd"]:
            why = "нет ключа" if not agent["token"] else "не установлен"
            log(f"«{agent['name']}»: {why} — его задачи не обслуживаю")
            EXTERNAL_AGENTS.pop(uid)

    if not TOKEN:
        print("Нет TASKFLOW_TOKEN в окружении — служба запускается через vault-run.py", file=sys.stderr)
        sys.exit(1)
    log("будильник TaskFlow запущен")

    # Соседние агенты — отдельными потоками. Нет токена — молча работаем
    # как раньше, только за себя: отсутствие ключа не повод не запускаться.
    # Поток на КАЖДОГО обслуживаемого агента, а не на одного жёстко: список
    # растёт (Гермес, DeepSeek Harness, дальше — кто появится), и второе
    # место, где перечислены агенты, разошлось бы с картой в первый же день.
    for uid, agent in EXTERNAL_AGENTS.items():
        threading.Thread(
            target=listen, args=(uid, agent["token"], agent["name"]), daemon=True
        ).start()
        log(f"слушаю задачи «{agent['name']}»")

    listen(ME, TOKEN, "Claude")


if __name__ == "__main__":
    main()
