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
# Через сколько минут мёртвой аренды сторож не только докладывает, но и
# СНИМАЕТ задачу с работы. 27.08.2026: три задачи провисели «в работе» почти
# сутки при аренде, истёкшей вечером, — сторож их видел и каждый час писал в
# журнал «агент пропал», но доска всё это время показывала владельцу работу,
# которой не было. Молчаливая отметка — это и есть тихий отказ.
# Порог с запасом от 5-минутной аренды: агент мог моргнуть на перезапуске
# службы, снимать его за это нельзя.
STALE_BLOCK_MINUTES = 30
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
                  t.assignee_id, t.agent_session_id, u.type AS assignee_type
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

        # Кто именно ведёт задачу: учётка агента одна на все сессии, поэтому
        # без метки сессии непонятно, чья работа встала (Максим 20.08.2026).
        sess = (t["agent_session_id"] or "")[:8]
        whose = f" [сессия {sess}]" if sess else ""

        if t["agent_state"] == "in_progress":
            beat = utc(t["agent_heartbeat_at"])
            if beat and now - beat > lease:
                mins = int((now - beat).total_seconds() // 60)
                out.append(
                    (
                        f"stale:{t['id']}:{t['agent_heartbeat_at']}",
                        t["id"],
                        f"Агент пропал: «{name}» в работе, а сигнала нет {mins} мин.{whose}",
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
                        f"не видно, что именно делается.{whose}",
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


def release_abandoned(db):
    """Задачи с мёртвой арендой — в blocked, с объяснением в ленте.

    Возвращает названия снятых. Отдельной функцией, а не внутри collect():
    collect только смотрит и обязан оставаться безопасным для --dry.
    """
    now = datetime.now(timezone.utc)
    limit = timedelta(minutes=STALE_BLOCK_MINUTES)
    freed = []
    rows = db.execute(
        """SELECT t.id, t.title, t.agent_heartbeat_at, u.name AS who
             FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.status = 'active' AND t.agent_state = 'in_progress'
              AND t.agent_heartbeat_at IS NOT NULL"""
    ).fetchall()
    for r in rows:
        beat = utc(r["agent_heartbeat_at"])
        if not beat or now - beat <= limit:
            continue
        mins = int((now - beat).total_seconds() // 60)
        db.execute(
            "UPDATE tasks SET agent_state = 'blocked', agent_heartbeat_at = NULL,"
            " updated_at = datetime('now') WHERE id = ?",
            (r["id"],),
        )
        # Шаг 5 карточки 8ca87c61: вместе со снятием задачи закрываем
        # текущую попытку — отдельной записью с outcome='lease_expired' и
        # структурированной причиной. Так в ленте попыток останется след
        # неуспешной работы, и сторож, снявший зависшего исполнителя,
        # больше не оставляет задачу с безымянным «списал».
        mins_text = f"lease expired after {mins} minutes"
        # Блокер 5 карточки 8ca87c61 (ревью 11.09.2026): WHERE task_id=?
        # задевал попытки подзадач — закрывал ВСЕ незавершённые, не только
        # текущую попытку задачи. Закрываем строго attempts.id =
        # tasks.current_attempt_id; параллельные попытки подзадач (если
        # есть) остаются живыми — у них своя аренда и свой сторож.
        db.execute(
            """UPDATE attempts
                  SET ended_at = datetime('now'), outcome = 'lease_expired',
                      reason_code = 'lease_expired', reason = ?
                WHERE id = (SELECT current_attempt_id FROM tasks
                              WHERE id = ?)
                  AND ended_at IS NULL""",
            (mins_text, r["id"]),
        )
        db.execute(
            "INSERT INTO comments (id, task_id, user_id, text) VALUES (?,?,NULL,?)",
            (
                str(uuid.uuid4()),
                r["id"],
                f"Сторож снял задачу с работы: исполнитель «{r['who'] or 'агент'}» "
                f"молчит {mins} мин, аренда давно истекла. Задача была отмечена как "
                f"выполняемая, хотя её никто не вёл. Можно назначить заново.",
            ),
        )
        freed.append((r["title"] or "")[:40])
    if freed:
        db.commit()
    return freed


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

    # Снять с работы то, что брошено по-настоящему. Докладом дело не
    # заканчивается: пока задача висит in_progress, доска врёт владельцу, а
    # будильник считает её занятой и не отдаёт другому исполнителю.
    freed = release_abandoned(db)
    for title in freed:
        print(f"СНЯТО С РАБОТЫ · «{title}» — аренда мертва дольше {STALE_BLOCK_MINUTES} мин")

    # Помним только то, что нашли сейчас: исправленное нарушение забывается
    # и, если вернётся, доложится снова.
    json.dump(sorted(keys), open(STATE_PATH, "w"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
