#!/usr/bin/env python3
"""MCP-сервер TaskFlow — работа с задачами под учёткой агента.

Даёт Клоду (и любому MCP-клиенту) те же возможности, что есть у двойников,
которых поднимает будильник: посмотреть свои задачи, взять в работу,
отметить шаги, сдать на проверку или сообщить о затыке.

Протокол — JSON-RPC по stdin/stdout, без внешних зависимостей: ровно тем же
способом, что и рабочий mcp_server.py «Пульта .110», проверенный на этой
машине. Ставить SDK ради двух десятков строк протокола незачем.

Ключ доступа сервер берёт сам при старте — `vault-get.py --raw`. Значение
живёт только в памяти этого процесса: в конфиг MCP оно не попадает, в
транскрипт сессии тоже. Запускать через vault-run.py нельзя — тот ждёт
завершения дочернего процесса и процеживает его вывод, а MCP это
долгоживущий двусторонний диалог по stdout.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

SERVER_NAME = "taskflow"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2024-11-05"
BASE = os.environ.get("TASKFLOW_API", "http://localhost:3001")
VAULT_GET = os.path.expanduser("~/.claude/vault-get.py")
VAULT_KEY = os.environ.get("TASKFLOW_VAULT_KEY", "TASKFLOW_AGENT_TOKEN")


def log(msg: str) -> None:
    # Только stderr: stdout занят протоколом, любая посторонняя строка там
    # ломает диалог с клиентом.
    print(f"[taskflow-mcp] {msg}", file=sys.stderr, flush=True)


class TaskFlowError(Exception):
    pass


def load_token() -> str:
    token = os.environ.get("TASKFLOW_TOKEN", "").strip()
    if token:
        return token
    try:
        r = subprocess.run(
            [sys.executable, VAULT_GET, "--raw", VAULT_KEY],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        raise TaskFlowError(f"не удалось прочитать ключ из хранилища: {e}")
    if r.returncode != 0 or not r.stdout.strip():
        raise TaskFlowError(
            f"ключ {VAULT_KEY} не выдан хранилищем: {r.stderr.strip()[:200]}"
        )
    return r.stdout.strip()


TOKEN = ""


def api(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        raise TaskFlowError(f"{method} {path} → {e.code}: {detail}")
    except Exception as e:
        raise TaskFlowError(f"{method} {path} → {e}")


def unwrap(payload):
    """Часть маршрутов отдаёт задачу как {"task": {...}} — разворачиваем."""
    if isinstance(payload, dict) and "task" in payload and len(payload) == 1:
        return payload["task"]
    return payload


def as_tasks(payload):
    return payload if isinstance(payload, list) else payload.get("tasks", [])


def short(task: dict) -> dict:
    """Компактная карточка для списков: без служебных полей, читаемо глазами."""
    card = {
        "id": task.get("id"),
        "название": task.get("title"),
        "проект": task.get("project_name"),
        "статус": task.get("status"),
        "состояние": task.get("agent_state") or "не взята",
        "брошена": bool(task.get("agent_stale")),
        "срок": task.get("due_date"),
        "исполнитель": task.get("assignee_name"),
    }
    # Последний сигнал — единственный способ отличить «двойник сейчас
    # работает» от «взял и молчит»: состояние in_progress держится и в том,
    # и в другом случае, а brошена становится true только через 15 минут
    # тишины. Без этого поля вопрос «он ещё жив?» по MCP не ответить.
    if task.get("agent_heartbeat_at"):
        card["последний сигнал"] = task["agent_heartbeat_at"]
    return card


# --------------------------------------------------------------------------- инструменты

def t_my_tasks(args):
    state = (args.get("state") or "").strip()
    # /api/auth/me отдаёт профиль как {"user": {...}} — своя обёртка, не та,
    # что у задач, поэтому unwrap здесь не годится.
    profile = api("GET", "/api/auth/me")
    me = (profile.get("user") or profile).get("id")
    tasks = [t for t in as_tasks(api("GET", "/api/tasks")) if t.get("assignee_id") == me]
    if args.get("include_completed") is not True:
        tasks = [t for t in tasks if t.get("status") == "active"]
    if state == "free":
        tasks = [t for t in tasks if not t.get("agent_state")]
    elif state:
        tasks = [t for t in tasks if t.get("agent_state") == state]
    return {"всего": len(tasks), "задачи": [short(t) for t in tasks]}


def t_task(args):
    d = api("GET", f"/api/tasks/{args['id']}")
    task = unwrap(d) if "task" in d else d
    feed = []
    for c in d.get("comments", []) or []:
        feed.append({"когда": c.get("created_at"), "кто": c.get("user_name"), "комментарий": c.get("text")})
    for e in d.get("events", []) or []:
        feed.append({
            "когда": e.get("created_at"), "кто": e.get("actor_name"),
            "событие": e.get("kind"), "поле": e.get("field"),
            "было": e.get("from_value"), "стало": e.get("to_value"),
        })
    feed.sort(key=lambda r: r.get("когда") or "")
    return {
        **short(task),
        "описание": task.get("description"),
        "шаги": [
            {"id": s.get("id"), "сделан": bool(s.get("done")), "название": s.get("title")}
            for s in d.get("subtasks", []) or []
        ],
        "лента": feed,
    }


def t_claim(args):
    return {"взято в работу": short(unwrap(api("POST", f"/api/tasks/{args['id']}/claim", {})))}


def t_heartbeat(args):
    api("POST", f"/api/tasks/{args['id']}/heartbeat", {})
    return {"аренда продлена": args["id"]}


def t_state(args):
    body = {"state": args["state"]}
    if args.get("comment"):
        body["comment"] = args["comment"]
    return {"состояние изменено": short(unwrap(api("POST", f"/api/tasks/{args['id']}/state", body)))}


def t_comment(args):
    api("POST", f"/api/tasks/{args['id']}/comments", {"text": args["text"]})
    return {"комментарий добавлен": args["id"]}


def t_subtask_done(args):
    done = args.get("done", True)
    api("PATCH", f"/api/subtasks/{args['id']}", {"done": bool(done)})
    return {"шаг отмечен" if done else "отметка снята": args["id"]}


def t_subtask_add(args):
    body = {"title": args["title"]}
    if args.get("after_id"):
        body["after_id"] = args["after_id"]
    s = api("POST", f"/api/tasks/{args['task_id']}/subtasks", body)
    return {"шаг добавлен": s.get("title"), "id": s.get("id")}


def t_status(_args):
    """Одним вызовом: работает ли служба и чем заняты агенты прямо сейчас.

    Отвечает на вопрос «двойник вообще пашет или нет» без обхода трёх
    инструментов — именно за этим сюда и заходят.
    """
    agents = api("GET", "/api/agents")
    tasks = [t for t in as_tasks(api("GET", "/api/tasks")) if t.get("status") == "active"]
    working = [t for t in tasks if t.get("agent_state") == "in_progress" and not t.get("agent_stale")]
    lost = [t for t in tasks if t.get("agent_state") == "in_progress" and t.get("agent_stale")]
    review = [t for t in tasks if t.get("agent_state") == "review"]
    blocked = [t for t in tasks if t.get("agent_state") == "blocked"]
    online = [a.get("name") for a in agents if a.get("type") == "ai" and a.get("status") == "online"]
    return {
        "служба на дежурстве": bool(online),
        "агенты на связи": online or "никого",
        "в работе": [short(t) for t in working],
        "брошено (взяли и молчат)": [short(t) for t in lost],
        "ждут проверки владельца": [short(t) for t in review],
        "упёрлись, нужен владелец": [short(t) for t in blocked],
    }


def t_agents(_args):
    return {
        "участники": [
            {"id": a.get("id"), "имя": a.get("name"),
             "тип": "агент" if a.get("type") == "ai" else "человек",
             "на связи": a.get("status") == "online"}
            for a in api("GET", "/api/agents")
        ]
    }


def t_subtask_work(args):
    """Взяться за подзадачу, продлить работу, упереться или отпустить.

    Зачем: до 15.08.2026 агент умел только отметить подзадачу сделанной —
    по карточке было видно «взял задачу» и «сдал», а где он внутри, нет.
    Теперь он отмечает НАЧАЛО, и в ленте крутится значок ровно у той
    подзадачи, над которой идёт работа.

    Аренда та же, что у задачи: «в работе» держится сигналами. Замолчал
    дольше срока — значок гаснет сам. Поэтому по ходу длинной подзадачи
    вызывать этот же метод без state (продление), как heartbeat у задачи.
    """
    body = {}
    if "state" in args:
        body["state"] = args["state"]
    if args.get("result") is not None:
        body["result"] = args["result"]
    row = api("POST", f"/api/subtasks/{args['id']}/work", body)
    return {
        "подзадача": row.get("title"),
        "состояние": row.get("agent_state") or "не в работе",
        "итог": row.get("result") or "—",
    }


def t_projects(_args):
    """Проекты людей, на которых работает агент.

    До 14.08.2026 список приходил пустым: сервер отдавал только собственные
    проекты вызывающего, а у агента их нет. Класть задачу в проект человека
    агент при этом был вправе — приходилось угадывать идентификатор.
    """
    return {
        "проекты": [
            {"id": p.get("id"), "название": p.get("name"),
             "активных задач": p.get("task_count")}
            for p in api("GET", "/api/projects")
        ],
        "как пользоваться": (
            "id подставить в taskflow_create_task как project_id; "
            "assignee_id — тот же человек, чей это проект."
        ),
    }


def t_create_task(args):
    body = {"title": args["title"]}
    for key in ("description", "project_id", "assignee_id", "due_date", "priority"):
        if args.get(key) is not None:
            body[key] = args[key]
    if args.get("subtasks"):
        body["subtasks"] = args["subtasks"]
    return {"задача создана": short(unwrap(api("POST", "/api/tasks", body)))}


TOOLS = [
    {
        "name": "taskflow_my_tasks",
        "description": "Мои задачи в TaskFlow (назначенные на эту учётку). state: free — никто не взял, in_progress, review, blocked.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {"type": "string", "description": "free | in_progress | review | blocked"},
                "include_completed": {"type": "boolean", "description": "показать и выполненные"},
            },
        },
        "fn": t_my_tasks,
    },
    {
        "name": "taskflow_task",
        "description": "Карточка задачи целиком: описание, шаги, лента комментариев и событий.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        "fn": t_task,
    },
    {
        "name": "taskflow_claim",
        "description": "Взять задачу в работу (agent_state → in_progress). Дальше нужно продлевать аренду: срок 15 минут.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        "fn": t_claim,
    },
    {
        "name": "taskflow_heartbeat",
        "description": "Продлить аренду задачи, пока работа идёт. Без этого через 15 минут задача покажется брошенной.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        "fn": t_heartbeat,
    },
    {
        "name": "taskflow_state",
        "description": "Сменить состояние работы: review — сдать на проверку владельцу, blocked — упёрся и жду его, in_progress — вернуться к работе. Для review и blocked комментарий обязателен.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "state": {"type": "string", "description": "review | blocked | in_progress"},
                "comment": {"type": "string", "description": "что сделано / что мешает"},
            },
            "required": ["id", "state"],
        },
        "fn": t_state,
    },
    {
        "name": "taskflow_comment",
        "description": "Написать комментарий в ленту задачи.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
            "required": ["id", "text"],
        },
        "fn": t_comment,
    },
    {
        "name": "taskflow_subtask_done",
        "description": "Отметить шаг задачи сделанным (или снять отметку, done=false).",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}, "done": {"type": "boolean"}},
            "required": ["id"],
        },
        "fn": t_subtask_done,
    },
    {
        "name": "taskflow_subtask_add",
        "description": (
            "Добавить шаг в задачу. Без after_id — в конец списка. С after_id — "
            "сразу после указанного шага (например, поняли по ходу работы, что "
            "между вторым и третьим шагом нужен ещё один — after_id = id второго)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string"},
                "title": {"type": "string"},
                "after_id": {
                    "type": "string",
                    "description": "id уже существующего шага этой же задачи — новый встанет сразу за ним.",
                },
            },
            "required": ["task_id", "title"],
        },
        "fn": t_subtask_add,
    },
    {
        "name": "taskflow_status",
        "description": "Что сейчас происходит: работает ли служба, какие задачи агенты делают прямо сейчас (с временем последнего сигнала), что брошено, что ждёт проверки. Начинать проверку состояния — отсюда.",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_status,
    },
    {
        "name": "taskflow_agents",
        "description": "Кто есть в команде и кто сейчас на связи.",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_agents,
    },
    {
        "name": "taskflow_subtask_work",
        "description": (
            "Отметить, что работаешь над подзадачей. state='in_progress' — берусь "
            "(в ленте закрутится значок), 'blocked' — упёрся, null — отпустить. "
            "Без state — продлить работу (как heartbeat: молчание дольше 5 минут "
            "гасит значок). result — короткий итог, он виден при раскрытии."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "state": {
                    "type": ["string", "null"],
                    "description": "in_progress | blocked | null",
                },
                "result": {"type": "string", "description": "короткий «что вышло»"},
            },
            "required": ["id"],
        },
        "fn": t_subtask_work,
    },
    {
        "name": "taskflow_projects",
        "description": "Проекты и их идентификаторы — чтобы класть задачу в нужный, а не во «Входящие».",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_projects,
    },
    {
        "name": "taskflow_create_task",
        "description": "Завести задачу. subtasks — список названий шагов.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "project_id": {"type": "string"},
                "assignee_id": {"type": "string"},
                "due_date": {"type": "string", "description": "ГГГГ-ММ-ДД"},
                "priority": {"type": "integer", "description": "1 срочный … 4 низкий"},
                "subtasks": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title"],
        },
        "fn": t_create_task,
    },
]
BY_NAME = {t["name"]: t for t in TOOLS}


def public_tools():
    return [{k: t[k] for k in ("name", "description", "inputSchema")} for t in TOOLS]


# --------------------------------------------------------------------------- JSON-RPC

def result(rid, payload):
    return {"jsonrpc": "2.0", "id": rid, "result": payload}


def error(rid, code, message):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle(msg):
    method = msg.get("method")
    rid = msg.get("id")
    params = msg.get("params") or {}

    # Уведомления (без id) ответа не требуют.
    if rid is None:
        return None

    if method == "initialize":
        asked = (params.get("protocolVersion") or "").strip()
        return result(rid, {
            "protocolVersion": asked or DEFAULT_PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": (
                "Задачи TaskFlow под учёткой агента. Порядок работы по "
                "AGENT-PROTOCOL.md: взять задачу (taskflow_claim), продлевать "
                "аренду по ходу (taskflow_heartbeat, срок 15 минут), отмечать "
                "шаги, закончил — taskflow_state со state=review и "
                "комментарием, что сделано. Упёрся — state=blocked с "
                "объяснением, что нужно от владельца. Задачу выполненной "
                "агент не закрывает: принимает её только владелец."
            ),
        })

    if method == "ping":
        return result(rid, {})

    if method == "tools/list":
        return result(rid, {"tools": public_tools()})

    if method in ("resources/list", "resources/templates/list"):
        return result(rid, {"resources": [], "resourceTemplates": []})

    if method == "prompts/list":
        return result(rid, {"prompts": []})

    if method == "tools/call":
        name = params.get("name")
        tool = BY_NAME.get(name)
        if tool is None:
            return error(rid, -32602, f"нет такого инструмента: {name}")
        args = params.get("arguments") or {}
        try:
            payload = tool["fn"](args)
            text = json.dumps(payload, ensure_ascii=False, indent=2)
            is_error = False
        except TaskFlowError as e:
            text, is_error = str(e), True
        except KeyError as e:
            text, is_error = f"не хватает обязательного параметра {e}", True
        except Exception as e:  # инструмент не должен ронять сервер
            log(f"{name}: {e!r}")
            text, is_error = f"сбой инструмента {name}: {e}", True
        return result(rid, {"content": [{"type": "text", "text": text}], "isError": is_error})

    return error(rid, -32601, f"метод не поддержан: {method}")


def main():
    global TOKEN
    try:
        TOKEN = load_token()
    except TaskFlowError as e:
        log(str(e))
        # Без ключа сервер бесполезен, но падать нельзя: клиент должен
        # получить внятную ошибку на вызов, а не молчащий процесс.
        TOKEN = ""
    log(f"старт, API {BASE}, инструментов {len(TOOLS)}, ключ {'получен' if TOKEN else 'НЕ получен'}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            log("получен не-JSON, пропускаю")
            continue
        try:
            out = handle(msg)
        except Exception as e:
            log(f"внутренняя ошибка: {e!r}")
            out = error(msg.get("id"), -32603, str(e))
        if out is not None:
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
