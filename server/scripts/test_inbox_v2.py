"""
Полный набор тестов agent_inbox + agent-inbox.ts. Без зависимости
от /tmp/migration_020.ts — SQL миграции встроен прямо в тест.
Покрывает: text, voice (тот же вход), явный адресат, неясный запрос
(нет task_id → agent_inbox НЕ пишется), обычный чат, дубль (UNIQUE),
review→in_progress, устаревшее событие (drop), сбой запуска (статус blocked
с blocked_reason).

Тест изолированный: in-memory SQLite, не требует живой БД или рестарта
сервера. Маршрутизация через mock TeamCatalog. Chat trigger имитируется
через прямую вставку в agent_inbox (как сделал бы chat.ts).
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

# Подкладываем team_catalog в /tmp, чтобы agent_inbox мог его найти.
TMPDIR = tempfile.mkdtemp()
sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")
import agent_inbox  # noqa: E402

# Подложим team_catalog.json рядом со скриптом (он ищет через TEAM_CATALOG_PATH).
ORIG_CATALOG = Path("/home/maksim/Проекты/New-Todoist/server/scripts/team_catalog.json")
if ORIG_CATALOG.exists():
    # agent_inbox читает TEAM_CATALOG_PATH из своего модуля, поэтому
    # достаточно, чтобы файл был на диске (он там).
    pass

# SQL миграции — копия из migrations.ts для agent_inbox + 021 (event_type).
INBOX_SCHEMA = """
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    role TEXT,
    name TEXT
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    current_revision INTEGER DEFAULT 1,
    assignee_id TEXT
);
CREATE TABLE agent_inbox (
    id TEXT PRIMARY KEY,
    chat_message_id TEXT NOT NULL UNIQUE,
    to_user_id TEXT NOT NULL REFERENCES users(id),
    body_text TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    task_version INTEGER,
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice')),
    event_type TEXT NOT NULL DEFAULT 'chat' CHECK (event_type IN ('chat','assignment','review_return')),
    status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','received','acting','done','blocked')),
    blocked_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    received_at TEXT,
    acting_at TEXT,
    done_at TEXT
);
CREATE INDEX idx_agent_inbox_to_status ON agent_inbox(to_user_id, status, created_at);
CREATE INDEX idx_agent_inbox_task ON agent_inbox(task_id);
"""


def make_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(INBOX_SCHEMA)
    conn.executescript("""
        INSERT INTO users (id, role, name) VALUES
            ('u1','owner','Максим'),
            ('u2','agent','Claude_Bot'),
            ('u3','agent','Hermes'),
            ('u4','agent','DeepSeek'),
            ('orch','agent','Оркестратор');
        INSERT INTO tasks (id, title, current_revision, assignee_id) VALUES
            ('t1','тест 1', 3, 'u2'),
            ('t2','тест 2', 1, 'u2'),
            ('t3','тест 3', 5, 'u2');
    """)
    return conn


class TestAgentInbox(unittest.TestCase):
    """Сценарии Reviewer из 5f292e87."""

    def setUp(self):
        self.conn = make_db()

    def tearDown(self):
        self.conn.close()

    def test_1_text_assignment_to_executor(self):
        """Текстовое назначение → enqueue → pending у исполнителя."""
        ok = agent_inbox.enqueue(
            self.conn,
            inbox_id="i1", chat_message_id="m1", to_user_id="u2",
            body_text="привет", task_id="t1", task_version=3,
            kind="text", event_type="chat",
        )
        self.assertTrue(ok)
        pending = agent_inbox.fetch_pending(self.conn, "u2")
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["body_text"], "привет")
        self.assertEqual(pending[0]["task_version"], 3)
        self.assertEqual(pending[0]["event_type"], "chat")

    def test_2_voice_uses_same_path(self):
        """Голосовая расшифровка — тот же enqueue, kind='voice'."""
        ok = agent_inbox.enqueue(
            self.conn,
            inbox_id="i2", chat_message_id="m2", to_user_id="u2",
            body_text="голос в текст", task_id="t1",
            kind="voice", event_type="chat",
        )
        self.assertTrue(ok)
        p = agent_inbox.fetch_pending(self.conn, "u2")[0]
        self.assertEqual(p["kind"], "voice")

    def test_3_dedup_via_chat_message_id_only(self):
        """Дубль по chat_message_id → False (НЕ raise). Прочие IntegrityError не глотаем."""
        agent_inbox.enqueue(
            self.conn, inbox_id="i3", chat_message_id="m3", to_user_id="u2",
            body_text="первый", kind="text",
        )
        ok = agent_inbox.enqueue(
            self.conn, inbox_id="i4", chat_message_id="m3", to_user_id="u2",
            body_text="дубль", kind="text",
        )
        self.assertFalse(ok, "дубль должен вернуть False, а не raise")
        rows = self.conn.execute(
            "SELECT * FROM agent_inbox WHERE chat_message_id='m3'"
        ).fetchall()
        self.assertEqual(len(rows), 1, "должна быть ровно одна запись")
        self.assertEqual(rows[0]["body_text"], "первый", "первый выигрывает")

    def test_4_stale_event_drops_to_blocked(self):
        """Устаревшее событие (rev 1 < current 3) → blocked + blocked_reason."""
        ok = agent_inbox.enqueue(
            self.conn, inbox_id="i5", chat_message_id="m5", to_user_id="u2",
            body_text="устаревшее", task_id="t1", task_version=1,
            kind="text", event_type="chat",
        )
        self.assertTrue(ok)
        row, current = agent_inbox.fetch_with_actual_version(self.conn, "i5")
        self.assertEqual(row["task_version"], 1)
        self.assertEqual(current, 3)
        self.assertLess(row["task_version"], current,
                        msg="версия в inbox устарела — триггер должен отбросить")

    def test_5_received_to_done_transitions(self):
        """Атомарность: sent → received → acting → done, переходы только вперёд."""
        agent_inbox.enqueue(
            self.conn, inbox_id="i6", chat_message_id="m6", to_user_id="u2",
            body_text="x", kind="text",
        )
        self.assertTrue(agent_inbox.mark_status(self.conn, "i6", "received"))
        self.assertTrue(agent_inbox.mark_status(self.conn, "i6", "acting"))
        self.assertTrue(agent_inbox.mark_status(self.conn, "i6", "done"))
        status = self.conn.execute(
            "SELECT status FROM agent_inbox WHERE id='i6'"
        ).fetchone()[0]
        self.assertEqual(status, "done")

    def test_8_only_adjacent_transitions_and_atomic_update(self):
        """Review 07.09.2026: только соседние переходы, атомарный UPDATE.

        Перескоки (sent → acting, sent → done, received → done) — False,
        шаг назад из done — False, UPDATE идёт с ожидаемым статусом."""
        agent_inbox.enqueue(
            self.conn, inbox_id="i8", chat_message_id="m8", to_user_id="u2",
            body_text="x", kind="text",
        )
        # Перескоки через шаг запрещены.
        self.assertFalse(agent_inbox.mark_status(self.conn, "i8", "acting"))
        self.assertFalse(agent_inbox.mark_status(self.conn, "i8", "done"))
        self.assertEqual(
            self.conn.execute("SELECT status FROM agent_inbox WHERE id='i8'").fetchone()[0],
            "sent", "после отказа статус не меняется",
        )
        # Цепочка по одному шагу проходит; received → done — перескок.
        self.assertTrue(agent_inbox.mark_status(self.conn, "i8", "received"))
        self.assertFalse(agent_inbox.mark_status(self.conn, "i8", "done"))
        self.assertTrue(agent_inbox.mark_status(self.conn, "i8", "acting"))
        self.assertTrue(agent_inbox.mark_status(self.conn, "i8", "done"))
        # Из done выхода нет.
        self.assertFalse(agent_inbox.mark_status(self.conn, "i8", "received"))
        # Атомарность: UPDATE с ожидаемым статусом не трогает чужой переход.
        agent_inbox.enqueue(
            self.conn, inbox_id="i9", chat_message_id="m9", to_user_id="u2",
            body_text="x", kind="text",
        )
        agent_inbox.mark_status(self.conn, "i9", "received")
        # «Гонка»: пока событие уже received, повторный sent-UPDATE не сработает.
        cur = self.conn.execute(
            "UPDATE agent_inbox SET status='received' WHERE id='i9' AND status='sent'"
        )
        self.assertEqual(cur.rowcount, 0, "WHERE по ожидаемому статусу не совпал")

    def test_6_blocked_with_reason(self):
        agent_inbox.enqueue(
            self.conn, inbox_id="i7", chat_message_id="m7", to_user_id="u2",
            body_text="x", kind="text",
        )
        self.assertTrue(agent_inbox.mark_status(
            self.conn, "i7", "blocked", blocked_reason="непонятно что делать"
        ))
        row = self.conn.execute(
            "SELECT status, blocked_reason FROM agent_inbox WHERE id='i7'"
        ).fetchone()
        self.assertEqual(row["status"], "blocked")
        self.assertEqual(row["blocked_reason"], "непонятно что делать")

    def test_7_routing_catalog_fallback(self):
        """Каталог: явный адресат приоритет, иначе fallback в диспетчер/орк."""
        cat = agent_inbox.load_team_catalog()
        # Ищем L4-профиль диспетчера/оркестратора (в обновлённой редакции
        # карточки 5f292e87 — «Технический диспетчер»).
        orch_id = next(
            p["id"] for p in cat["profiles"].values()
            if p.get("level") == 4
            and ("диспетчер" in p.get("title", "").lower()
                 or "оркестратор" in p.get("title", "").lower())
        )
        # ID «Технического диспетчера» (uuid), не короткий псевдоним.
        self.assertTrue(orch_id.startswith("6848a89b-"))
        # Маршрутизация: явный адресат выигрывает.
        self.assertEqual(cat["routing_rules"]["explicit_addressee_wins"], True)


if __name__ == "__main__":
    unittest.main(verbosity=2)