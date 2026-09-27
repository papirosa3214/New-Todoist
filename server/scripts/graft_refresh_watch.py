#!/usr/bin/env python3
"""
Сторож пересборки графов graft (сервер TaskFlow и iOS-клиент).

ЗАЧЕМ. Пересборка описаний идёт ночью сама (graft_refresh.py: graft-refresh.timer
на .110, launchd-задача на маке). Тихий отказ здесь — задача не запускалась
(мак спал, таймер слетел), пересборка падает или карта неделю занята и запуск
всё время пропускается: граф снова молча устаревает. Проверяется не «таймер
есть», а свежесть итога в файле состояния ~/.local/state/graft-refresh/<name>.json.

Пишет владельцу в notifications (тип graft_watch) о НОВОЙ проблеме и один раз
о восстановлении — «работает»; одинаковое состояние не повторяет.

ЗАПУСК: раз в сутки, graft-refresh-watch.timer (08:30). Без записи: --dry
"""

import datetime as dt
import json
import os
import sqlite3
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_DIR = os.path.expanduser("~/.local/state/graft-refresh")
WATCH_STATE = os.path.join(STATE_DIR, "watch.state.json")
# Сколько итог может быть старым: сервер пересобирает каждую ночь; мак — ночью
# или при первом открытии проекта, а в выходные может быть закрыт.
MAX_AGE_H = {"server": 36, "ios": 72}
TITLES = {"server": "граф сервера", "ios": "граф iOS-клиента"}


def check(name: str, max_age_h: int) -> str | None:
    path = os.path.join(STATE_DIR, f"{name}.json")
    title = TITLES.get(name, name)
    try:
        st = json.load(open(path))
    except FileNotFoundError:
        return f"{title}: пересборка ни разу не отчиталась"
    except Exception as e:
        return f"{title}: файл состояния не читается ({e})"
    finished = dt.datetime.fromisoformat(st.get("finished_at"))
    age_h = (dt.datetime.now(finished.tzinfo) - finished).total_seconds() / 3600
    result = st.get("result")
    if result == "failed":
        return f"{title}: пересборка упала — {st.get('detail', '')[:300]}"
    if age_h > max_age_h:
        last = {"skipped": "пропущена", "fresh": "не требовалась", "ok": "прошла"}.get(result, result)
        return f"{title}: последняя пересборка {int(age_h)} ч назад ({last}: {st.get('detail', '')[:120]})"
    return None


def main() -> int:
    dry = "--dry" in sys.argv
    problems = [p for n, h in MAX_AGE_H.items() if (p := check(n, h))]
    state = "; ".join(problems) or "ok"
    print(state)
    if dry:
        return 0

    try:
        seen = json.load(open(WATCH_STATE))
    except Exception:
        seen = None
    if state != seen:
        text = ("Графы проектов (graft) не обновляются: " + state) if problems else \
            "Графы проектов (graft): ночная пересборка описаний работает — сервер и iOS-клиент свежие."
        db = sqlite3.connect(DB_PATH)
        owner = db.execute("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").fetchone()
        if owner:
            db.execute(
                "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?,?,?,?,?,NULL)",
                (str(uuid.uuid4()), owner[0], "graft_watch", None, text),
            )
            db.commit()
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(state, open(WATCH_STATE, "w"), ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
