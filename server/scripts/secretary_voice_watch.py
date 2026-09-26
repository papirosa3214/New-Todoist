#!/usr/bin/env python3
"""
Сторож голосового Секретаря (taskflow-secretary-voice + xray-secretary-voice).

ЗАЧЕМ. Gemini Live с российского IP .110 не пускают («User location is not
supported»), поэтому воркер ходит к Google через отдельный xray-выход
127.0.0.1:10816. Тихий отказ здесь — оба юнита active, но выход сдох или его
IP Google перестал пускать: воркер берёт звонок и молчит. Поэтому проверяется
не «процесс жив», а «Gemini через этот выход отвечает 200».

Шлёт владельцу в notifications (канал agent_watch/scheduler_watch) только о
НОВОМ нарушении; починилось — забывается.

ЗАПУСК: раз в 15 минут, taskflow-secretary-voice-watch.timer. Разовый прогон
без записи: python3 secretary_voice_watch.py --dry
"""

import json
import os
import sqlite3
import subprocess
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "secretary-voice-watch.state.json")
ENV_PATH = os.path.join(HERE, "..", "agents", "secretary-voice", ".env")
PROXY = "http://127.0.0.1:10816"
UNITS = ("xray-secretary-voice.service", "taskflow-secretary-voice.service")


def gemini_key():
    for line in open(ENV_PATH, encoding="utf-8"):
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip()
    return None


def unit_state(unit):
    out = subprocess.run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True, timeout=5)
    return out.stdout.strip() or "unknown"


def gemini_code(key):
    """HTTP-код Gemini через выход; три попытки — разовый сбой узла не тревога."""
    code = "000"
    for _ in range(3):
        out = subprocess.run(
            ["curl", "-s", "-m", "15", "-x", PROXY, "-o", "/dev/null", "-w", "%{http_code}",
             "-H", f"x-goog-api-key: {key}",
             "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"],
            capture_output=True, text=True, timeout=30,
        )
        code = out.stdout.strip() or "000"
        if code == "200":
            break
    return code


def owner_id(db):
    row = db.execute("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1").fetchone()
    return row["id"] if row else None


def main():
    dry = "--dry" in sys.argv
    problems = [f"{u}: {s}" for u in UNITS if (s := unit_state(u)) != "active"]
    key = gemini_key()
    if not key:
        problems.append("нет GEMINI_API_KEY в .env воркера")
    else:
        code = gemini_code(key)
        if code != "200":
            hint = "Google не пускает IP выхода (гео)" if code == "400" else "выход не отвечает"
            problems.append(f"Gemini через {PROXY} → {code} ({hint})")

    state = "; ".join(problems) or None
    print(("Голосовой Секретарь не сможет ответить: " + state) if state else "ок — Gemini через выход отвечает 200")
    if dry:
        return 0

    try:
        seen = json.load(open(STATE_PATH))
    except Exception:
        seen = None
    if state and seen != state:
        db = sqlite3.connect(DB_PATH)
        db.row_factory = sqlite3.Row
        owner = owner_id(db)
        if owner:
            db.execute(
                "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id) VALUES (?,?,?,?,?,NULL)",
                (str(uuid.uuid4()), owner, "secretary_voice_watch", None,
                 "Голосовой Секретарь не сможет ответить: " + state),
            )
            db.commit()
    json.dump(state, open(STATE_PATH, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
