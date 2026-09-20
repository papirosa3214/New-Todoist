#!/usr/bin/env python3
"""Проба веток 4 и 5 scheduler.py без запуска службы.

scheduler.py — отдельный воркер: он не импортируется приложением, а ходит в
HTTP API. Чтобы проверить его логику детерминированно и не поднимая сервер,
проба импортирует модуль напрямую и подменяет у него ровно две точки ввода-
вывода:

  - api()            → заглушка с заданными ответами и записью вызовов;
  - subprocess.Popen → запись факта подъёма исполнителя.

Продуктовый код при этом не меняется. При импорте scheduler.py требует
TASKFLOW_SERVICE_TOKEN (fail loudly) — проба выставляет его сама.
На stdout печатается JSON; значения сверяет vitest (scheduleRepeat.test.ts).
"""
import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

os.environ.setdefault("TASKFLOW_SERVICE_TOKEN", "probe-token")

SERVER_DIR = Path(__file__).resolve().parents[2]  # test/fixtures -> server
SCHEDULER_PATH = SERVER_DIR / "scripts" / "scheduler.py"


def load_scheduler():
    spec = importlib.util.spec_from_file_location(
        "scheduler_under_test", SCHEDULER_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # Проба печатает только JSON — логи воркера в stdout не нужны.
    mod.log = lambda *args, **kwargs: None
    return mod


def run_launch(mod):
    """Ветка 4: какие карточки поднимаются, какие — нет."""
    now = dt.datetime.now()

    def stamp(delta):
        return (now + delta).strftime("%Y-%m-%d %H:%M")

    tasks = [
        # Наступило минуту назад — в окне догона, поднимаем.
        {"id": "in-window", "status": "active", "agent_state": None,
         "assignee_id": "role_builder", "run_at": stamp(dt.timedelta(minutes=-1))},
        # Старше окна догона (24 ч) — не воскрешаем.
        {"id": "too-old", "status": "active", "agent_state": None,
         "assignee_id": "role_builder", "run_at": stamp(dt.timedelta(hours=-25))},
        # Ещё не наступило.
        {"id": "future", "status": "active", "agent_state": None,
         "assignee_id": "role_builder", "run_at": stamp(dt.timedelta(hours=1))},
        # Уже закрыта.
        {"id": "completed", "status": "completed", "agent_state": None,
         "assignee_id": "role_builder", "run_at": stamp(dt.timedelta(minutes=-1))},
        # Уже кем-то занята.
        {"id": "busy", "status": "active", "agent_state": "in_progress",
         "assignee_id": "role_builder", "run_at": stamp(dt.timedelta(minutes=-1))},
        # Исполнитель — человек, не агент-роль.
        {"id": "human", "status": "active", "agent_state": None,
         "assignee_id": "user_42", "run_at": stamp(dt.timedelta(minutes=-1))},
        # Битая дата — молча пропускаем.
        {"id": "bad-date", "status": "active", "agent_state": None,
         "assignee_id": "role_builder", "run_at": "не дата"},
    ]
    launched = []

    def fake_popen(argv, **kwargs):
        launched.append(list(argv))
        return types.SimpleNamespace()

    mod.api = lambda method, path, body=None: tasks
    mod.subprocess = types.SimpleNamespace(
        Popen=fake_popen, DEVNULL=subprocess.DEVNULL
    )
    handled = mod.branch_launch_scheduled()
    return {"handled": handled, "launched_ids": [argv[-1] for argv in launched]}


def make_api(task, calls):
    def _api(method, path, body=None):
        calls.append({"method": method, "path": path, "body": body})
        if method == "GET" and path == "/api/scheduler/recurring":
            return [task]
        if method == "POST" and path == "/api/tasks":
            return {"task": {"id": "new-id"}}
        return {}
    return _api


def run_clone_case(mod, task):
    calls = []
    mod.api = make_api(task, calls)
    handled = mod.branch_clone_recurring()
    return {"handled": handled, "calls": calls}


def run_clone(mod):
    """Ветка 5: способы, которыми серия рождает следующее вхождение."""
    year = dt.datetime.now().year

    def task(tid, due, repeat, until=None):
        return {
            "id": tid, "title": "T", "description": None, "start_time": None,
            "project_id": None, "assignee_id": "role_builder",
            "due_date": due, "run_repeat": repeat, "repeat_until": until,
        }

    return {
        # Следующее вхождение в пределах года — создаём и засеваем.
        "spawn": run_clone_case(mod, task("spawn1", f"{year}-09-15", "daily")),
        # Явный repeat_until уже наступил — серия кончается без вопроса.
        "explicit_end": run_clone_case(
            mod, task("end1", f"{year}-09-15", "daily", f"{year}-09-15")
        ),
        # Следующее вхождение уходит за 31 декабря — спрашиваем владельца.
        "year_end": run_clone_case(mod, task("yend1", f"{year}-12-31", "daily")),
        # Повтор выключен — пропускаем.
        "no_repeat": run_clone_case(mod, task("none1", f"{year}-09-15", "none")),
    }


def main():
    mod = load_scheduler()
    result = {
        "next_due": {
            "daily": mod._next_due("2026-09-20", "daily"),
            "weekdays_from_friday": mod._next_due("2026-09-18", "weekdays"),
            "weekdays_from_saturday": mod._next_due("2026-09-19", "weekdays"),
            "weekly": mod._next_due("2026-09-20", "weekly"),
            "monthly_end_of_feb": mod._next_due("2026-01-31", "monthly"),
            "monthly_leap": mod._next_due("2028-01-31", "monthly"),
            "monthly_year_roll": mod._next_due("2026-12-15", "monthly"),
            "unknown": mod._next_due("2026-09-20", "none"),
            "bad_date": mod._next_due("nope", "daily"),
        },
        "launch": run_launch(mod),
        "clone": run_clone(mod),
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
