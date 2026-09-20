#!/usr/bin/env python3
"""
Сторож планировщика расписания (taskflow-scheduler).

ЗАЧЕМ. Юнит тикает раз в 5 минут и оставляет отпечаток живости в
~/.local/state/taskflow-scheduler/last-run.json. Тихий отказ здесь — не «процесс
упал» (тогда systemd видит сбой), а «systemd говорит active, а отпечаток
перестал обновляться»: таймер сбился, скрипт молча падает на входе, сервер
недоступен. Лампа «Расписание» в приложении это показывает, но на лампу никто
постоянно не смотрит. Поэтому сторож сам пишет владельцу в notifications
(тот же канал, что у agent_watch — Максим читает его в приложении).

Шлёт только о НОВОМ нарушении (state-файл рядом) — не спамить при повторных
прогонах одного и того же затянувшегося отказа. Отпечаток снова свежий —
нарушение забывается и, если вернётся, доложится заново.

ЗАПУСК: раз в 15 минут, taskflow-scheduler-watch.timer. Разовый прогон без
записи: python3 scheduler_watch.py --dry
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "scheduler-watch.state.json")
HEARTBEAT = os.path.join(os.path.expanduser("~"), ".local/state/taskflow-scheduler/last-run.json")

# Планировщик тикает раз в 5 минут. 20 минут — это четыре пропуска подряд: за
# это время обычный разовый сбой успел бы закрыться сам, а молчание дольше —
# уже настоящая поломка.
SILENCE_MIN = int(os.environ.get("SCHEDULER_SILENCE_MIN", "20"))


def owner_id(db):
    row = db.execute(
        "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def heartbeat_age_min():
    """Сколько минут назад планировщик отметился. None — отпечатка нет/битый."""
    try:
        data = json.load(open(HEARTBEAT, encoding="utf-8"))
        epoch_ms = data.get("at_epoch")
        if epoch_ms:
            return (time.time() - epoch_ms / 1000) / 60
        at = datetime.fromisoformat(data["at"])
        return (datetime.now() - at).total_seconds() / 60
    except Exception:
        return None


def timer_active():
    try:
        out = subprocess.run(
            ["systemctl", "--user", "is-active", "taskflow-scheduler.timer"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def main():
    dry = "--dry" in sys.argv
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    age = heartbeat_age_min()
    if age is None:
        problem = f"Планировщик расписания не оставил отпечаток живости ({HEARTBEAT}) — назначенные задачи могут не запускаться"
        key = "no-heartbeat"
    elif age > SILENCE_MIN:
        problem = (
            f"Планировщик расписания молчит {int(age)} мин "
            f"(таймер: {timer_active()}) — назначенные задачи не запускаются"
        )
        key = "silent"
    else:
        problem = None
        key = None

    if problem:
        print(problem)
    else:
        print(f"ок — планировщик отметился {int(age)} мин назад")

    if dry:
        return 0

    try:
        seen = json.load(open(STATE_PATH))
    except Exception:
        seen = None

    if problem and seen != key:
        owner = owner_id(db)
        if owner:
            db.execute(
                "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)"
                " VALUES (?,?,?,?,?,NULL)",
                (str(uuid.uuid4()), owner, "scheduler_watch", None, problem),
            )
            db.commit()

    # Помним только текущее состояние: стало здорово (key=None) — забыли,
    # вернулась беда — доложим снова.
    json.dump(key, open(STATE_PATH, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
