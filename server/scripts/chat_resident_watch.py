#!/usr/bin/env python3
"""
Сторож резидента чата координации (taskflow-chat.service).

ЗАЧЕМ. Юнит сам перезапускается на сбой (Restart=on-failure), но тихий отказ
здесь не «процесс упал» — а «процесс жив, systemd думает, что всё хорошо, а
канал на самом деле не слушает». Конкретно три таких сценария, уже пойманные
живьём при настройке 27-28.08.2026:
  1. resident.pid нет или ссылается на мёртвый процесс — reconnect-скрипт не
     достучался до канала (MCP-гонка, см. TaskFlow (New-Todoist)__claude-channels-
     allowlist-research.md), юнит всё равно «active (running)».
  2. учётка резидента не online в БД — сам резидент не смог поднять свою сессию
     поллера, хотя tmux-пейн может выглядеть нормально.
  3. ⚠️ Главный риск: `--dangerously-load-development-channels` — экспериментальный,
     недокументированный в `--help` флаг research preview. Апдейт CLI может убрать
     его или снова включить allowlist-проверку для локальных каналов — тогда пейн
     покажет «not on the approved channels allowlist» / «plugin not installed»,
     юнит всё равно будет «active», а канал молчит. Обновление CLI на этой машине
     тянется автоматически («Update installed · Restart to apply» видели 27.08.2026)
     — после рестарта резидента это может сработать БЕЗ предупреждения.

КАК ДОКЛАДЫВАЕТ: та же таблица notifications, что у agent_watch.py — Максим уже
читает её в приложении, второй канал доставки не нужен. Шлёт только о НОВОМ
нарушении (state-файл рядом, как у agent_watch.py) — не спамить при повторных
прогонах одного и того же затянувшегося отказа.

ЗАПУСК: раз в 15 минут, taskflow-chat-watch.timer. Разовый прогон без записи:
python3 chat_resident_watch.py --dry
"""
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone

# Общий отправщик тревог infra-ops: повтор, журнал недоставленного и запасная
# дорога прямо в Telegram мимо n8n. Лежит вне репозитория, поэтому импорт
# мягкий — без него сторож продолжает работать, просто молча в notifications.
sys.path.insert(0, os.path.expanduser("~/infra-ops"))
try:
    from alert_send import send as alert_send
except Exception:
    alert_send = None

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "chat-watch.state.json")
PIDFILE = os.path.expanduser("~/.claude/channels/taskflow/resident.pid")
SOCKET = "claudetf"
TARGET = "tf"
ALLOWLIST_MARKERS = (
    "not on the approved channels allowlist",
    "plugin not installed",
)

# Сколько ждать ответа резидента на сообщение владельца, прежде чем считать
# канал молчащим. Резидент думает подолгу (живьём видели ход в 10 минут), а
# таймер сторожа тикает раз в 13-15 минут — порог ниже получаса даст ложные
# срабатывания на обычном длинном ходе.
SILENCE_MIN = int(os.environ.get("CHAT_SILENCE_MIN", "20"))

# Признаки того, что сессия ДЕРЖИТ блокирующий вопрос: пока он на экране,
# входящие копятся строками «← taskflow: …» и не разбираются вовсе.
BLOCKING_MARKERS = (
    "Enter to select",
    "to navigate",
    "Esc to cancel",
)

# Упёршийся лимит подписки: сессия жива, но ходить ей нечем.
LIMIT_MARKERS = (
    "limit reached",
    "usage limit",
    "out of usage",
)


def unit_active():
    r = subprocess.run(
        ["systemctl", "--user", "is-active", "taskflow-chat.service"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "active"


def pid_alive():
    try:
        pid = int(open(PIDFILE).read().strip())
    except Exception:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def pid_is_channel():
    """pid из resident.pid принадлежит живому процессу канала TaskFlow.

    Опознаём по рабочему каталогу процесса, а НЕ по его командной строке.
    Живьём 28.08.2026 она выглядит как «/home/maksim/.bun/bin/bun server.ts» —
    слова «taskflow» в ней нет вовсе. Признак «в cmdline есть taskflow и
    server.ts», который использует орфан-страж самого плагина, на этой
    машине не срабатывает никогда: то есть плагин не гасит осиротевшего
    предшественника, а сторож по тому же признаку кричал бы каждые 15 минут
    на исправном резиденте.
    """
    try:
        pid = int(open(PIDFILE).read().strip())
    except Exception:
        return False
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return False                      # процесса нет либо он не наш
    return cwd.rstrip("/").endswith("/.claude/skills/taskflow")


def pane_text():
    r = subprocess.run(
        ["tmux", "-L", SOCKET, "capture-pane", "-p", "-S", "-80", "-t", TARGET],
        capture_output=True, text=True,
    )
    return r.stdout if r.returncode == 0 else ""


def resident_user_id(db):
    """Учётка, под которой сидит резидент, — по РОЛИ, не по зашитому id.

    Зашитая константа тут уже была и оказалась мёртвой (снята 28.08.2026):
    резидент переехал с Claude_Bot на учётку оркестратора, и id разошёлся с
    действительностью молча. Роль переезд переживает.
    """
    row = db.execute(
        "SELECT id FROM users WHERE role = 'orchestrator' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return row[0] if row else None


def silence_minutes(db):
    """Сколько минут владелец ждёт ответа в канале. None — не ждёт.

    Считает по РЕЗУЛЬТАТУ, а не по живости: есть сообщение владельца,
    адресованное резиденту или всем, и после него резидент не написал
    ничего. Такой признак ловит любую причину простоя — блокирующий вопрос,
    исчерпанный лимит, зависший инструмент, — а не только заранее известную.

    Время в chat_messages пишется как datetime('now'), то есть UTC: сравнивать
    с локальным «сейчас» нельзя, разница с Москвой в три часа сама по себе
    перевалила бы любой порог.
    """
    rid = resident_user_id(db)
    if not rid:
        return None
    row = db.execute(
        "SELECT created_at FROM chat_messages"
        " WHERE from_user_id = (SELECT id FROM users WHERE role = 'owner'"
        "                        ORDER BY created_at LIMIT 1)"
        "   AND (to_user_id IS NULL OR to_user_id = ?)"
        " ORDER BY created_at DESC LIMIT 1",
        (rid,),
    ).fetchone()
    if not row:
        return None
    asked_at = row[0]
    answered = db.execute(
        "SELECT 1 FROM chat_messages WHERE from_user_id = ? AND created_at > ? LIMIT 1",
        (rid, asked_at),
    ).fetchone()
    if answered:
        return None
    try:
        asked = datetime.strptime(asked_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int((datetime.now(timezone.utc) - asked).total_seconds() // 60)


def stuck_reason(text):
    """Причина простоя, читаемая прямо с экрана сессии. Пусто — не опознана."""
    if any(m in text for m in BLOCKING_MARKERS):
        return ("сессия держит вопрос с выбором варианта — пока на него не ответят, "
                "входящие не разбираются вовсе")
    low = text.lower()
    if any(m in low for m in LIMIT_MARKERS):
        return "у сессии кончился лимит подписки — ходить ей нечем"
    return ""


def collect(db):
    """Список нарушений: (ключ, текст для владельца)."""
    out = []

    if not unit_active():
        out.append(("unit_down", "Чат-резидент: юнит taskflow-chat.service не active — канал координации не слушается."))
        return out  # дальше смотреть нечего, процесс не запущен

    if not pid_alive():
        out.append(("pid_dead", "Чат-резидент: resident.pid мёртв или отсутствует — канал не подключился (похоже на MCP-гонку при старте)."))

    # ⚠️ Здесь СТОЯЛА проверка «u2 online в БД». Она не могла провалиться
    # никогда: users.status — это «есть ли хоть один живой сокет у учётки»
    # (server/src/ws.ts), а сокеты Claude_Bot и Оркестратора держит совсем
    # другая служба — будильник taskflow-trigger. То есть сторож рапортовал
    # «резидент в порядке» ровно так же, как если бы резидента не было
    # вовсе. Найдено 28.08.2026 при переводе резидента на учётку
    # оркестратора: сторож сказал «в порядке» на ещё не перезапущенной
    # службе.
    #
    # Заменено на то, что может провалиться по-настоящему: pid из
    # resident.pid должен принадлежать ЖИВОМУ процессу канала. Файл пишет
    # сам плагин и только когда поллер поднялся (skills/taskflow/server.ts,
    # startListening) — то есть это и есть сигнал «сессия поллера встала».
    if not pid_is_channel():
        out.append(("pid_foreign",
                    "Чат-резидент: resident.pid есть, но это не процесс канала "
                    "TaskFlow — поллер не поднялся, а файл остался от прошлого "
                    "запуска."))

    text = pane_text()

    # Тихий отказ, ради которого сторож и переписан 28.08.2026: юнит active,
    # pid живой, канал подключён — а владелец дважды написал в чат и не
    # получил ничего. Снаружи это неотличимо от «чат сломан».
    waited = silence_minutes(db)
    if waited is not None and waited >= SILENCE_MIN:
        why = stuck_reason(text)
        out.append((
            "resident_silent",
            f"Чат-резидент молчит {waited} мин на сообщение владельца"
            + (f": {why}." if why else ", причину с экрана определить не удалось.")
            + " Юнит при этом active — сам он не перезапустится.",
        ))

    for marker in ALLOWLIST_MARKERS:
        if marker in text:
            out.append((
                "allowlist_broken",
                "Чат-резидент: в пейне видно «" + marker + "» — похоже, обновление CLI "
                "сломало dev-флаг канала (research preview, мог исчезнуть без предупреждения). "
                "Нужна живая проверка и, возможно, альтернативный путь подключения канала.",
            ))
            break

    return out


def owner_id(db):
    row = db.execute(
        "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return row[0] if row else None


def main():
    dry = "--dry" in sys.argv
    db = sqlite3.connect(DB_PATH)

    found = collect(db)
    keys = {k for k, _ in found}

    try:
        seen = set(json.load(open(STATE_PATH)))
    except Exception:
        seen = set()

    fresh = [(k, msg) for k, msg in found if k not in seen]

    for key, msg in found:
        print(("НОВОЕ · " if key in {k for k, _ in fresh} else "        ") + msg)
    if not found:
        print("чат-резидент в порядке")
    print(f"— всего замечаний: {len(found)}, из них новых: {len(fresh)}")

    if dry:
        return 0

    if fresh:
        owner = owner_id(db)
        if owner:
            for _, msg in fresh:
                db.execute(
                    "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)"
                    " VALUES (?,?,?,NULL,?,NULL)",
                    (str(uuid.uuid4()), owner, "chat_watch", msg),
                )
            db.commit()

        # Наружу, в Telegram. Уведомление в приложении для этого класса отказов
        # слабое: 28.08.2026 владелец смотрел в сам чат, а не в колокольчик, и
        # молчание резидента заметил только он сам — сторож к тому времени уже
        # два раза отчитался «в порядке». Молчащий канал координации не может
        # сообщить о себе через себя же, поэтому нужен внешний путь.
        if alert_send is not None:
            for _, msg in fresh:
                try:
                    alert_send(
                        source="taskflow-chat-watch",
                        level="error",
                        title="Чат координации TaskFlow",
                        text=msg,
                    )
                except Exception as e:
                    print(f"сигнал наружу не ушёл: {e}")

    # Запомнить то, что уже отложилось нарушением, — чтобы не долбить повторно
    # на каждый прогон таймера, пока отказ тянется одним и тем же.
    with open(STATE_PATH, "w") as f:
        json.dump(sorted(keys), f)

    return 0


if __name__ == "__main__":
    sys.exit(main())
