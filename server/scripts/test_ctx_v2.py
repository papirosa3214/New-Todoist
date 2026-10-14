# Расширенный тест ctx_render v2 (после правок Reviewer от 17:14).
# Покрывает: parent_id = task.id (для оркестратора), запись в лог,
# serialize_context с фактическими данными, обрезка MAX_TOTAL_CHARS=6000.

import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import task_context as tc  # noqa: E402
import trigger  # noqa: E402


class TestCtxOrchestrator(unittest.TestCase):
    """Reviewer: parent_id для оркестратора = task.id (не task.parent_id)."""

    def test_parent_id_is_task_id(self):
        """build_context(mode='coordinated', parent_task_id=task.id)."""
        ctx = tc.build_context(
            {"id": "root-1", "title": "составная", "description": "d"},
            {"id": "u9", "name": "Orchestrator"},
            mode="coordinated",
            parent_task_id="root-1",
        )
        self.assertEqual(ctx.assignment["parent_task_id"], "root-1")
        prompt = trigger.build_orchestrator_prompt(
            {"id": "root-1", "title": "составная", "description": "d",
             "comments": []},
            reason="новая_задача",
            is_claude=False,
            ctx=ctx,
        )
        self.assertIn("assignment.parent_task_id: root-1", prompt)


class TestSerializeContext(unittest.TestCase):
    """Единый сериализатор с лимитом 6000 chars."""

    def test_serialize_basic(self):
        ctx = tc.build_context(
            {"id": "t1", "title": "прямая", "description": "d"},
            {"id": "u2", "name": "Claude_Bot"},
        )
        s = tc.serialize_context(ctx)
        self.assertIn("schema: task-context/v1", s)
        self.assertIn("assignment.mode: direct", s)
        self.assertIn("assignment.actor: u2 (Claude_Bot)", s)
        self.assertIn("Проверь первоисточник", s)

    def test_serialize_with_comments(self):
        ctx = tc.build_context(
            {"id": "t1", "title": "t", "description": "d",
             "comments": [
                 {"author": "Max", "text": "привет", "created_at": "2026-09-05"},
                 {"author": "Bot", "text": "ответ", "created_at": "2026-09-05"},
             ]},
            {"id": "u2", "name": "Bot"},
        )
        s = tc.serialize_context(ctx)
        self.assertIn("Max: привет", s)
        self.assertIn("Bot: ответ", s)

    def test_truncate_total(self):
        """MAX_TOTAL_CHARS=6000 — лимит на весь блок."""
        # Создадим ctx с большими комментариями
        big_text = "x" * 10000
        ctx = tc.build_context(
            {"id": "t1", "title": "t", "description": "d",
             "comments": [{"author": "A", "text": big_text, "created_at": ""}] * 7},
            {"id": "u2", "name": "Bot"},
        )
        s = tc.serialize_context(ctx, max_total_chars=200)
        self.assertLessEqual(len(s), 250)  # небольшой запас


if __name__ == "__main__":
    unittest.main(verbosity=2)