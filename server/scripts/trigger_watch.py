#!/usr/bin/env python3
"""
Сторож будильника TaskFlow (taskflow-trigger.service).

ЗАЧЕМ. Юнит сам перезапускается на сбой (Restart=always), но тихий отказ
здесь не «процесс упал», а три других сценария, уже виденных 28-29.08.2026:

  1. Юнит вообще не поднялся после перезагрузки (включили после,
     симлинк в default.target.wants/ отсутствовал) — задачи назначаются,
     исполнители не приходят, понять это можно только по тишине.
  2. Юнит active, но три главных цикла зависли: WS-поток, обход доски,
     продление аренды. Тогда trigger.py живёт, но карточки стоят.
  3. Зависший дочерний процесс — main PID жив, но не реагирует на
     задачи (отдельная проверка через свежесть alive-файла).

ПРИЗНАК ЖИЗНИ — отдельный файл `STATE_DIR/alive`, который trigger.py
обновляет по таймеру раз в 30 секунд. Смотрим на его mtime, а НЕ на
trigger.log: лог пишется только когда есть ЧТО сказать, и в тихую ночь
(29.08.2026: паузы 125, 89 и 85 минут между записями) это норма, а не
отказ (замечание оркестратора 29.08.2026, 01:09). mtime alive-файла
означает «процесс в главном цикле», а не «процессу есть что сказать».

КАК ДОКЛАДЫВАЕТ: общий с agent_watch.py / chat_resident_watch.py путь —
INSERT в notifications + alert_send в Telegram. POST /api/notifications
на сервере пока нет (29.08.2026), и заводить его под локальный скрипт
дороже, чем проверить колонки перед записью: смотрим pragma_table_info
и молча пропускаем БД, если схема разошлась. Дедуп по state-файлу.
alert_send — запасная дорога мимо n8n в Telegram.

ЗАПУСК: раз в 10 минут, taskflow-trigger-watch.timer. Разовый прогон без записи:
python3 trigger_watch.py --dry
"""
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid

# Общий отправщик тревог infra-ops (тот же, что в agent_watch.py и
# chat_resident_watch.py). Мягкий импорт: без него сторож продолжает
# работать и слать уведомления прямым INSERT.
sys.path.insert(0, os.path.expanduser("~/infra-ops"))
try:
    from alert_send import send as alert_send
except Exception:
    alert_send = None

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(os.path.dirname(DB_PATH), "trigger-watch.state.json")
ALIVE_FILE = os.path.expanduser("~/.local/state/taskflow-trigger/alive")
SERVICE = "taskflow-trigger.service"

# Сколько минут без обновления alive-файла считать будильник зависшим.
# Сам trigger.py бьёт каждые 30 секунд; порог 7 минут даёт запас на любой
# длинный запрос и на сеть, но всё ещё ловит «полчаса никто не двигался».
ALIVE_STALE_MIN = int(os.environ.get("TRIGGER_ALIVE_STALE_MIN", "7"))


def unit_active():
    r = subprocess.run(
        ["systemctl", "--user", "is-active", SERVICE],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "active"


def unit_enabled():
    r = subprocess.run(
        ["systemctl", "--user", "is-enabled", SERVICE],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "enabled"


def alive_age_seconds():
    """Возраст mtime живого файла. None — файла нет (будильник не поднялся
    или поднят по старому коду без alive_beat_loop)."""
    try:
        mtime = os.path.getmtime(ALIVE_FILE)
    except OSError:
        return None
    return int(time.time() - mtime)


def collect(db):
    """Список нарушений: (ключ, текст для владельца)."""
    out = []

    if not unit_enabled():
        out.append((
            "unit_not_enabled",
            f"Будильник TaskFlow: {SERVICE} НЕ включён в автозапуск — "
            "после перезагрузки доска перестанет звать агентов.",
        ))
        return out  # дальше смотреть нечего, процесс не запустится

    if not unit_active():
        out.append((
            "unit_down",
            f"Будильник TaskFlow: {SERVICE} не active (юнит не запустился "
            "или только что упал, без времени на Restart=always).",
        ))
        return out  # процесс не запущен — alive не обновляется в любом случае

    age = alive_age_seconds()
    if age is None:
        out.append((
            "alive_missing",
            f"Будильник TaskFlow: юнит active, но {ALIVE_FILE} отсутствует "
            "(будильник не пишет отпечаток жизни). Если он запущен по "
            "СТАРОМУ коду — нужна перезагрузка сессии: файл появится "
            "после неё.",
        ))
    elif age > ALIVE_STALE_MIN * 60:
        out.append((
            "alive_stale",
            f"Будильник TaskFlow: юнит active, но alive-файл не обновлялся "
            f"{age // 60} мин (порог {ALIVE_STALE_MIN}). Цикл завис или "
            "процесс не добрался до alive_beat_loop.",
        ))

    return out


def owner_id(db):
    row = db.execute(
        "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return row[0] if row else None


def notifications_schema_ok(db):
    """Проверить, что таблица notifications имеет колонки, на которые мы
    опираемся. Не молча упасть, если схема разошлась: тогда INSERT не
    пройдёт, и мы узна́ем об этом через traceback в journalctl.
    """
    cols = {r["name"] for r in db.execute("PRAGMA table_info(notifications)").fetchall()}
    required = {"id", "user_id", "type", "task_id", "text", "actor_id"}
    return required.issubset(cols)


def main():
    dry = "--dry" in sys.argv
    db = sqlite3.connect(DB_PATH)
    # Колонки ниже читаются по имени (notifications_schema_ok), а без
    # row_factory sqlite отдаёт кортежи — сторож падал на первой же строке
    # с TypeError и потому НИ РАЗУ ничего не проверил (09.09.2026, ошибка
    # каждые 10 минут в журнале). Обращения по индексу (owner_id) с Row
    # продолжают работать как раньше.
    db.row_factory = sqlite3.Row

    schema_ok = notifications_schema_ok(db) if not dry else True

    found = collect(db)
    keys = {k for k, _ in found}

    try:
        seen = set(json.load(open(STATE_PATH)))
    except Exception:
        seen = set()

    fresh = [(k, msg) for k, msg in found if k not in seen]

    for key, msg in found:
        marker = "НОВОЕ · " if key in {k for k, _ in fresh} else "        "
        print(marker + msg)
    if not found:
        print("будильник TaskFlow в порядке")
    print(f"— всего замечаний: {len(found)}, из них новых: {len(fresh)}")

    if dry:
        return 0

    if fresh:
        if schema_ok:
            owner = owner_id(db)
            if owner:
                for _, msg in fresh:
                    db.execute(
                        "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)"
                        " VALUES (?,?,?,NULL,?,NULL)",
                        (str(uuid.uuid4()), owner, "trigger_watch", msg),
                    )
                db.commit()
        else:
            print("⚠️ схема notifications разошлась — INSERT пропущен, "
                  "полагаемся на alert_send")

        if alert_send is not None:
            for _, msg in fresh:
                try:
                    alert_send(
                        source="taskflow-trigger-watch",
                        level="error",
                        title="Будильник TaskFlow",
                        text=msg,
                    )
                except Exception as e:
                    print(f"сигнал наружу не ушёл: {e}")

    with open(STATE_PATH, "w") as f:
        json.dump(sorted(keys), f)

    return 0


if __name__ == "__main__":
    sys.exit(main())
