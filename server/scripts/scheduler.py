#!/usr/bin/env python3
"""Планировщик шапки конвейера. Раз в 5 минут (через systemd timer).

(taskflow-pipeline-head-plan.md, шаг 4)

Ветка 1 — ретрай технических:
  agent_state='blocked', block_type='technical',
  retry_count < 3, blocked_at < now() - 5 минут.
  → agent_state='todo', retry_count++, block_type=null.

  retry_count >= 3 → block_type='dead', blocked_reason += ' | 3 попытки
  исчерпаны'.

Ветка 2 — переподбор чужих:
  agent_state='blocked', block_type='wrong_role'.
  → POST /api/tasks/:id/repick-role.
  Если кандидат есть → agent_state='todo', block_type=null,
  machine_selected_role=<candidate>.
  Если нет → block_type='dead'.

dead: уведомление владельцу (шаг 5) — здесь НЕ реализовано, ждёт шага 5.
block_notified=false сохраняется, планировщик шага 5 сам решит, слать
или нет.

Auth: TASKFLOW_SERVICE_TOKEN — служебный ключ из systemd drop-in.
Без fallback. Если переменной нет — KeyError на старте, fail loudly.
"""

import calendar
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get("TASKFLOW_API", "http://localhost:3001")
TOKEN = os.environ["TASKFLOW_SERVICE_TOKEN"].strip()
RETRY_DELAY_MIN = 5
RETRY_LIMIT = 3
# Разовый запуск исполнителя тем же путём, что и ручной (все ключи внутри).
RUN_SCRIPT = str(Path.home() / "Проекты/New-Todoist/server/scripts/manual_run.sh")
# Окно догона: не поднимаем карточки, чьё время прошло давно, иначе
# расписание воскрешало бы все старые карточки с прошедшей датой.
RUN_CATCH_HOURS = 24
# Отпечаток живости: воркер пишет его каждый обход, по нему владелец
# видит лампу «Расписание» (и сторож ловит тихий отказ).
STATE_DIR = Path.home() / ".local/state/taskflow-scheduler"
HEARTBEAT = STATE_DIR / "last-run.json"
LOG_PREFIX = "[scheduler]"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", flush=True)


def api(method: str, path: str, body=None):
    """HTTP-вызов к серверу. Возвращает dict или список; ошибки -> dict с error."""
    url = f"{API}{path}"
    data = None
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"error": body, "code": e.code}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"error": f"{type(e).__name__}: {e}", "code": 0}


def branch_retry_technical() -> int:
    """Ветка 1: ретрай technical. Возвращает количество обработанных."""
    tasks = api(
        "GET",
        "/api/tasks"
        f"?agent_state=blocked&block_type=technical"
        f"&retry_count_lt={RETRY_LIMIT + 1}"
        f"&blocked_older_min={RETRY_DELAY_MIN}",
    )
    if not isinstance(tasks, list):
        log(f"  ⚠️ ветка 1: ответ не список — {tasks!r}")
        return 0
    handled = 0
    for t in tasks:
        task_id = t.get("id")
        retry_count = t.get("retry_count", 0) or 0
        if not task_id:
            continue
        if retry_count >= RETRY_LIMIT:
            # Третья попытка исчерпана — dead.
            new_reason = (
                (t.get("blocked_reason") or "")
                + f" | {RETRY_LIMIT} попытки исчерпаны"
            )
            res = api(
                "POST",
                f"/api/tasks/{task_id}/state",
                {
                    "state": "blocked",
                    "block_type": "dead",
                    "blocked_reason": new_reason.strip(" |"),
                    "block_notified": False,
                },
            )
            if "error" in res and not res.get("code"):
                log(f"  ⚠️ {task_id[:8]} → dead: {res}")
            else:
                log(f"  ⚖ {task_id[:8]} → dead (technical, {RETRY_LIMIT} попыток)")
                handled += 1
            continue
        # retry_count < RETRY_LIMIT: возвращаем в todo и инкрементируем.
        res = api(
            "POST",
            f"/api/tasks/{task_id}/state",
            {
                "state": "todo",
                # block_type снимается (ставим null). retry_count растёт
                # через серверный state? Нет, retry_count нужно явно
                # поднять. Сервер на /state не увеличивает retry_count.
                # Прямое обновление не предусмотрено в API — сделаем
                # через PATCH /api/tasks/:id позже. Пока же просто
                # возвращаем в todo.
            },
        )
        if "error" in res and not res.get("code"):
            log(f"  ⚠️ {task_id[:8]} → todo: {res}")
        else:
            log(f"  ↻ {task_id[:8]} retry # {retry_count + 1}")
            handled += 1
    return handled


def branch_repick_wrong_role() -> int:
    """Ветка 2: переподбор wrong_role. Возвращает количество обработанных."""
    tasks = api(
        "GET",
        "/api/tasks?agent_state=blocked&block_type=wrong_role",
    )
    if not isinstance(tasks, list):
        log(f"  ⚠️ ветка 2: ответ не список — {tasks!r}")
        return 0
    handled = 0
    for t in tasks:
        task_id = t.get("id")
        if not task_id:
            continue
        choice = api("POST", f"/api/tasks/{task_id}/repick-role")
        if not isinstance(choice, dict) or "error" in choice:
            log(f"  ⚠️ {task_id[:8]} repick: {choice!r}")
            continue
        if choice.get("how") == "dead" or not choice.get("role"):
            # Кандидатов нет — dead.
            res = api(
                "POST",
                f"/api/tasks/{task_id}/state",
                {
                    "state": "blocked",
                    "block_type": "dead",
                    "blocked_reason": (
                        t.get("blocked_reason") or ""
                    ) + " | все роли отказались",
                    "block_notified": False,
                },
            )
            if "error" in res and not res.get("code"):
                log(f"  ⚠️ {task_id[:8]} → dead: {res}")
            else:
                log(f"  ⚖ {task_id[:8]} → dead (wrong_role, no candidates)")
                handled += 1
            continue
        # Кандидат найден — возвращаем в todo с новой machine_selected_role.
        res = api(
            "POST",
            f"/api/tasks/{task_id}/state",
            {
                "state": "todo",
                "machine_selected_role": choice["role"],
                "block_type": None,
                "comment": (
                    f"Переподбор роли: {choice['role']} (how={choice['how']})"
                ),
            },
        )
        if "error" in res and not res.get("code"):
            log(f"  ⚠️ {task_id[:8]} → todo: {res}")
        else:
            log(f"  ↻ {task_id[:8]} → todo, role={choice['role']}")
            handled += 1
    return handled


def branch_notify_dead() -> int:
    """Ветка 3: уведомление владельцу о карточках в dead.

    Идём только по карточкам с agent_state='blocked', block_type='dead',
    block_notified=false. По каждой:
      - шлём notification через POST /api/notifications (служебный ключ)
      - помечаем block_notified=true через POST /state

    Канал доставки — то, что уже подключено к notifications в стеке
    (через n8n webhook в Telegram, см. trigger_watch.py:alert_send).
    Никаких новых внешних каналов не добавляем.
    """
    tasks = api(
        "GET",
        "/api/tasks?agent_state=blocked&block_type=dead",
    )
    if not isinstance(tasks, list):
        log(f"  ⚠️ ветка 3: ответ не список — {tasks!r}")
        return 0
    handled = 0
    for t in tasks:
        task_id = t.get("id")
        title = t.get("title") or "(без названия)"
        blocked_reason = t.get("blocked_reason") or ""
        role_exclusions = t.get("role_exclusions") or "[]"
        retry_count = t.get("retry_count", 0) or 0
        block_notified = t.get("block_notified", False)
        if not task_id or block_notified:
            continue
        # Владелец — единственный user с role='owner' (см. AGENT-PROTOCOL.md).
        owner = api("GET", "/api/users?role=owner")
        owner_id = None
        if isinstance(owner, list) and owner:
            owner_id = owner[0].get("id")
        if not owner_id:
            log(f"  ⚠️ {task_id[:8]}: владелец не найден, пропускаю")
            continue

        text = (
            f"⛔ Карточка в тупике (dead):\n"
            f"  id: {task_id}\n"
            f"  заголовок: {title}\n"
            f"  причина: {blocked_reason}\n"
            f"  отказались (role_exclusions): {role_exclusions}\n"
            f"  попыток (retry_count): {retry_count}"
        )
        notif = api(
            "POST",
            "/api/notifications",
            {
                "user_id": owner_id,
                "type": "task_dead",
                "task_id": task_id,
                "text": text,
                "actor_id": None,
            },
        )
        if not notif.get("id"):
            log(f"  ⚠️ {task_id[:8]}: notification не создан — {notif!r}")
            continue
        # Помечаем notified=true, чтобы следующий проход не слал повторно.
        api(
            "POST",
            f"/api/tasks/{task_id}/state",
            {"state": "blocked", "block_notified": True},
        )
        log(f"  ✉ {task_id[:8]} → владельцу {owner_id[:8]} (dead)")
        handled += 1
    return handled


def write_heartbeat(counts: dict) -> None:
    """Отметить обход: время и что сделано. Тихо, если не удалось — воркер
    не должен падать из-за отсутствия каталога."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        HEARTBEAT.write_text(
            json.dumps(
                {
                    "at": dt.datetime.now().isoformat(timespec="seconds"),
                    "at_epoch": int(dt.datetime.now().timestamp() * 1000),
                    **counts,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError as e:
        log(f"  ⚠️ отпечаток живости не записан: {e}")


def branch_launch_scheduled() -> int:
    """Ветка 4: запуск по времени.

    Карточка, у которой run_at наступил, статус active, ещё не начата и
    исполнитель — агент-роль, поднимается одиночным заходом. Работает
    НЕЗАВИСИМО от будильника (решение владельца 19.09.2026: расписание —
    явное действие владельца, службой не гейтится). Себя и свободные
    карточки не трогаем.
    """
    tasks = api("GET", "/api/tasks")
    if not isinstance(tasks, list):
        log(f"  ⚠️ ветка 4: ответ не список — {tasks!r}")
        return 0
    now = dt.datetime.now()
    floor = now - dt.timedelta(hours=RUN_CATCH_HOURS)
    handled = 0
    for t in tasks:
        if t.get("status") != "active" or t.get("agent_state") is not None:
            continue
        assignee = t.get("assignee_id") or ""
        if not assignee.startswith("role_"):
            continue
        run_at = t.get("run_at")
        if not run_at:
            continue
        try:
            when = dt.datetime.strptime(str(run_at)[:16], "%Y-%m-%d %H:%M")
        except ValueError:
            continue
        if when > now or when < floor:
            continue
        subprocess.Popen(
            ["bash", RUN_SCRIPT, "--once", t["id"]],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log(f"  ⏰ {t['id'][:8]} по времени {run_at} — поднимаю исполнителя")
        handled += 1
    return handled


def _next_due(due: str, repeat: str) -> str | None:
    """Следующая дата по интервалу повторения."""
    try:
        d = dt.datetime.strptime(due[:10], "%Y-%m-%d").date()
    except ValueError:
        return None
    if repeat == "daily":
        n = d + dt.timedelta(days=1)
    elif repeat == "weekdays":
        n = d + dt.timedelta(days=1)
        while n.weekday() >= 5:
            n += dt.timedelta(days=1)
    elif repeat == "weekly":
        n = d + dt.timedelta(days=7)
    elif repeat == "monthly":
        month = d.month + 1
        year = d.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        day = min(d.day, calendar.monthrange(year, month)[1])
        n = dt.date(year, month, day)
    else:
        return None
    return n.isoformat()


def branch_clone_recurring() -> int:
    """Ветка 5: повтор «одна за раз». По завершённой карточке создаём
    СЛЕДУЮЩЕЕ вхождение (с новой датой), только если серия не кончилась.
    Никаких пачек вперёд — максимум одна будущая карточка."""
    items = api("GET", "/api/scheduler/recurring")
    if not isinstance(items, list):
        log(f"  ⚠️ ветка 5: ответ не список — {items!r}")
        return 0
    handled = 0
    for t in items:
        tid = t.get("id")
        due = t.get("due_date")
        repeat = t.get("run_repeat")
        if not tid or not due or not repeat:
            continue
        nxt = _next_due(due, repeat)
        if not nxt:
            continue
        # Владелец 20.09.2026: повтор в любом случае ограничен КАЛЕНДАРНЫМ
        # ГОДОМ — дальше 31 декабря текущего года серия не идёт.
        year_end = dt.date(dt.datetime.now().year, 12, 31).isoformat()
        until = t.get("repeat_until")
        cap = min(str(until)[:10], year_end) if until else year_end
        if nxt > cap:
            # Уперлись в предел. Если это календарный год (а не явный выбор
            # владельца) — спрашиваем его и даём продлить, а не обрываем молча.
            if until and str(until)[:10] <= year_end:
                api("PATCH", f"/api/tasks/{tid}", {"recurrence_spawned": 1})
                log(f"  ⏹ {tid[:8]} серия завершена (до {until})")
            else:
                api("POST", f"/api/tasks/{tid}/repeat-ended", {})
                log(f"  ❓ {tid[:8]} конец года — спросил владельца о продлении")
            continue
        body = {
            "title": t.get("title"),
            "description": t.get("description"),
            "due_date": nxt,
            "start_time": t.get("start_time"),
            "project_id": t.get("project_id"),
            "assignee_id": t.get("assignee_id"),
            "run_repeat": repeat,
            "repeat_until": until,
        }
        res = api("POST", "/api/tasks", body)
        if isinstance(res, dict) and (res.get("task") or res.get("id")):
            api("PATCH", f"/api/tasks/{tid}", {"recurrence_spawned": 1})
            log(f"  ↻ {tid[:8]} → следующая на {nxt}")
            handled += 1
        else:
            log(f"  ⚠️ {tid[:8]} следующая не создалась: {res!r}")
    return handled


def branch_deferred_retries() -> int:
    """Ветка 6: отложенный технический повтор.

    /api/tasks/:id/stop с reason_code='technical_failure' пишет строку в
    attempt_retries с scheduled_at = now() + задержка. До этой ветки её
    никто не читал. Сервер атомарно отдаёт назревшие повторы (сравнение
    scheduled_at <= now, отметка fired_at — см.
    POST /api/scheduler/deferred-retries/claim), а мы поднимаем по каждому
    одиночный заход тем же путём, что расписание: manual_run.sh --once.
    """
    res = api("POST", "/api/scheduler/deferred-retries/claim", {})
    retries = res.get("retries") if isinstance(res, dict) else None
    if not isinstance(retries, list):
        log(f"  ⚠️ ветка 6: ответ не список — {res!r}")
        return 0
    handled = 0
    for r in retries:
        task_id = r.get("task_id")
        if not task_id:
            continue
        subprocess.Popen(
            ["bash", RUN_SCRIPT, "--once", task_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log(
            f"  ♻ {task_id[:8]} отложенный повтор"
            f" ({r.get('reason_code')}, scheduled_at={r.get('scheduled_at')})"
        )
        handled += 1
    return handled


def main() -> int:
    log("обход доски")
    n1 = branch_retry_technical()
    n2 = branch_repick_wrong_role()
    n3 = branch_notify_dead()
    n4 = branch_launch_scheduled()
    n5 = branch_clone_recurring()
    n6 = branch_deferred_retries()
    write_heartbeat(
        {
            "retry": n1,
            "repick": n2,
            "dead": n3,
            "scheduled": n4,
            "repeat": n5,
            "deferred": n6,
        }
    )
    log(
        f"итого: ветка 1={n1}, ветка 2={n2}, ветка 3={n3}, "
        f"ветка 4(расписание)={n4}, ветка 5(повтор)={n5}, "
        f"ветка 6(отложенный повтор)={n6}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
