#!/usr/bin/env python3
"""
Сторож TaskFlow Library: проверяет структуру корневой папки знаний и
докладывает о нарушениях.

08.10.2026. Решение владельца: роли используют TaskFlow Library как один из
источников контекста и сами её обслуживают. Сторож следит только за тем,
что сама структура жива: корневая папка с is_kb_root=1 и четыре подпапки
(Roles, Workflows, Norms, Knowledge Base) с индексными заметками
_index.md — всё, что нужно для навигации.

Без структуры роли попросту не найдут Library, и база знаний развалится
тихо. Поэтому проверяем.

ЧТО ПРОВЕРЯЕТ (по живой базе, только чтение):
  1. Корневая папка Library (is_kb_root=1) существует.
  2. Все 4 подпапки (Roles, Workflows, Norms, Knowledge Base) на месте.
  3. В каждой подпапке есть _index.md.

КАК ДОКЛАДЫВАЕТ: уведомлением владельцу через существующий канал
notifications (server/src/routes/notifications.ts), в духе agent_watch.py.
Состояние помнит в library-watch.state.json рядом с базой, чтобы не
спамить повторными нарушениями.

ЗАПУСК: раз в час таймером systemd --user (taskflow-library-watch.timer).
Разовый прогон без записи: python3 library_watch.py --dry
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH") or os.path.join(HERE, "..", "taskflow.db")
STATE_PATH = os.path.join(
    os.path.dirname(DB_PATH), "library-watch.state.json"
)

EXPECTED_SUBFOLDERS = ["Roles", "Workflows", "Norms", "Knowledge Base"]

DRY = "--dry" in sys.argv


def load_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return {"reported": {}}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"reported": {}}


def save_state(state: dict) -> None:
    if DRY:
        return
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def check_library(db: sqlite3.Connection) -> list[str]:
    """Возвращает список нарушений. Пустой список = всё на месте."""
    issues: list[str] = []

    root = db.execute(
        "SELECT id, name FROM journal_folders WHERE is_kb_root = 1 LIMIT 1"
    ).fetchone()
    if not root:
        issues.append(
            "Корневая папка Library (is_kb_root=1) не найдена — "
            "запустите: npx tsx scripts/bootstrap-taskflow-library.ts"
        )
        return issues  # без корня остальные проверки не имеют смысла
    root_id = root[0]

    for sub_name in EXPECTED_SUBFOLDERS:
        row = db.execute(
            "SELECT id FROM journal_folders WHERE parent_id = ? AND name = ?",
            (root_id, sub_name),
        ).fetchone()
        if not row:
            issues.append(f"Подпапка «{sub_name}» отсутствует под корнем Library.")
            continue
        sub_id = row[0]
        note = db.execute(
            "SELECT id FROM user_notes WHERE folder_id = ? AND title = '_index.md'",
            (sub_id,),
        ).fetchone()
        if not note:
            issues.append(f"В подпапке «{sub_name}» нет _index.md.")

    return issues


def notify_via_db(db: sqlite3.Connection, issue: str) -> None:
    """Кладёт запись в notifications, чтобы владелец увидел в ленте.
    Используем ту же схему, что и agent_watch.py: notifications от
    'system' пользователю 'u1'."""
    if DRY:
        return
    try:
        cur = db.execute("SELECT id FROM users WHERE role='owner' ORDER BY created_at,id LIMIT 1")
        owner = cur.fetchone()
        if not owner:
            print("[warn] владелец не найден, уведомление пропущено")
            return
        owner_id = owner[0]
        # Проверим, есть ли уже такое уведомление за последние сутки.
        existing = db.execute(
            "SELECT 1 FROM notifications WHERE user_id=? AND title=? AND created_at >= datetime('now','-1 day') LIMIT 1",
            (owner_id, "TaskFlow Library"),
        ).fetchone()
        if existing:
            return
        db.execute(
            "INSERT INTO notifications (id, user_id, title, body, kind, read, created_at) "
            "VALUES (lower(hex(randomblob(16))), ?, 'TaskFlow Library', ?, 'system', 0, datetime('now'))",
            (owner_id, issue),
        )
        db.commit()
    except sqlite3.Error as e:
        print(f"[lib-watch] не удалось уведомить: {e}", file=sys.stderr)


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"[lib-watch] БД не найдена: {DB_PATH}", file=sys.stderr)
        return 2
    state = load_state()
    con = sqlite3.connect(DB_PATH)
    try:
        issues = check_library(con)
    finally:
        con.close()

    if not issues:
        # Чисто — стираем прежние пометки.
        if state.get("reported"):
            state["reported"] = {}
            save_state(state)
        if not DRY:
            print("[lib-watch] OK: структура Library в порядке")
        else:
            print("[dry] OK")
        return 0

    # Что-то не так: ищем новые (относительно state.reported).
    previous = set(state.get("reported", {}).keys())
    current = set(issues)
    new_issues = current - previous
    if new_issues:
        for issue in new_issues:
            con = sqlite3.connect(DB_PATH)
            try:
                notify_via_db(con, issue)
            finally:
                con.close()
            print(f"[lib-watch] NEW: {issue}")
        # Запоминаем что уже отчитывались об этом наборе.
        state["reported"] = {issue: True for i in current}
        save_state(state)
    else:
        if not DRY:
            print(f"[lib-watch] уже отчитывались ({len(previous)} нарушений)")
        else:
            print(f"[dry] без изменений ({len(previous)} известных нарушений)")
    return 1


if __name__ == "__main__":
    sys.exit(main())