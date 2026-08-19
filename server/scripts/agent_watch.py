#!/usr/bin/env python3
"""
Сторож конвейера: проверяет, как агенты ведут задачи, и докладывает владельцу.

Зачем отдельный процесс, если правила уже в сервере. Сервер отвечает на
запрос: он видит момент («этот шаг нельзя сдать») и не видит тишину —
задачу, которую взяли и бросили; работу без единого шага в работе; шаг,
застрявший в приёмке неделю. Максим 20.08.2026: «эти правила должен
контролировать сторонний скрипт, который будет контролировать вообще всех
агентов, не только тебя». Это он и есть — вторая половина политики:
сервер запрещает нарушать, сторож замечает дрейф.

ЧТО ПРОВЕРЯЕТ (по живой базе, только чтение):
  1. Задача взята, но агент замолчал — аренда истекла.
  2. Задача в работе, а ни один шаг не помечен рабочим: владельцу не видно,
     что именно идёт. Ровно та жалоба, с которой правила и начались.
  3. Шаг в работе под задачей, которую никто не держит — рассинхрон.
  4. Задача сдана на приёмку, а её шаги не сданы и не закрыты.
  5. Задача агента без проекта или без исполнителя — «ничья».
  6. Шаг сдан на приёмку без текста результата.

КАК ДОКЛАДЫВАЕТ: уведомлением владельцу в самом трекере, и только о НОВЫХ
нарушениях (состояние помнит в agent-watch.state.json рядом с базой).
Спам недопустим: Максим читает уведомления с телефона.

ЗАПУСК: раз в час таймером systemd --user (taskflow-agent-watch.timer).
Разовый прогон без записи: python3 agent_watch.py --dry
"""
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "agent-watch.state.json")
LEASE_MINUTES = 5  # синхронно с server/src/agentState.ts
REVIEW_STUCK_HOURS = 48  # шаг висит в приёмке дольше — напомнить один раз


def utc(value):
    """Время SQLite ('YYYY-MM-DD HH:MM:SS', UTC без суффикса) → datetime."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace(" ", "T")).replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def collect(db):
    """Список нарушений: (ключ, задача, текст для владельца)."""
    now = datetime.now(timezone.utc)
    lease = timedelta(minutes=LEASE_MINUTES)
    out = []

    tasks = db.execute(
        """SELECT t.id, t.title, t.agent_state, t.agent_heartbeat_at, t.project_id,
                  t.assignee_id, u.type AS assignee_type
             FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.status = 'active'"""
    ).fetchall()

    for t in tasks:
        steps = db.execute(
            """SELECT id, title, done, agent_state, result, agent_heartbeat_at
                 FROM subtasks WHERE task_id = ? ORDER BY position""",
            (t["id"],),
        ).fetchall()
        open_steps = [s for s in steps if not s["done"]]
        name = (t["title"] or "")[:40]

        if t["agent_state"] == "in_progress":
            beat = utc(t["agent_heartbeat_at"])
            if beat and now - beat > lease:
                mins = int((now - beat).total_seconds() // 60)
                out.append(
                    (
                        f"stale:{t['id']}:{t['agent_heartbeat_at']}",
                        t["id"],
                        f"Агент пропал: «{name}» в работе, а сигнала нет {mins} мин.",
                    )
                )
            # «Ни один шаг не помечен» — только когда есть чему идти. Если
            # все открытые шаги уже сданы или заблокированы, работа не идёт
            # молча: она ждёт владельца, и ворчать тут не на что.
            waiting = open_steps and all(
                s["agent_state"] in ("review", "blocked") for s in open_steps
            )
            if steps and not waiting and not any(
                s["agent_state"] == "in_progress" for s in open_steps
            ):
                out.append(
                    (
                        f"nostep:{t['id']}",
                        t["id"],
                        f"«{name}»: задача в работе, но ни один шаг не помечен — "
                        "не видно, что именно делается.",
                    )
                )

        if t["agent_state"] != "in_progress":
            for s in open_steps:
                if s["agent_state"] == "in_progress":
                    out.append(
                        (
                            f"orphan:{s['id']}",
                            t["id"],
                            f"«{name}»: шаг «{(s['title'] or '')[:30]}» помечен рабочим, "
                            "хотя саму задачу никто не держит.",
                        )
                    )

        if t["agent_state"] == "review":
            loose = [
                s for s in open_steps if s["agent_state"] not in ("review", "blocked")
            ]
            if loose:
                out.append(
                    (
                        f"halfdone:{t['id']}:{len(loose)}",
                        t["id"],
                        f"«{name}» сдана на приёмку, но {len(loose)} шаг(ов) не сдано.",
                    )
                )

        if t["assignee_type"] == "ai" or t["agent_state"]:
            if not t["project_id"]:
                out.append(
                    (f"noproject:{t['id']}", t["id"], f"«{name}» ведётся без проекта.")
                )
            if not t["assignee_id"]:
                out.append(
                    (f"noassignee:{t['id']}", t["id"], f"«{name}» без исполнителя.")
                )

        for s in open_steps:
            if s["agent_state"] == "review" and not (s["result"] or "").strip():
                out.append(
                    (
                        f"noresult:{s['id']}",
                        t["id"],
                        f"«{name}»: шаг «{(s['title'] or '')[:30]}» сдан без результата — "
                        "принимать нечего.",
                    )
                )
            elif s["agent_state"] == "review":
                beat = utc(s["agent_heartbeat_at"])
                if beat and now - beat > timedelta(hours=REVIEW_STUCK_HOURS):
                    out.append(
                        (
                            f"stuck:{s['id']}:{int((now - beat).total_seconds() // 3600)}h",
                            t["id"],
                            f"«{name}»: шаг «{(s['title'] or '')[:30]}» ждёт вашей "
                            f"приёмки больше {REVIEW_STUCK_HOURS} ч.",
                        )
                    )

    return out


def owner_id(db):
    row = db.execute(
        "SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def main():
    dry = "--dry" in sys.argv
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    found = collect(db)
    keys = {k for k, _, _ in found}

    try:
        seen = set(json.load(open(STATE_PATH)))
    except Exception:
        seen = set()

    fresh = [(k, t, msg) for k, t, msg in found if k not in seen]

    fresh_keys = {k for k, _, _ in fresh}
    for key, _, msg in found:
        print(("НОВОЕ · " if key in fresh_keys else "        ") + msg)
    print(f"— всего замечаний: {len(found)}, из них новых: {len(fresh)}")

    if dry:
        return 0

    owner = owner_id(db)
    if owner and fresh:
        for _, task_id, msg in fresh:
            db.execute(
                "INSERT INTO notifications (id, user_id, type, task_id, text, actor_id)"
                " VALUES (?,?,?,?,?,NULL)",
                (str(uuid.uuid4()), owner, "agent_watch", task_id, msg),
            )
        db.commit()

    # Помним только то, что нашли сейчас: исправленное нарушение забывается
    # и, если вернётся, доложится снова.
    json.dump(sorted(keys), open(STATE_PATH, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
