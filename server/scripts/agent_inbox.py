# Agent inbox — единый механизм доставки поручений (карточка 5f292e87).
# Карточка 5f292e87: «доделай существующий agent inbox... доработай так,
# чтобы он был единственным механизмом доставки».
#
# Гарантии:
#   - дедупликация: UNIQUE constraint на chat_message_id (SQLite) — повторная
#     запись по тому же сообщению даст UNIQUE constraint failed.
#   - version: при создании inbox'а сохраняем tasks.current_revision (если
#     есть), чтобы при срабатывании inbox'а триггер мог сравнить с актуальным
#     состоянием и отбросить устаревшие события.
#   - статусы: sent (по умолчанию при INSERT) → received (агент прочёл) →
#     acting (агент взял) → done (завершил) | blocked (не мог).
#
# Не делает: HTTP-эндпоинты (это в chat.ts и agent-inbox.ts). Интеграция с
# trigger.py — там, где запускается процесс: служба читает pending и сверяет
# версию карточки ДО claim (повторное ревью 07.09.2026).

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

INBOX_SCHEMA_PATH = Path(__file__).parent / "migrations" / "020_agent_inbox.sql"
TEAM_CATALOG_PATH = Path(__file__).parent / "team_catalog.json"

VALID_STATUSES = ("sent", "received", "acting", "done", "blocked")
VALID_KINDS = ("text", "voice")


def enqueue(
    conn: sqlite3.Connection,
    *,
    inbox_id: str,
    chat_message_id: str,
    to_user_id: str,
    body_text: str,
    task_id: str | None = None,
    task_version: int | None = None,
    kind: str = "text",
    event_type: str = "chat",
) -> bool:
    """Записать поручение в inbox. Возвращает True, если новое; False, если
    уже было (UNIQUE по chat_message_id).

    Бросает sqlite3.IntegrityError на прочие конфликты (например, плохой
    task_id без существующей задачи).
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"kind must be one of {VALID_KINDS}, got {kind!r}")
    try:
        cur = conn.execute(
            """
            INSERT INTO agent_inbox
              (id, chat_message_id, to_user_id, body_text, task_id, task_version, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (inbox_id, chat_message_id, to_user_id, body_text, task_id, task_version, kind),
        )
    except sqlite3.IntegrityError:
        # UNIQUE на chat_message_id — повторная доставка того же сообщения.
        # Это дедупликация, а не ошибка вызывающего. Другие нарушения
        # (FOREIGN KEY) ловятся вызывающим кодом, если нужны.
        return False
    return cur.rowcount == 1


# Только соседние переходы (Review 07.09.2026), зеркально agent-inbox.ts:
# успех идёт строго sent → received → acting → done; blocked — конечное
# «не вышло», доступное из любого неконечного статуса (сбой запуска,
# устаревшее событие). Перескоки (sent → acting/done, received → done) и
# выход из done/blocked запрещены.
ALLOWED_NEXT = {
    "sent": ("received", "blocked"),
    "received": ("acting", "blocked"),
    "acting": ("done", "blocked"),
    "done": (),
    "blocked": (),
}


def mark_status(
    conn: sqlite3.Connection,
    inbox_id: str,
    new_status: str,
    blocked_reason: str | None = None,
) -> bool:
    """Перевести inbox-элемент в новый статус. Возвращает True, если
    обновлено; False, если id не найден, статус недопустим, переход назад
    или через шаг, либо статус уже успел измениться (гонка)."""
    if new_status not in VALID_STATUSES:
        raise ValueError(f"new_status must be one of {VALID_STATUSES}")
    cur_row = conn.execute(
        "SELECT status FROM agent_inbox WHERE id = ?", (inbox_id,)
    ).fetchone()
    if not cur_row:
        return False
    old_status = cur_row[0]
    if new_status not in ALLOWED_NEXT.get(old_status, ()):
        return False
    if new_status == "received":
        column = "received_at"
    elif new_status == "acting":
        column = "acting_at"
    elif new_status == "done":
        column = "done_at"
    else:
        column = None
    sets = ["status = ?"]
    params: list = [new_status]
    if column is not None:
        sets.append(f"{column} = datetime('now')")
    if new_status == "blocked":
        sets.append("blocked_reason = ?")
        params.append(blocked_reason or "")
    # Атомарный UPDATE с ожидаемым статусом: при гонке (статус уже поменял
    # соседний процесс) WHERE не сойдётся — вернём False, не перезапишем.
    params.extend([inbox_id, old_status])
    cur = conn.execute(
        f"UPDATE agent_inbox SET {', '.join(sets)} WHERE id = ? AND status = ?",
        params,
    )
    return cur.rowcount > 0


def fetch_pending(conn: sqlite3.Connection, to_user_id: str) -> list[dict]:
    """Элементы inbox'а со статусом 'sent' для адресата."""
    rows = conn.execute(
        """
        SELECT id, chat_message_id, to_user_id, body_text, task_id, task_version, kind,
               event_type, status, created_at
         FROM agent_inbox
        WHERE to_user_id = ? AND status = 'sent'
        ORDER BY created_at ASC
        LIMIT 50""",
        (to_user_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_with_actual_version(
    conn: sqlite3.Connection,
    inbox_id: str,
) -> tuple[dict | None, int | None]:
    """Возвращает (inbox_row, current_task_version). current_task_version
    = NULL, если task_id отсутствует или задача удалена."""
    row = conn.execute(
        "SELECT * FROM agent_inbox WHERE id = ?", (inbox_id,)
    ).fetchone()
    if not row:
        return None, None
    d = dict(row)
    if not d.get("task_id"):
        return d, None
    task = conn.execute(
        "SELECT current_revision FROM tasks WHERE id = ?", (d["task_id"],)
    ).fetchone()
    return d, (task["current_revision"] if task else None)


def load_team_catalog() -> dict:
    """Загрузить каталог команды из team_catalog.json."""
    return json.loads(TEAM_CATALOG_PATH.read_text(encoding="utf-8"))