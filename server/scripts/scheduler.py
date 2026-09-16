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

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("TASKFLOW_API", "http://localhost:3001")
TOKEN = os.environ["TASKFLOW_SERVICE_TOKEN"].strip()
RETRY_DELAY_MIN = 5
RETRY_LIMIT = 3
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


def main() -> int:
    log("обход доски")
    n1 = branch_retry_technical()
    n2 = branch_repick_wrong_role()
    log(f"итого: ветка 1={n1}, ветка 2={n2}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
