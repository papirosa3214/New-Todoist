#!/usr/bin/env python3
"""MCP-сервер TaskFlow — работа с задачами под учёткой агента.

Даёт Клоду (и любому MCP-клиенту) те же возможности, что есть у двойников,
которых поднимает будильник: посмотреть свои задачи, взять в работу,
отметить шаги, сдать на проверку или сообщить о затыке.

Два способа запуска, handle() и весь протокол — общие, разница только в
транспорте:

  stdio (по умолчанию, без аргументов)
      JSON-RPC по stdin/stdout, без внешних зависимостей: ровно тем же
      способом, что и рабочий mcp_server.py «Пульта .110». Так подключены
      локальные сессии Claude Code/Гермеса/DSH на этой машине — каждая
      получает свой процесс через spawn, ставить SDK ради двух десятков
      строк протокола незачем.

  --serve [PORT] (сеть, Streamable HTTP)
      Долгоживущий сервер для клиентов ВНЕ этой машины (Claude Code на
      другом хосте и т.п.). Слушает TASKFLOW_MCP_HOST:TASKFLOW_MCP_PORT
      (по умолчанию 0.0.0.0:8802), путь /mcp, только POST. Каждый запрос
      обязан нести `Authorization: Bearer <токен>` — отдельный ключ
      TASKFLOW_MCP_TOKEN, не тот, что ходит в TaskFlow API (см. ниже);
      сервер сам достаёт его из vault при старте. Юнит:
      taskflow-mcp-net.service.
      ⚠️ Известный пробел: current_session_id() ниже различает несколько
      ПАРАЛЛЕЛЬНЫХ локальных сессий по CLAUDE_CODE_SESSION_ID и файлам
      транскриптов — у сетевого запроса ни того, ни другого нет, поэтому
      все вызовы через --serve неотличимы друг от друга для
      taskflow-progress-gate.py. Не чинится в этом заходе (нужен отдельный
      протокол идентификации клиента), задокументировано намеренно.

Ключ доступа сервер берёт сам при старте — `vault-get.py --raw`. Значение
живёт только в памяти этого процесса: в конфиг MCP оно не попадает, в
транскрипт сессии тоже. Запускать через vault-run.py нельзя — тот ждёт
завершения дочернего процесса и процеживает его вывод, а MCP это
долгоживущий двусторонний диалог по stdout/по HTTP-соединению.
"""
from __future__ import annotations

import hmac
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SERVER_NAME = "taskflow"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL = "2024-11-05"
BASE = os.environ.get("TASKFLOW_API", "http://localhost:3001")
VAULT_GET = os.path.expanduser("~/.claude/vault-get.py")
VAULT_KEY = os.environ.get("TASKFLOW_VAULT_KEY", "TASKFLOW_AGENT_TOKEN")

# Состояние шага сервер отдаёт вычисленным (поле `state`, см.
# withSubtaskState в server/src/routes/tasks.ts) — здесь только перевод для
# чтения. Неизвестное значение показываем как есть, чтобы новое состояние на
# сервере не превращалось молча в «не в работе».
SUBTASK_STATE_RU = {
    "done": "сделан",
    "running": "в работе",
    "pending": "не в работе",
    "blocked": "упёрся",
    "review": "сдан",
}

# Несколько параллельных сессий Claude Code делят один и тот же учётный
# аккаунт-агента (Claude_Bot) в TaskFlow — assignee_id один на всех, поэтому
# claim/state сами по себе не говорят, ЧЕЙ физически это процесс. Пишем
# session_id при каждом входе в in_progress (18.08.2026, после того как
# taskflow-progress-gate.py начал блокировать сессии чужой незавершённой
# работой того же бота) — единственное поле, по которому Stop-хук отличает
# «моя» работа от «чужая под тем же ботом».
ENV_SESSION_ID = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")


def _own_transcript_dir() -> str:
    """Папка с транскриптами именно этой сессии/проекта.

    Claude Code кодирует в имя папки закодированный путь проекта, а он
    разный у каждого воркутри (git worktree меняет cwd). Раньше здесь стоял
    один прошитый путь "-home-maksim/projects" — он был именем папки только
    для сессий, запущенных прямо из ~/Проекты/New-Todoist, а не из
    worktree.

    Найдено 25.08.2026 живьём: в этом воркутри (traycer-cosmic-tiger-...)
    та прошитая папка указывала на ПОСТОРОННИЕ, более старые сессии из
    других проектов. current_session_id() ниже находил там «более свежий»
    файл чужой сессии и молча подменял им ENV_SESSION_ID — agent_session_id
    задачи расходился с тем CLAUDE_CODE_SESSION_ID, что видят хуки,
    taskflow-heartbeat.py переставал считать задачу «своей» (mine) и не
    продлевал аренду, несмотря на непрерывную работу: задача часами
    показывала «брошена» между тем, как агент явно её продлевал.

    Правильно — не угадывать имя папки, а найти ту, где реально лежит файл
    ENV_SESSION_ID.jsonl.
    """
    if not ENV_SESSION_ID:
        return ""
    try:
        for name in os.listdir(PROJECTS_DIR):
            if os.path.exists(os.path.join(PROJECTS_DIR, name, f"{ENV_SESSION_ID}.jsonl")):
                return os.path.join(PROJECTS_DIR, name)
    except Exception:
        pass
    return ""


def current_session_id() -> str:
    """Сессия, от имени которой идёт вызов, — на момент ВЫЗОВА, не запуска.

    Переменная окружения выставляется один раз, когда Claude Code поднимает
    этот процесс, и живёт до его смерти. После /clear сессия сменяется, а
    процесс остаётся — и в agent_session_id попадал ИД уже завершённой
    сессии: Stop-хук (taskflow-progress-gate.py) не находил совпадения
    никогда и пропускал любую незакрытую работу (найдено 18.08.2026).

    Поэтому: если транскрипт «своей» сессии больше не пополняется, а рядом
    (в ТОЙ ЖЕ папке, см. _own_transcript_dir) есть более свежий — значит
    сессию сменили, и текущая та, что пишется сейчас. Файл транскрипта
    Claude Code обновляет на каждом ходе, так что свежесть здесь надёжнее
    переменной. Не нашли свою папку — возвращаем переменную как есть.
    """
    try:
        transcripts_dir = _own_transcript_dir()
        if not transcripts_dir:
            return ENV_SESSION_ID
        newest, newest_mtime = "", 0.0
        for name in os.listdir(transcripts_dir):
            if not name.endswith(".jsonl"):
                continue
            mtime = os.path.getmtime(os.path.join(transcripts_dir, name))
            if mtime > newest_mtime:
                newest, newest_mtime = name[: -len(".jsonl")], mtime
        if not newest or newest == ENV_SESSION_ID:
            return ENV_SESSION_ID
        own = os.path.join(transcripts_dir, f"{ENV_SESSION_ID}.jsonl")
        own_mtime = os.path.getmtime(own) if os.path.exists(own) else 0.0
        # Минута форы своей сессии: при двух параллельных сессиях чужой ход
        # не должен перебивать наш только потому, что случился секундой позже.
        return newest if newest_mtime - own_mtime > 60 else ENV_SESSION_ID
    except Exception:
        return ENV_SESSION_ID


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
        detail = e.read().decode()[:4000]
        raise TaskFlowError(f"{method} {path} → {e.code}: {detail}")
    except Exception as e:
        raise TaskFlowError(f"{method} {path} → {e}")


def send_activity(task_id: str, kind: str, target: str, detail: str | None = None) -> None:
    """Живая строка «чем занят агент» (тикет mcp-sender) — для агентов без
    хука Claude Code (Hermes, DeepSeek, Antigravity): у них нет PostToolUse,
    единственное, что от них видно, — обращения к самому трекеру.

    Необязательна: тот же принцип, что у подсказки «дальше» в t_comment
    (см. комментарий там) — ошибка здесь не должна ронять ответ основного
    инструмента. Сервер активности недоступен или лежит — вызовы taskflow_*
    просто отработают как обычно, тихо, без активности в карточке.

    Не дублирует хук: TOOL_KIND в taskflow-heartbeat.py не знает про
    mcp__taskflow__* инструменты, а этот канал не знает про Read/Edit/Bash —
    для одного и того же действия Клода сработает только один из двух.
    """
    try:
        body: dict = {"kind": kind, "target": target}
        if detail:
            body["detail"] = detail
        api("POST", f"/api/tasks/{task_id}/activity", body)
    except Exception:
        pass


def unwrap(payload):
    """Часть маршрутов отдаёт задачу как {"task": {...}} — разворачиваем.

    Условия «ключ ровно один» здесь быть не должно: claim и state отвечают
    {"task": …, "rules": …}, и с ним разворот молча не срабатывал — короткая
    карточка строилась из внешнего словаря, где полей задачи нет, и печатала
    «не взята» со сплошными null на успешно взятой задаче (20.08.2026).
    Правила достаются отдельно, через rules_of().
    """
    if isinstance(payload, dict) and isinstance(payload.get("task"), dict):
        return payload["task"]
    return payload


def rules_of(payload):
    """Правила работы, которые сервер навешивает на ответ claim/state."""
    if isinstance(payload, dict):
        return payload.get("rules")
    return None


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
    # и в другом случае, а brошена становится true только через 5 минут
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
    send_activity(args["id"], "read", "карточке задачи")
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
        # Техническое поле для Stop-хука (taskflow-progress-gate.py), не для
        # чтения человеком — сессия, которая физически держит claim. Пусто у
        # задач, взятых до 004_agent_session_id, или если MCP-клиент не
        # передал CLAUDE_CODE_SESSION_ID.
        "session_id": task.get("agent_session_id"),
        "шаги": [
            {
                "id": s.get("id"),
                "сделан": bool(s.get("done")),
                # Состояние берём ВЫЧИСЛЕННОЕ сервером (withSubtaskState в
                # routes/tasks.ts), а не сырое agent_state. Разница видна
                # ровно там, где важна: у закрытого шага сырое поле могло
                # остаться «in_progress», и карточка показывала шаг разом
                # сделанным и идущим — так Максим и заметил рассинхрон
                # 20.08.2026. Сервер же считает готовность старше работы, а
                # протухшую аренду возвращает в «не в работе». Источник
                # остатка закрыт в routes/subtasks.ts, но читать всё равно
                # правильнее вычисленное: одно поле — одна правда.
                "состояние": SUBTASK_STATE_RU.get(
                    s.get("state"), s.get("state") or "не в работе"
                ),
                "название": s.get("title"),
            }
            for s in d.get("subtasks", []) or []
        ],
        "лента": feed,
    }


def t_claim(args):
    session = current_session_id()
    body = {"session_id": session} if session else {}
    resp = api("POST", f"/api/tasks/{args['id']}/claim", body)
    send_activity(args["id"], "edit", "статус: взял задачу в работу")
    out = {"взято в работу": short(unwrap(resp))}
    rules = rules_of(resp)
    if rules:
        out["правила"] = rules
    tail = _unread_tail()
    if tail:
        out["чат"] = tail
    return out


def t_heartbeat(args):
    api("POST", f"/api/tasks/{args['id']}/heartbeat", {})
    out = {"аренда продлена": args["id"]}
    tail = _unread_tail()
    if tail:
        out["чат"] = tail
    return out


def t_state(args):
    body = {"state": args["state"]}
    if args.get("comment"):
        body["comment"] = args["comment"]
    session = current_session_id()
    if args["state"] == "in_progress" and session:
        body["session_id"] = session
    resp = api("POST", f"/api/tasks/{args['id']}/state", body)
    out = {"состояние изменено": short(unwrap(resp))}
    rules = rules_of(resp)
    if rules:
        out["правила"] = rules
    # Напоминание приходит В МОМЕНТ СДАЧИ, а не при старте сессии: общую
    # инструкцию агент читает один раз и забывает, а инструмент дёргает
    # постоянно. Владелец 28.08.2026: «ты к инструкции обратился один раз
    # когда-то давно и всё; пиши эти моменты в MCP-сервер». Только на
    # review — на blocked и возврат в работу подсказка была бы шумом.
    if args["state"] == "review":
        out["не потеряй знание"] = (
            "Работа закончена — итог и найденные грабли положи отдельной "
            "заметкой в документацию проекта (taskflow_doc_write). Карточку "
            "закроют, и всё написанное в ней уйдёт с доски; в документации "
            "знание останется и достанется следующему. Рабочий рецепт или "
            "причину сбоя — уроком в базу знаний "
            "(~/kb/lessons/ГГГГ-ММ-ДД-имя.md + python3 ~/kb/kb_add.py <файл>), "
            "короткий устойчивый факт — в память через mnemosyne_remember."
        )
    return out


def t_review(args):
    """Вердикт Reviewer по сданной задаче: одобрить или вернуть на доработку.

    Обёртка над POST /api/reviews: сама достаёт актуальную версию результата
    (её id/hash/revision нужны серверу), поэтому агенту не надо знать про
    версии. «changes_requested» дополнительно возвращает карточку в работу
    через /state — Reviewer это разрешено, владельца гейт не касается.
    """
    task_id = args["id"]
    verdict = args["verdict"]
    findings = (args.get("findings") or "").strip()

    versions = api("GET", f"/api/tasks/{task_id}/versions")
    current = next(
        (v for v in (versions.get("versions") or []) if v.get("is_current")), None
    )
    if not current:
        raise TaskFlowError(
            "у задачи нет актуальной версии результата — проверять нечего"
        )

    body = {
        "task_id": task_id,
        "version_id": current["id"],
        "artifact_hash": current["artifact_hash"],
        "criteria_version": "1",
        "task_revision": current["task_revision"],
        "verdict": verdict,
    }
    if findings:
        body["findings"] = findings

    if verdict == "changes_requested":
        if not findings:
            raise TaskFlowError("для возврата нужен комментарий: что доработать")
        api("POST", "/api/reviews", body)
        api("POST", f"/api/tasks/{task_id}/state",
            {"state": "in_progress", "comment": findings})
        return {"вердикт": "возвращено на доработку", "комментарий": findings}

    resp = api("POST", "/api/reviews", body)
    return {"вердикт": resp.get("verdict"), "комментарий": resp.get("findings")}


def upload_file(task_id: str, path: str) -> dict:
    """Заливает файл к задаче и возвращает запись вложения.

    Тело — сырые байты, имя уходит в query, тип — заголовком: так устроен
    маршрут (server/src/routes/attachments.ts). Вложение рождается без
    привязки к комментарию, её проставляет сам комментарий по списку id.
    """
    p = Path(path).expanduser()
    if not p.is_file():
        raise TaskFlowError(f"файла нет: {p}")
    data = p.read_bytes()
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    url = (
        f"{BASE}/api/tasks/{task_id}/attachments"
        f"?name={urllib.parse.quote(p.name)}&kind=comment"
    )
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": mime},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode() or "{}").get("attachment") or {}
    except urllib.error.HTTPError as e:
        raise TaskFlowError(f"загрузка {p.name} → {e.code}: {e.read().decode()[:200]}")


def t_comment(args):
    """Комментарий в ленту задачи, при необходимости — с файлами.

    ⚠️ Без files скриншот показать негде: владелец читает задачи в TaskFlow,
    и фраза «смотри скриншот выше» отсылает его в терминал, которого он не
    видит (его слова 21.08.2026: «а ты его даже не прикрепил, хотя у нас
    есть возможность туда что-то прикрепить»).
    """
    files = args.get("files") or []
    attachment_ids = [
        att["id"]
        for att in (upload_file(args["id"], f) for f in files)
        if att.get("id")
    ]
    body = {"text": args["text"]}
    if attachment_ids:
        body["attachment_ids"] = attachment_ids
    api("POST", f"/api/tasks/{args['id']}/comments", body)
    send_activity(args["id"], "edit", "ленту задачи: оставил комментарий")
    out = {"комментарий добавлен": args["id"]}
    if attachment_ids:
        out["вложений"] = len(attachment_ids)

    # Напоминание о протоколе — В ОТВЕТЕ ИНСТРУМЕНТА, а не надеждой на память
    # агента. Прецедент 21.08.2026: Гермес сделал работу и написал в карточку
    # содержательный итог, но шаги не закрыл и review не поставил — с доски
    # это выглядело как «агент пропал». Владелец: «он может у тебя где-то
    # что-то выполнять, но когда это не завязано на том, где я могу
    # контролировать, — значит не работает».
    #
    # Инструкцию при подключении агент видит один раз в начале сессии; сюда
    # он приходит в середине работы, и именно здесь напоминание срабатывает.
    try:
        task = api("GET", f"/api/tasks/{args['id']}")
        task = unwrap(task) if isinstance(task, dict) and "task" in task else task
        steps = task.get("subtasks") or []
        open_steps = [x for x in steps if not x.get("done")]
        if open_steps:
            out["дальше"] = (
                f"незакрытых шагов: {len(open_steps)} — закрывай каждый через "
                "taskflow_subtask_done с result (одно-два предложения, что "
                "сделано). Когда закрыты все, ОДИН раз taskflow_state "
                "state=review на саму задачу: без этого работа не видна "
                "владельцу на доске."
            )
        elif (task.get("agent_state") or "") == "in_progress":
            out["дальше"] = (
                "все шаги закрыты — поставь задаче taskflow_state state=review "
                "с коротким итогом, иначе она останется висеть в работе."
            )
    except TaskFlowError:
        # Подсказка необязательна: комментарий уже отправлен, и ронять
        # ответ из-за неё нельзя.
        pass
    return out


def t_subtask_done(args):
    done = args.get("done", True)
    body = {"done": bool(done)}
    # Сервер требует result от агента при done=true (server/src/routes/
    # subtasks.ts, 20.08.2026) — без него 400 "result обязателен". Раньше
    # схема этого инструмента параметр не принимала вообще: любой агент,
    # закрывающий шаг честно через MCP (как ему и велит промпт), упирался
    # в 400 и либо не закрывал шаг, либо шёл в обход сырым curl.
    if args.get("result"):
        body["result"] = args["result"]
    row = api("PATCH", f"/api/subtasks/{args['id']}", body)
    if done and row.get("task_id"):
        send_activity(row["task_id"], "edit", f"шаг «{row.get('title', '')}»: закрыл")
    out = {"шаг отмечен" if done else "отметка снята": args["id"]}
    # Напоминание в ответе, а не только в инструкции при подключении:
    # инструкцию агент видит один раз в начале сессии, а спотыкается о
    # правило на сороковом ходу, закрывая последний шаг.
    if done:
        out["дальше"] = (
            "остальные шаги — так же галочкой; когда закрыты все, ОДИН раз "
            "taskflow_state state=review на саму задачу"
        )
    return out


def t_subtask_add(args):
    body = {"title": args["title"]}
    if args.get("after_id"):
        body["after_id"] = args["after_id"]
    s = api("POST", f"/api/tasks/{args['task_id']}/subtasks", body)
    return {"шаг добавлен": s.get("title"), "id": s.get("id")}


def t_rules(_args):
    """Правила ведения учёта — с сервера, а не из чьей-то памятки.

    Те же AGENT_RULES, что приходят в ответе на claim и на взятие шага, но
    их можно спросить отдельно: Control Center показывает их исполнителю на
    экране задач и не имеет права держать свою копию.
    """
    return {"правила": api("GET", "/api/agent/rules").get("rules", [])}


def t_runtime(_args):
    """Что РЕАЛЬНО доступно сейчас в runtime Pi: только ПОДКЛЮЧЁННЫЕ
    провайдеры и их доступные модели. Никакого «теоретического» каталога и
    секретов — агенту нужен факт, а не список всего, что в принципе бывает.

    Выбираешь, чем работать задаче, или думаешь про параллель — сперва глянь
    сюда, чтобы не звать модель, которой нет.
    """
    providers = api("GET", "/api/runtime/providers").get("providers", []) or []
    connected = {
        str(p.get("provider"))
        for p in providers
        if p.get("status") == "connected"
    }
    models = api("GET", "/api/runtime/models").get("models", []) or []
    by_provider: dict = {}
    for m in models:
        prov = str(m.get("provider"))
        if m.get("available") and prov in connected:
            by_provider.setdefault(prov, []).append(m.get("id"))
    return {"подключены": by_provider}


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


TO_ALL_WORDS = {"all", "всем", "*"}


def _resolve_addressee(who: str | None) -> str:
    """Кому адресовано сообщение — ОБЯЗАТЕЛЬНО (28.08.2026, владелец: «как я
    должен догадаться, что ты мне написал, не упомянув ни слова обо мне»).

    Принимает id участника или его имя (Hermes, Claude_Bot, Максим…) — тот же
    приём, что у _project_id для проектов. Через /api/chat/participants, НЕ
    /api/agents: тот намеренно узкий (видит только тех, с кем есть общая
    задача) — для адресации в общем канале координации нужны все участники.

    «Всем» — это слово, а не пустое поле: раньше и пропуск, и ОПЕЧАТКА в имени
    молча превращались в рассылку всем, то есть промах адресации выглядел как
    норма. Теперь непонятное имя — ошибка со списком, кого можно назвать."""
    raw = (who or "").strip()
    if not raw:
        raise TaskFlowError(
            'кому? укажи to: имя участника или "всем". '
            "Пустое поле больше не значит «всем» — это должен быть явный выбор"
        )
    if raw.lower() in TO_ALL_WORDS:
        return "all"
    # Use full agents list instead of chat participants to allow addressing any agent
    people = api("GET", "/api/agents")
    for a in people:
        if a.get("id") == raw.lower() or (a.get("name") or "").strip().lower() == raw.lower():
            return a.get("id")
    known = ", ".join(a.get("name") or a.get("id") for a in people)
    raise TaskFlowError(
        f'адресат «{raw}» не найден. Можно назвать: {known} — или "всем"'
    )


def _unread_tail() -> str | None:
    """«У тебя N непрочитанных» — не отдельный опрос: heartbeat/claim/
    subtask_work агент и так дёргает на каждом шаге, переиспользуем эти
    заходы вместо второго троттлинга поверх чата."""
    try:
        n = api("GET", "/api/chat/unread").get("непрочитано", 0)
    except TaskFlowError:
        return None
    if not n:
        return None
    return f"в чате {n} непрочитанных — taskflow_chat_read()"


def t_chat_send(args):
    """Написать в канал координации агентов.

    ДВА КАНАЛА (28.08.2026, решение владельца). Твой — рабочая переписка
    исполнителей и оркестратора; второй, окно постановки задач Максима,
    тебе недоступен. Заговорить с Максимом первым нельзя: своё несёшь
    оркестратору, он решает сам или выносит владельцу. Канал выбирать не
    надо и нечем — сервер сам кладёт сообщение куда следует.

    ОКНО ПОСТАНОВКИ ЗАДАЧ (10.09.2026, карточка 4396f8c9) — не разговор, а
    диктофон: Максим наговаривает туда работу, локальная модель собирает из
    неё карточку-черновик, отвечает скрипт под учёткой «Секретарь». Тебя эти
    сообщения не касаются и не будят — адресата у них нет вовсе. Карточка
    оттуда лежит без флага готовности: пока владелец его не поднял, взять её
    нельзя, и это не сбой, а её нормальное состояние.

    НО ЕСЛИ МАКСИМ НАПИСАЛ ТЕБЕ САМ — отвечай ему, и отвечай прямо
    (28.08.2026, карточка 4caa266f): to = «Максим», ответ ляжет в ту же
    рабочую ленту, где он спросил, и оркестратор его увидит. Право
    ответить живёт сутки от последнего его сообщения тебе — пока разговор
    идёт. Не относящееся к этому разговору по-прежнему адресуется
    оркестратору.

    КОМУ — ОБЯЗАТЕЛЬНО, и для переписки агентов между собой тоже: «to»
    заполняется всегда, «всем» пишется словом. Сообщение без адресата
    сервер не примет.

    ПОВОД, А НЕ СЧЁТЧИК (правило владельца 27.08.2026): без task_id
    сообщение ложится в общую ленту и никого не будит — адресуй задачу,
    если ждёшь ответа. У сообщения есть тип: совещание (ждёшь ответа),
    делегирование, находка. Разговор закрывает МОЛЧАНИЕ: на «принято/
    сделал» новым ответом не отвечать, этим и гасится «спасибо-пожалуйста».
    Делегирование работы — через доску (assignee задачи/шага), это
    сообщение — контекст к уже назначенному, не замена назначению. Находка —
    указатель на урок/память (kb_add.py, mnemosyne_shared_remember), не
    пересказ текстом: пересказ умрёт вместе с сессией.
    """
    to_user_id = _resolve_addressee(args.get("to"))
    body: dict = {"text": args["text"], "to_user_id": to_user_id}
    if args.get("task_id"):
        body["task_id"] = args["task_id"]
    if args.get("kind"):
        body["kind"] = args["kind"]
    msg = api("POST", "/api/chat", body)
    if args.get("task_id"):
        send_activity(args["task_id"], "edit", "чат: написал по задаче")
    return {
        "отправлено": msg.get("text"),
        "кому": "всем" if to_user_id == "all" else args.get("to"),
        "id": msg.get("id"),
    }


def t_chat_typing(args):
    """Отметка «печатает…» в чате — для тех, у кого нет клавиатуры.

    У человека отметку зажигает сама строка ввода, у агента её зажигать
    нечем: сигнал подаётся явно, ОДИН раз, перед тем как браться за ответ.
    Продлевать по ходу нельзя и не нужно — пока модель сочиняет, вызвать
    инструмент она не может, поэтому сервер даёт агенту срок с запасом
    (минута) и гасит отметку сам, как только сообщение отправлено.

    Ставить её, только если действительно собираешься ответить: отметка —
    обещание Максиму, что ответ идёт, а не признак того, что сообщение
    прочитано.
    """
    body = {"state": "stop"} if args.get("state") == "stop" else {}
    resp = api("POST", "/api/chat/typing", body)
    return {
        "печатает": resp.get("печатает"),
        "гаснет через": f"{int(resp.get('гаснет_через_мс', 0) / 1000)} с"
        if resp.get("печатает")
        else "—",
    }


def t_chat_read(args):
    """История канала. limit по умолчанию 20 — это сводка для агента, не
    постраничная лента фронтенда. Заодно отмечает прочтение (chat_reads),
    поэтому хвост «N непрочитанных» после вызова обнулится.

    Без channel отдаётся всё, что тебе видно. Для исполнителя это рабочая
    переписка, для оркестратора — обе ленты сразу, и в каждой строке
    написано, из какой она: у него разговор с владельцем и служебный канал
    идут вперемешку по времени, и различать их надо по полю, а не по
    догадке."""
    limit = int(args.get("limit") or 20)
    qs = {"limit": str(limit)}
    if args.get("task_id"):
        qs["task_id"] = args["task_id"]
    if args.get("channel"):
        qs["channel"] = args["channel"]
    resp = api("GET", "/api/chat?" + urllib.parse.urlencode(qs))
    names = {a["id"]: a["name"] for a in api("GET", "/api/chat/participants")}
    try:
        api("POST", "/api/chat/read")
    except TaskFlowError:
        pass  # отметка прочтения необязательна — история важнее
    return {
        "сообщения": [
            {
                "когда": m.get("created_at"),
                "канал": "с владельцем" if m.get("channel") == "owner" else "рабочий",
                "от": m.get("from_user_name"),
                "кому": names.get(m.get("to_user_id"), "всем") if m.get("to_user_id") else "всем",
                "тип": m.get("kind") or "—",
                "задача": m.get("task_title"),
                "task_id": m.get("task_id"),
                "текст": m.get("text"),
            }
            for m in resp.get("messages", [])
        ],
        "ещё есть": resp.get("has_more", False),
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
    if args.get("state") == "in_progress" and row.get("task_id"):
        send_activity(row["task_id"], "edit", f"шаг «{row.get('title', '')}»: начал")
    out = {
        "подзадача": row.get("title"),
        # То же вычисленное поле, что и в карточке задачи (см. t_task).
        "состояние": SUBTASK_STATE_RU.get(
            row.get("state"), row.get("state") or "не в работе"
        ),
        "итог": row.get("result") or "—",
    }
    tail = _unread_tail()
    if tail:
        out["чат"] = tail
    return out


def t_projects(_args):
    """Проекты людей, на которых работает агент.

    До 14.08.2026 список приходил пустым: сервер отдавал только собственные
    проекты вызывающего, а у агента их нет. Класть задачу в проект человека
    агент при этом был вправе — приходилось угадывать идентификатор.
    """
    return {
        "проекты": [
            {"id": p.get("id"), "название": p.get("name"),
             "активных задач": p.get("task_count"),
             # Папка документации: есть — можно читать и писать заметки
             # по проекту (taskflow_docs). Нет — она заводится при
             # создании проекта или вручную владельцем.
             "документация": ("есть" if p.get("notes_folder_id")
                              else "не заведена")}
            for p in api("GET", "/api/projects")
        ],
        "как пользоваться": (
            "id подставить в taskflow_create_task как project_id; "
            "assignee_id — тот же человек, чей это проект."
        ),
    }


def _project_id(args):
    """Принимает project_id или название — как это делает t_project_tasks."""
    pid = args.get("project_id")
    if pid:
        return pid
    name = (args.get("project") or "").strip().lower()
    if not name:
        return None
    for p in api("GET", "/api/projects"):
        if (p.get("name") or "").strip().lower() == name:
            return p.get("id")
    return None


def t_docs(args):
    """Документация проекта: папка и все заметки в ней, включая вложенные."""
    pid = _project_id(args)
    if not pid:
        return {"ошибка": "не нашёл проект",
                "подсказка": "список — taskflow_projects"}
    data = api("GET", f"/api/projects/{pid}/docs")
    folder = data.get("folder")
    notes = data.get("notes") or []
    if folder is None:
        return {
            "проект": (data.get("project") or {}).get("name"),
            "документация": "папка не заведена",
            "как завести": (
                "создать проект с with_docs=true, либо попросить владельца "
                "прикрепить папку на экране проекта"
            ),
        }
    return {
        "проект": (data.get("project") or {}).get("name"),
        "папка": folder.get("name"),
        "заметок": len(notes),
        "заметки": [
            {"id": n.get("id"), "название": n.get("title") or "без названия",
             "папка": n.get("папка"), "начало": n.get("preview"),
             "изменена": n.get("updated_at")}
            for n in notes
        ],
        "как читать": "полный текст — taskflow_doc_read по id",
    }


def t_doc_read(args):
    """Заметка целиком, в markdown."""
    note_id = args.get("id")
    if not note_id:
        return {"ошибка": "нужен id заметки (его даёт taskflow_docs)"}
    n = api("GET", f"/api/notes/{note_id}?format=markdown")
    return {
        "название": n.get("title") or "без названия",
        "текст": n.get("markdown") or "",
        "изменена": n.get("updated_at"),
    }


def t_doc_write(args):
    """Создать заметку в папке проекта или дополнить существующую.

    Дописывание (mode=append) читает текущий текст и склеивает — иначе
    агент затёр бы чужую документацию, обновляя свой раздел.
    """
    text = args.get("markdown") or ""
    if not text.strip():
        return {"ошибка": "нечего записывать: markdown пуст"}

    note_id = args.get("id")
    if note_id:
        mode = args.get("mode") or "append"
        if mode == "append":
            cur = api("GET", f"/api/notes/{note_id}?format=markdown")
            text = ((cur.get("markdown") or "").rstrip() + "\n\n" + text).strip()
        n = api("PATCH", f"/api/notes/{note_id}", {"markdown": text})
        return {"готово": "заметка обновлена", "id": n.get("id"),
                "название": n.get("title")}

    pid = _project_id(args)
    if not pid:
        return {"ошибка": "не нашёл проект",
                "подсказка": "укажи project_id или project, либо id заметки"}
    docs = api("GET", f"/api/projects/{pid}/docs")
    folder = docs.get("folder")
    if not folder:
        return {"ошибка": "у проекта нет папки документации",
                "как завести": "создать проект с with_docs=true "
                               "или попросить владельца прикрепить папку"}
    n = api("POST", "/api/notes",
            {"markdown": text, "folder_id": folder.get("id")})
    return {"готово": "заметка создана", "id": n.get("id"),
            "название": n.get("title"), "папка": folder.get("name")}


def t_kb_search(args):
    """Смысловой поиск по всей документации проектов.

    Отличие от taskflow_docs: тот показывает СПИСОК заметок одного проекта, а
    здесь ищется по СОДЕРЖАНИЮ всех сразу, включая проекты, которых уже нет.
    Отвечает кусками текста; за целым документом — taskflow_doc_read по id.
    """
    q = (args.get("query") or args.get("q") or "").strip()
    if not q:
        return {"ошибка": "нужен текст запроса (query)"}
    top_k = args.get("top_k") or 5
    data = api("GET", "/api/knowledge/search?q=%s&top_k=%s"
               % (urllib.parse.quote(q), int(top_k)))
    results = data.get("results") or []
    if not results:
        return {"запрос": q, "найдено": 0,
                "подсказка": "ничего похожего в документации нет — "
                              "возможно, стоит записать это самому "
                              "(taskflow_doc_write)"}
    return {
        "запрос": q,
        "найдено": len(results),
        "куски": [
            {
                "текст": (r.get("text") or "")[:1500],
                "близость": round(r.get("score") or 0, 3),
                "id_заметки": r.get("doc_id"),
            }
            for r in results
        ],
        "как читать целиком": "taskflow_doc_read(id=<id_заметки>)",
    }


def t_project_tasks(args):
    """Задачи проекта — чтобы агент брал работу по проекту, а не только ту,
    что уже назначена на его учётку.

    Дыра, найденная 21.08.2026: `taskflow_my_tasks` показывает лишь задачи с
    assignee = агент, а работа проекта висит на владельце. Списка задач
    проекта по MCP не было вовсе, и он добывался запросом к API руками —
    ровно то, чего быть не должно.
    """
    want = (args.get("project") or "").strip().lower()
    pid = args.get("project_id")
    if not pid and want:
        for p in api("GET", "/api/projects"):
            if (p.get("name") or "").strip().lower() == want:
                pid = p.get("id")
                break
        if not pid:
            return {"ошибка": f"проект «{args['project']}» не найден",
                    "подсказка": "список проектов — taskflow_projects"}
    if not pid:
        return {"ошибка": "нужен project_id или project (название)"}

    tasks = [t for t in as_tasks(api("GET", "/api/tasks")) if t.get("project_id") == pid]
    if args.get("include_completed") is not True:
        tasks = [t for t in tasks if t.get("status") == "active"]
    state = (args.get("state") or "").strip()
    if state == "free":
        tasks = [t for t in tasks if not t.get("agent_state")]
    elif state:
        tasks = [t for t in tasks if t.get("agent_state") == state]
    # Просроченные и ближние по сроку — первыми: агент берёт следующую работу
    # сверху списка, и порядок должен отвечать на вопрос «что горит».
    tasks.sort(key=lambda t: (t.get("due_date") is None, t.get("due_date") or ""))
    return {"всего": len(tasks), "задачи": [short(t) for t in tasks]}


def t_create_task(args):
    body = {"title": args["title"]}
    for key in ("description", "project_id", "assignee_id", "due_date", "priority"):
        if args.get(key) is not None:
            body[key] = args[key]
    if args.get("subtasks"):
        body["subtasks"] = args["subtasks"]
    return {"задача создана": short(unwrap(api("POST", "/api/tasks", body)))}


def t_create_project(args):
    """Завести проект — дверь, которой у агента не было до 27.08.2026.

    Замысел владельца: «Переговорка» — это ХАБ. Он кидает туда одну задачу,
    оркестратор подхватывает её и заводит ПОД НЕЁ отдельный проект, где и
    разворачивает работу с исполнителями. В заходе 26.08 замысел не сработал
    по двум причинам сразу: этого инструмента не существовало, а промпт прямо
    велел заводить дочерние задачи в том же проекте «Переговорка». Оркестратор
    отработал ровно по инструкции — винить его не в чем.

    with_docs=True по умолчанию: у проекта сразу появляется папка
    документации, чтобы итог работы было куда сложить (server/src/routes/
    projects.ts заводит её только по явному запросу).
    """
    body = {"name": args["name"], "with_docs": args.get("with_docs", True)}
    if args.get("color"):
        body["color"] = args["color"]
    created = unwrap(api("POST", "/api/projects", body))
    return {
        "проект создан": {
            "id": (created or {}).get("id"),
            "название": (created or {}).get("name"),
            "папка документации": "заведена" if body["with_docs"] else "нет",
        },
        "дальше": "id подставлять в taskflow_create_task(project_id=...) и "
                  "taskflow_doc_write(project_id=...)",
    }


def t_suggest_subtasks(args):
    """Умная разбивка на подзадачи — та же кнопка, что у владельца в форме
    задачи (server/src/routes/ai.ts, suggestSubtasks). Дан id существующей
    задачи — разбивает её; без id — черновик по title/description, который
    ещё не создан.

    Заведено 26.08.2026 для оркестратора: владелец прямо попросил, чтобы
    агенты, дробящие работу на подзадачи, пользовались тем же умным
    инструментом, что и он сам, а не изобретали разбивку в голове.

    Ничего не сохраняет — возвращает список строк, дальше решаешь сам:
    taskflow_subtask_add по каждому пункту или subtasks= при
    taskflow_create_task.
    """
    body = {}
    if args.get("provider"):
        body["provider"] = args["provider"]
    if args.get("id"):
        if args.get("title"):
            body["title"] = args["title"]
        if args.get("description") is not None:
            body["description"] = args["description"]
        resp = api("POST", f"/api/tasks/{args['id']}/suggest-subtasks", body)
    else:
        if not args.get("title"):
            raise TaskFlowError("нужен либо id существующей задачи, либо title черновика")
        body["title"] = args["title"]
        if args.get("description") is not None:
            body["description"] = args["description"]
        resp = api("POST", "/api/ai/suggest-subtasks", body)
    return {"подзадачи": resp.get("subtasks", [])}


def t_my_stats(args):
    """Мои выполненные задачи по периодам (неделя, месяц) — счётчик +
    названия последних (не полные карточки). Спрашивать сюда, когда
    владелец интересуется 'что сделал за неделю/месяц', а не гадать и не
    перечитывать всю доску."""
    return api("GET", "/api/tasks/my-stats")


def t_structure_dictation(args):
    """Причесать сырой/надиктованный текст в чистую задачу — тот же AI-мост,
    что у владельца при голосовой диктовке (server/src/routes/ai.ts,
    structureTask). Полезно, когда владелец в TaskFlow/Telegram накидал
    задачу разговорным текстом, а оркестратору нужно ЧИСТОЕ title +
    description + subtasks + due_date + priority, прежде чем заводить
    задачи и раздавать их дальше.

    Ничего не создаёт сам — возвращает разобранную структуру, дальше
    taskflow_create_task с этими полями.
    """
    text = (args.get("text") or "").strip()
    if not text:
        raise TaskFlowError("text не может быть пустым")
    body = {"text": text}
    if args.get("provider"):
        body["provider"] = args["provider"]
    resp = api("POST", "/api/ai/structure-task", body)
    return {
        "название": resp.get("title"),
        "описание": resp.get("description"),
        "подзадачи": resp.get("subtasks", []),
        "срок": resp.get("dueDate"),
        "приоритет": resp.get("priority"),
    }


# ---------------------------------------------------------------- инструменты исследователя
#
# Владелец 20.09.2026: «в модель должен заходить готовый markdown без лишнего
# мусора» и «добавить распознавание документов и сканов». Первое — _html_to_markdown
# (убираем меню/рекламу/скрипты, берём статью), второе — t_ocr (tesseract rus+eng,
# PDF со сканом рендерим через pdftoppm).

def _html_to_markdown(html: str) -> str:
    """HTML → чистый markdown: выбрасываем скрипты, стили, навигацию, подвалы
    и формы; берём основную статью (article/main, иначе самый текстовый div)."""
    from bs4 import BeautifulSoup
    import html2text
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "iframe", "template",
                     "nav", "footer", "header", "aside", "form", "button", "figure"]):
        tag.decompose()
    node = soup.find("article") or soup.find("main") or soup.find(attrs={"role": "main"})
    if node is None:
        best, best_len = None, 0
        for div in soup.find_all("div"):
            n = len(div.get_text(strip=True))
            if n > best_len:
                best, best_len = div, n
        node = best or soup.body or soup
    conv = html2text.HTML2Text()
    conv.body_width = 0
    conv.ignore_images = True
    return conv.handle(str(node)).strip()


def t_web_get(args):
    """Скачать страницу и вернуть её основное содержимое чистым markdown."""
    url = str(args.get("url") or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise TaskFlowError("нужен http(s)-адрес")
    import requests
    try:
        resp = requests.get(url, timeout=40, headers={
            "User-Agent": "Mozilla/5.0 (compatible; TaskFlow-Research/1.0)",
            "Accept-Language": "ru,en;q=0.8",
        })
        resp.raise_for_status()
    except Exception as e:  # noqa: BLE001 — наружу понятный текст
        raise TaskFlowError(f"не удалось скачать {url}: {e}")
    ctype = (resp.headers.get("content-type") or "").lower()
    if "html" in ctype or "xml" in ctype or not ctype:
        text = _html_to_markdown(resp.text)
    else:
        text = resp.text
    cap = int(args.get("max_chars") or 24000)
    return {
        "url": url,
        "markdown": text[:cap],
        "chars": len(text),
        "truncated": len(text) > cap,
    }


def t_ocr(args):
    """Распознать текст из документа или скана (изображение/PDF)."""
    att_id = str(args.get("attachment_id") or "").strip()
    path = str(args.get("path") or "").strip()
    langs = str(args.get("langs") or "rus+eng")
    cap = int(args.get("max_chars") or 24000)
    if not att_id and not path:
        raise TaskFlowError("нужен attachment_id или path")

    import glob
    import mimetypes
    import shutil
    import subprocess
    import tempfile

    work = tempfile.mkdtemp(prefix="tf-ocr-")
    try:
        if att_id:
            req = urllib.request.Request(
                f"{BASE}/api/attachments/{att_id}",
                headers={"Authorization": f"Bearer {TOKEN}"},
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                ctype = (r.headers.get("Content-Type") or "").split(";")[0]
            ext = mimetypes.guess_extension(ctype) or ".bin"
            path = os.path.join(work, "src" + ext)
            with open(path, "wb") as f:
                f.write(data)

        ext = os.path.splitext(path)[1].lower()
        text = ""
        pages = 0
        if ext == ".pdf":
            txt = subprocess.run(["pdftotext", "-layout", path, "-"],
                                 capture_output=True, text=True, timeout=120)
            text = (txt.stdout or "").strip()
            if len(text) < 40:
                subprocess.run(
                    ["pdftoppm", "-r", "200", "-png", path, os.path.join(work, "p")],
                    capture_output=True, text=True, timeout=300,
                )
                chunks = []
                for img in sorted(glob.glob(os.path.join(work, "p*.png"))):
                    pages += 1
                    out = subprocess.run(["tesseract", img, "stdout", "-l", langs],
                                         capture_output=True, text=True, timeout=180)
                    chunks.append((out.stdout or "").strip())
                text = "\n\n".join(chunks)
        elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"):
            out = subprocess.run(["tesseract", path, "stdout", "-l", langs],
                                 capture_output=True, text=True, timeout=180)
            text = (out.stdout or "").strip()
            pages = 1
        else:
            raise TaskFlowError(f"распознавание для {ext or 'без расширения'} не поддержано")

        return {
            "text": text[:cap],
            "chars": len(text),
            "pages": pages,
            "truncated": len(text) > cap,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)

# ---------------------------------------------------------------- поиск в интернете
#
# Владелец 20.09.2026: «возьми ключ из хранилища и организуй, чтобы агент искал».
# Основной провайдер — Tavily; но с .110 он отдаёт 403 (блок по IP), поэтому
# при отказе молча уходим на Brave (ключ тоже в хранилище). Один раз убедились,
# что Tavily недоступен — больше к нему не ходим в этом процессе.

_TAVILY_USABLE = True


def _vault_read(name: str) -> str:
    r = subprocess.run([sys.executable, VAULT_GET, "--raw", name],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not r.stdout.strip():
        raise TaskFlowError(f"ключ {name} не выдан хранилищем")
    return r.stdout.strip()


def _tavily_search(query: str, n: int, key: str):
    import requests
    resp = requests.post(
        "https://api.tavily.com/search",
        json={"query": query, "max_results": n},
        headers={"Authorization": f"Bearer {key}"},
        timeout=30,
    )
    resp.raise_for_status()
    return [
        {"title": r.get("title"), "url": r.get("url"), "snippet": r.get("content")}
        for r in (resp.json().get("results") or [])
    ]


def _brave_search(query: str, n: int, key: str):
    import requests
    resp = requests.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": n},
        headers={"X-Subscription-Token": key, "Accept": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    out = []
    for r in ((resp.json().get("web") or {}).get("results") or []):
        out.append({"title": r.get("title"), "url": r.get("url"), "snippet": r.get("description")})
    return out


def t_web_search(args):
    """Найти в интернете: Tavily, при недоступности — Brave. Возвращает список
    результатов со ссылками; текст страницы потом бери через taskflow_web_get."""
    global _TAVILY_USABLE
    query = str(args.get("query") or "").strip()
    if not query:
        raise TaskFlowError("нужен query")
    n = max(1, min(int(args.get("max_results") or 5), 10))
    errors = []

    if _TAVILY_USABLE:
        try:
            key = _vault_read("TAVILY_API_KEY")
            results = _tavily_search(query, n, key)
            return {"query": query, "provider": "tavily", "results": results}
        except Exception as e:  # noqa: BLE001
            errors.append(f"tavily: {e}")
            # 403 = блок по IP, дальше смысла нет в этом процессе
            if "403" in str(e):
                _TAVILY_USABLE = False

    try:
        key = _vault_read("BRAVE_API_KEY")
        results = _brave_search(query, n, key)
        return {"query": query, "provider": "brave", "results": results}
    except Exception as e:  # noqa: BLE001
        errors.append(f"brave: {e}")

    raise TaskFlowError("поиск не удался: " + "; ".join(errors))

def t_report(args):
    """Собрать отчёт по задаче: markdown → светлый HTML + PDF, зеркало-заметка
    в документации проекта. Титул несёт «когда, кем, по какой задаче»."""
    task_id = str(args.get("task_id") or args.get("id") or "").strip()
    title = str(args.get("title") or "Отчёт").strip()
    markdown = str(args.get("markdown") or "").strip()
    if not task_id:
        raise TaskFlowError("нужен task_id")
    if len(markdown) < 20:
        raise TaskFlowError("markdown слишком короткий")
    r = api("POST", f"/api/tasks/{task_id}/reports",
            {"title": title, "markdown": markdown})
    return {
        "отчёт": r.get("title"),
        "report_id": r.get("id"),
        "заметка_в_доках": r.get("note_id"),
        "автор": r.get("author"),
        "составлен": r.get("date"),
    }

# ---------------------------------------------------------------- YouTube

def _vtt_to_text(vtt: str) -> str:
    """VTT-субтитры → читаемый текст: без таймкодов, тегов и повторов
    (авто-субтитры идут «катящейся» строкой и дублируют соседние куски)."""
    import re
    lines = []
    recent = []
    for raw in vtt.splitlines():
        s = raw.strip()
        if not s or s == "WEBVTT" or "-->" in s or s.startswith(("NOTE", "STYLE")):
            continue
        if s.isdigit():
            continue
        s = re.sub(r"<[^>]+>", "", s)
        s = s.replace("&amp;", "&").replace("&nbsp;", " ").strip()
        if not s:
            continue
        if s in recent:
            continue
        lines.append(s)
        recent.append(s)
        if len(recent) > 24:
            recent.pop(0)
    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def t_youtube(args):
    """Транскрипт видео YouTube в текст (ручные субтитры, иначе авто)."""
    url = str(args.get("url") or "").strip()
    if not url:
        raise TaskFlowError("нужен url")
    langs = str(args.get("langs") or "ru,en")
    cap = int(args.get("max_chars") or 24000)

    import glob
    import shutil
    import subprocess
    import tempfile

    work = tempfile.mkdtemp(prefix="tf-yt-")
    try:
        meta = subprocess.run(
            ["yt-dlp", "--skip-download", "--extractor-args",
             "youtube:player_client=web,mweb", "--print", "%(title)s", url],
            capture_output=True, text=True, timeout=60,
        )
        title = (meta.stdout or "").strip().splitlines()[0] if meta.stdout.strip() else ""

        subs = subprocess.run(
            ["yt-dlp", "--skip-download", "--extractor-args",
             "youtube:player_client=web,mweb",
             "--write-subs", "--write-auto-subs",
             "--sub-langs", langs, "--sub-format", "vtt", "--convert-subs", "vtt",
             "-o", os.path.join(work, "s.%(ext)s"), url],
            capture_output=True, text=True, timeout=240,
        )
        files = sorted(glob.glob(os.path.join(work, "*.vtt")))
        if not files:
            # Владелец 30.09.2026: раньше здесь молча врали «нет субтитров»
            # на ЛЮБОЙ сбой yt-dlp — бан за бота, сеть, что угодно — потому
            # что код result скачивания вообще не смотрел. Найдено живьём:
            # видео Стива Джобса (Stanford, точно с субтитрами) тоже давало
            # эту же фразу — настоящая причина была в stderr, которую никто
            # не читал. Теперь при пустом files разбираем stderr сами: если
            # похоже на антибот-блок YouTube — говорим прямо, не выдаём его
            # за «у видео нет субтитров» (это разные, несмежные причины и
            # разные действия в ответ — ждать не поможет прокси починить).
            stderr = (subs.stderr or "").strip()
            if "Sign in to confirm" in stderr or "not a bot" in stderr:
                raise TaskFlowError(
                    "YouTube требует подтверждения «я не бот» с этого IP/сети — "
                    "не про субтитры конкретного видео, антибот-блок. "
                    f"yt-dlp: {stderr.splitlines()[-1][:300] if stderr else ''}"
                )
            if subs.returncode != 0 and stderr:
                raise TaskFlowError(f"yt-dlp не смог получить субтитры (код {subs.returncode}): {stderr.splitlines()[-1][:300]}")
            raise TaskFlowError("у видео нет субтитров (ни ручных, ни авто)")
        with open(files[0], encoding="utf-8", errors="ignore") as f:
            text = _vtt_to_text(f.read())
        return {
            "title": title,
            "url": url,
            "transcript": text[:cap],
            "chars": len(text),
            "truncated": len(text) > cap,
            "sub_file": os.path.basename(files[0]),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)

# ---------------------------------------------------------------- локальная модель
#
# Владелец 21.09.2026: у роли researcher должен быть ЯВНЫЙ этап «синтез локальной
# моделью» — как в серверном конвейере. Даём агенту инструмент: он присылает
# собранный материал, локальная Ollama на .110 возвращает связный текст. Ничего
# наружу не ходит, деньги не тратятся.
OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.6-27b-iq4-16k:latest")


def t_local_model(args):
    """Прогнать текст через ЛОКАЛЬНУЮ модель (Ollama на .110). Для этапа
    «синтез»: собранные факты → связный черновик/сводка."""
    prompt = str(args.get("prompt") or args.get("text") or "").strip()
    if not prompt:
        raise TaskFlowError("нужен prompt (задание локальной модели)")
    system = str(args.get("system") or "").strip()
    model = str(args.get("model") or OLLAMA_MODEL)
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,
        "options": {
            "num_ctx": int(args.get("num_ctx") or 16384),
            "num_predict": int(args.get("max_tokens") or 4096),
            "temperature": 0.2,
        },
    }
    req = urllib.request.Request(
        OLLAMA_BASE + "/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        raise TaskFlowError(f"локальная модель недоступна: {e}")
    msg = data.get("message") or {}
    text = (msg.get("content") or msg.get("thinking") or "").strip()
    if not text:
        raise TaskFlowError("локальная модель вернула пустой ответ")
    return {"model": model, "text": text}


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
        "description": "Взять задачу в работу (agent_state → in_progress). Дальше нужно продлевать аренду: срок 5 минут.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
        "fn": t_claim,
    },
    {
        "name": "taskflow_heartbeat",
        "description": "Продлить аренду задачи, пока работа идёт. Без этого через 5 минут задача покажется брошенной.",
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
        "name": "taskflow_review",
        "description": "Вердикт Reviewer по сданной задаче. verdict=approved одобряет результат (комментарий обязателен); verdict=changes_requested возвращает карточку в работу (комментарий обязателен). Только для роли Critic/Verifier.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "verdict": {"type": "string", "description": "approved | changes_requested"},
                "findings": {"type": "string", "description": "комментарий к вердикту (обязателен)"},
            },
            "required": ["id", "verdict"],
        },
        "fn": t_review,
    },
    {
        "name": "taskflow_comment",
        "description": "Написать комментарий в ленту задачи. files — пути к файлам на этой машине (скриншоты, логи): они прикрепятся к комментарию, и владелец увидит их в задаче. Ссылаться на картинку, не приложив её, бесполезно — терминала он не видит.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "text": {"type": "string"},
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "пути к файлам, которые надо приложить",
                },
            },
            "required": ["id", "text"],
        },
        "fn": t_comment,
    },
    {
        "name": "taskflow_subtask_done",
        "description": "Отметить шаг задачи сделанным (или снять отметку, done=false). При done=true передай result — что сделано (сервер требует его от агента).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "done": {"type": "boolean"},
                "result": {
                    "type": "string",
                    "description": "Что сделано, одно-два предложения. Обязателен при done=true, если у шага ещё нет result.",
                },
            },
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
        "name": "taskflow_rules",
        "description": "Правила ведения учёта задач — как их требует сервер TaskFlow. Те же, что приходят при взятии задачи и шага; здесь их можно спросить, ничего не занимая.",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_rules,
    },
    {
        "name": "taskflow_runtime",
        "description": "Что реально доступно сейчас в runtime Pi: подключённые провайдеры и их доступные модели. Только факт, без всего каталога.",
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_runtime,
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
        "name": "taskflow_chat_send",
        "description": (
            "Написать в рабочий канал координации агентов (Клод, Гермес и "
            "остальные). МАКСИМУ НАПРЯМУЮ НЕ ПИШУТ: у него отдельный канал с "
            "оркестратором, ответа от владельца ждать не нужно — вопрос неси "
            "оркестратору, он решит сам или вынесет владельцу. "
            "КОМУ — ОБЯЗАТЕЛЬНО, включая переписку агентов "
            "между собой: `to` = имя участника или слово «всем». Без "
            "адресата сервер сообщение не примет. ПОВОД, А НЕ СЧЁТЧИК: без task_id сообщение ложится "
            "в общую ленту и никого не будит — указывай task_id, если ждёшь "
            "ответа по делу. kind — тип сообщения: совещание (ждёшь ответа), "
            "делегирование, находка. Разговор закрывает молчание: на "
            "«принято/сделал» новым сообщением не отвечать. Делегирование "
            "работы идёт через назначение на доске, не через этот чат — "
            "здесь только контекст к уже назначенной задаче."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "to": {
                    "type": "string",
                    "description": (
                        "Кому — ОБЯЗАТЕЛЬНО: имя участника (Hermes, "
                        "Claude_Bot, Максим…), его id или слово «всем». "
                        "Пропустить нельзя, «всем» пишется явно."
                    ),
                },
                "task_id": {
                    "type": "string",
                    "description": "Задача, к которой относится сообщение — без неё никого не будит.",
                },
                "kind": {
                    "type": "string",
                    "description": "совещание | делегирование | находка",
                },
            },
            "required": ["text", "to"],
        },
        "fn": t_chat_send,
    },
    {
        "name": "taskflow_chat_typing",
        "description": (
            "Зажечь в чате отметку «печатает…» под своим именем — вызывать "
            "ПЕРЕД тем, как сочинять ответ, чтобы Максим видел, что ответ "
            "идёт, а не тишина. Одного вызова хватает на весь ответ: отметка "
            "живёт минуту и гаснет сама, а отправленное сообщение снимает её "
            "сразу. state='stop' — передумал отвечать. Ставить только когда "
            "действительно отвечаешь: это обещание ответа, а не отметка "
            "«прочитал»."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "state": {
                    "type": "string",
                    "description": "stop — снять отметку (передумал отвечать)",
                },
            },
        },
        "fn": t_chat_typing,
    },
    {
        "name": "taskflow_chat_read",
        "description": (
            "История канала координации, свежие сообщения. Заодно отмечает "
            "прочитанным. Без channel отдаётся всё, что тебе видно; у каждого "
            "сообщения написано, из рабочего оно канала или из окна "
            "постановки задач владельца."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "по умолчанию 20"},
                "task_id": {"type": "string", "description": "только переписка по этой задаче"},
                "channel": {
                    "type": "string",
                    "description": "owner (окно постановки задач владельца) | agents (рабочая переписка). Пусто — всё видимое.",
                },
            },
        },
        "fn": t_chat_read,
    },
    {
        "name": "taskflow_subtask_work",
        "description": (
            "Отметить, что работаешь над подзадачей. state='in_progress' — берусь "
            "(в ленте закрутится значок), 'blocked' — упёрся, ждёшь владельца "
            "(result ОБЯЗАТЕЛЕН — что именно мешает), null — отпустить. "
            "Без state — продлить работу (как heartbeat: молчание дольше 5 минут "
            "гасит значок). "
            "⚠️ 'review' на шаге НЕ ставится: приёмка шагов отменена, сервер "
            "отклонит. Сделал шаг — закрывай галочкой (taskflow_subtask_done "
            "с result). review ставится один раз на всю задачу, когда закрыты "
            "все шаги."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "state": {
                    "type": ["string", "null"],
                    "description": "in_progress | blocked | review | null",
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
        "name": "taskflow_project_tasks",
        "description": "Задачи проекта — не только назначенные на агента. Сортировка по сроку: что горит, то сверху. project — название («AI Control Center»), либо project_id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "название проекта"},
                "project_id": {"type": "string"},
                "state": {"type": "string", "description": "free | in_progress | review | blocked"},
                "include_completed": {"type": "boolean", "description": "показать и выполненные"},
            },
        },
        "fn": t_project_tasks,
    },
    {
        "name": "taskflow_create_project",
        "description": "Завести проект под задачу и сразу с папкой документации. Нужен оркестратору: работа по крупной задаче разворачивается в СВОЁМ проекте, а не в хабе, куда её положил владелец.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "название по смыслу задачи"},
                "color": {"type": "string"},
                "with_docs": {"type": "boolean", "description": "папка документации, по умолчанию да"},
            },
            "required": ["name"],
        },
        "fn": t_create_project,
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
    {
        "name": "taskflow_suggest_subtasks",
        "description": (
            "Умная разбивка на подзадачи локальной/облачной AI-моделью — тот "
            "же инструмент, что у владельца в форме задачи, не своя ручная "
            "разбивка. Передай id существующей задачи (разобьёт её title/"
            "description) ЛИБО title черновика ещё не созданной задачи. "
            "Ничего не сохраняет — только возвращает список строк-шагов; "
            "сохранить их — taskflow_subtask_add по каждому или subtasks= "
            "при taskflow_create_task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "id существующей задачи (опционально)"},
                "title": {"type": "string", "description": "нужен, если id не передан"},
                "description": {"type": "string"},
                "provider": {"type": "string", "description": "local | claude | hermes | deepseek | antigravity — необязательно"},
            },
        },
        "fn": t_suggest_subtasks,
    },
    {
        "name": "taskflow_structure_dictation",
        "description": (
            "Причесать сырой/надиктованный текст в чистую задачу тем же "
            "AI-мостом, что у владельца при голосовой диктовке: вернёт "
            "title, description, subtasks, due_date, priority. Полезно, "
            "когда задание пришло разговорным текстом (из чата, транскрипта, "
            "заметки) и нужна структура ПЕРЕД тем, как заводить задачи и "
            "раздавать их. Ничего не создаёт сам."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "provider": {"type": "string", "description": "local | claude | hermes | deepseek | antigravity — необязательно"},
            },
            "required": ["text"],
        },
        "fn": t_structure_dictation,
    },
    {
        "name": "taskflow_my_stats",
        "description": (
            "Мои выполненные задачи по периодам — счётчик и названия "
            "последних за неделю и за месяц, БЕЗ полных карточек. Звать, "
            "когда владелец спрашивает про объём/итоги своей же работы за "
            "период — не выдумывать ответ и не перечитывать всю доску."
        ),
        "inputSchema": {"type": "object", "properties": {}},
        "fn": t_my_stats,
    },
    {
        "name": "taskflow_docs",
        "description": (
            "Документация проекта: папка заметок и всё, что в ней лежит "
            "(включая вложенные папки). Отсюда берутся id для "
            "taskflow_doc_read. project — название либо project_id."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "название проекта"},
                "project_id": {"type": "string"},
            },
        },
        "fn": t_docs,
    },
    {
        "name": "taskflow_doc_read",
        "description": "Прочитать заметку документации целиком, в markdown. id даёт taskflow_docs.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
        "fn": t_doc_read,
    },
    {
        "name": "taskflow_doc_write",
        "description": (
            "Записать документацию. Без id — новая заметка в папке проекта. "
            "С id — дополнить существующую (mode=append, по умолчанию) или "
            "переписать целиком (mode=replace). Текст — markdown; первая "
            "строка становится названием."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "markdown": {"type": "string", "description": "текст заметки"},
                "project": {"type": "string", "description": "название проекта"},
                "project_id": {"type": "string"},
                "id": {"type": "string", "description": "id существующей заметки"},
                "mode": {"type": "string", "description": "append | replace"},
            },
            "required": ["markdown"],
        },
        "fn": t_doc_write,
    },
    {
        "name": "taskflow_kb_search",
        "description": (
            "Найти в документации проектов по смыслу: похожее уже разбирали? "
            "Ищет по содержанию ВСЕХ проектов сразу, включая закрытые. "
            "Отвечает кусками текста с id заметки — целиком читать "
            "через taskflow_doc_read."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "вопрос своими словами"},
                "top_k": {"type": "integer", "description": "сколько кусков вернуть, по умолчанию 5"},
            },
            "required": ["query"],
        },
        "fn": t_kb_search,
    },
    {
        "name": "taskflow_report",
        "description": (
            "Собрать ОТЧЁТ по задаче из markdown: светлый печатный HTML + PDF, "
            "с отметкой когда/кем/по какой задаче. Физически ложится заметкой в "
            "документацию проекта, в карточке задачи виден в секции «Отчёты». "
            "Пиши разделы сам (введение, анализ данных, заключение). "
            "Вёрстка умеет КАЧЕСТВЕННЫЕ ТАБЛИЦЫ (обычные markdown-таблицы), "
            "СХЕМЫ и ГРАФИКИ:\n"
            "• СХЕМА/диаграмма — блок с языком mermaid, например:\n"
            "```mermaid\nflowchart TD\n  A[Вопрос] --> B[Сбор] --> C[Отчёт]\n```\n"
            "поддерживаются flowchart, sequenceDiagram, gantt, pie, timeline;\n"
            "• ГРАФИК из данных — блок с языком chart (спека Vega-Lite JSON), "
            "например:\n```chart\n"
            '{"data":{"values":[{"x":"A","y":3}]},'
            '"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},'
            '"y":{"field":"y","type":"quantitative"}}}\n```'
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "id задачи"},
                "title": {"type": "string", "description": "название отчёта"},
                "markdown": {"type": "string", "description": "текст отчёта в markdown"},
            },
            "required": ["task_id", "title", "markdown"],
        },
        "fn": t_report,
    },
]
BY_NAME = {t["name"]: t for t in TOOLS}


def allowed_tool_names() -> frozenset[str] | None:
    """Return the profile allowlist, or ``None`` when no profile is set.

    Claude MCP profiles pass a comma-separated list through the environment.
    Keeping the filter in the server makes ``tools/list`` and ``tools/call``
    agree; a client cannot bypass a profile merely by naming a hidden tool.
    """
    raw = os.environ.get("TASKFLOW_MCP_TOOLS", "").strip()
    if not raw:
        return None
    return frozenset(name.strip() for name in raw.split(",") if name.strip())


def instruction_text(key, fallback):
    """Per-run snapshot only. No change to names, schema or handlers."""
    file = os.environ.get("TASKFLOW_INSTRUCTION_SNAPSHOT")
    if not file:
        return fallback
    with open(file, encoding="utf-8") as stream:
        snapshot = json.load(stream)
    value = snapshot.get("texts", {}).get(key, fallback)
    if not isinstance(value, str):
        raise ValueError("instruction snapshot text must be a string")
    return value


def public_tools():
    allowed = allowed_tool_names()
    visible = TOOLS if allowed is None else [t for t in TOOLS if t["name"] in allowed]
    return [{"name": t["name"], "description": instruction_text("tool.mcp." + t["name"], t["description"]), "inputSchema": t["inputSchema"]} for t in visible]


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
            # ⚠️ Этот текст видит КАЖДЫЙ агент при подключении — он попадает
            # в системный промпт сессии. Поэтому здесь не общие слова, а
            # короткий конспект конвейера + указатель на полную версию
            # (taskflow_rules, доступен по MCP-инструменту и прилетает в
            # ответе на claim). Полные правила живут в AGENT_RULES на
            # сервере (server/src/agentState.ts) и применяются одинаково ко
            # всем оболочкам — Claude, Hermes, DeepSeek, Antigravity,
            # локальная ollama. Менять текст правил = править сервер, а
            # не чей-то CLAUDE.md. История: инструкция разрослась до ~70
            # строк и дублировала taskflow_rules, переписана 14.09.2026
            # после обсуждения с владельцем (задача 1cc08ea5).
            "instructions": (
                instruction_text("mcp.initialize", "TaskFlow: задачи под учёткой агента. Правила соблюдать "
                "строго — сервер отклоняет нарушения.\n"
                "1. БЕРЁШЬ ЗАДАЧУ — taskflow_claim; пока работаешь, "
                "продлевай аренду taskflow_heartbeat (каждые ≤4 мин, "
                "срок 5 мин).\n"
                "2. НАЧАЛ ШАГ — taskflow_subtask_work(id, "
                "state=\"in_progress\") ДО первого инструмента по этому "
                "шагу.\n"
                "3. ШАГ ЗАКОНЧИЛ — taskflow_subtask_done(id, done=true, "
                "result=\"коротко по-человечески, что сделано\"). review "
                "на отдельном шаге НЕ ставь: приёмка шагов отменена, "
                "сервер отклонит.\n"
                "4. ВСЕ ШАГИ ЗАКРЫТЫ — ОДИН раз taskflow_state "
                "state=\"review\" на задачу, с комментарием об итоге.\n"
                "5. УПЁРСЯ — state=\"blocked\" с объяснением, что нужно "
                "от владельца. Ожидание отмашки блокировкой не "
                "считается.\n"
                "6. СКРИНШОТ ИЛИ ФАЙЛ — прикладывай: "
                "taskflow_comment(files=[...]). Владелец читает здесь, "
                "а не в твоём терминале.\n"
                "\n"
                "Полная версия правил (прочитай после claim, и далее в "
                "любой момент): MCP-инструмент taskflow_rules. Там: "
                "что ПЕРЕД claim надо прочесть карточку, как писать "
                "result, проектные заметки (taskflow_docs), память/KB, "
                "дробление (subtasks vs дочерние задачи), "
                "suggest_subtasks для оркестратора, "
                "taskflow_structure_dictation для сырого текста.")
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
        allowed = allowed_tool_names()
        if allowed is not None and name not in allowed:
            return error(rid, -32602, f"инструмент запрещён профилем: {name}")
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


# --------------------------------------------------------------------------- сеть (Streamable HTTP)

def load_net_token() -> str:
    """Гейт-токен самого сетевого эндпоинта — отдельный от TOKEN (тот ходит
    в TaskFlow API). Имя ключа переопределяется TASKFLOW_MCP_VAULT_KEY."""
    key = os.environ.get("TASKFLOW_MCP_VAULT_KEY", "TASKFLOW_MCP_TOKEN")
    try:
        r = subprocess.run(
            [sys.executable, VAULT_GET, "--raw", key],
            capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        raise TaskFlowError(f"не удалось прочитать сетевой ключ из хранилища: {e}")
    if r.returncode != 0 or not r.stdout.strip():
        raise TaskFlowError(f"ключ {key} не выдан хранилищем: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


class _MCPHTTPHandler(BaseHTTPRequestHandler):
    net_token = ""  # выставляется в serve_http() до запуска сервера

    def log_message(self, fmt, *args):  # noqa: A003 — перекрываем стандартный лог
        log(f"http {self.address_string()}: {fmt % args}")

    def _send_json(self, status: int, payload: bytes):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path.split("?", 1)[0].rstrip("/") != "/mcp":
            self.send_response(404)
            self.end_headers()
            return
        auth = self.headers.get("Authorization", "")
        presented = auth[7:] if auth.startswith("Bearer ") else ""
        if not (presented and hmac.compare_digest(presented, self.net_token)):
            return self._send_json(401, b'{"error":"unauthorized"}')
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            msg = json.loads(raw) if raw else {}
        except ValueError:
            return self._send_json(400, b'{"error":"bad json"}')
        try:
            out = handle(msg)
        except Exception as e:
            log(f"http: внутренняя ошибка: {e!r}")
            out = error(msg.get("id"), -32603, str(e))
        if out is None:
            # Уведомление (без id) — по спеке Streamable HTTP пустой ответ.
            self.send_response(202)
            self.end_headers()
            return
        self._send_json(200, json.dumps(out, ensure_ascii=False).encode())

    def do_GET(self):
        # Сервер-инициированный SSE-поток не реализован — Streamable HTTP
        # это разрешает, отвечаем 405.
        self.send_response(405)
        self.end_headers()


def serve_http(host: str, port: int) -> None:
    global TOKEN
    try:
        TOKEN = load_token()
    except TaskFlowError as e:
        log(str(e))
        TOKEN = ""
    _MCPHTTPHandler.net_token = load_net_token()
    log(f"http-режим {host}:{port}/mcp, инструментов {len(TOOLS)}, "
        f"ключ TaskFlow {'получен' if TOKEN else 'НЕ получен'}")
    ThreadingHTTPServer((host, port), _MCPHTTPHandler).serve_forever()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        _i = sys.argv.index("--serve")
        _rest = sys.argv[_i + 1:]
        _port = int(_rest[0]) if _rest and _rest[0].isdigit() else int(
            os.environ.get("TASKFLOW_MCP_PORT", "8802"))
        serve_http(os.environ.get("TASKFLOW_MCP_HOST", "0.0.0.0"), _port)
    else:
        main()
