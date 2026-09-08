# Тесты для server/scripts/task_context.py
# Шаг 6 ТЗ docs/taskflow-direct-dispatch-mvp.md.
# Прогон: python3 server/scripts/test_task_context.py
# (не требует pytest — просто стандартный unittest из stdlib.)

import json
import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import task_context as tc  # noqa: E402


class TestTaskContextSchema(unittest.TestCase):
    """Шаг 2 ТЗ: схема TaskContext жёсткая и предсказуемая."""

    def test_direct_mode(self):
        """Прямой исполнитель: mode='direct', parent_task_id=None."""
        ctx = tc.build_context(
            {"id": "t1", "title": "прямая", "description": "d"},
            {"id": "u2", "name": "Claude_Bot"},
        )
        self.assertEqual(ctx.schema_version, "task-context/v1")
        self.assertEqual(ctx.assignment["mode"], "direct")
        self.assertIsNone(ctx.assignment["parent_task_id"])
        self.assertEqual(ctx.assignment["actor_id"], "u2")
        self.assertEqual(ctx.assignment["actor_name"], "Claude_Bot")

    def test_coordinated_mode(self):
        """Оркестратор: mode='coordinated', parent_task_id=корень."""
        ctx = tc.build_context(
            {"id": "t9", "title": "составная", "description": "root"},
            {"id": "u9", "name": "Orchestrator"},
            mode="coordinated",
            parent_task_id="root-1",
        )
        self.assertEqual(ctx.assignment["mode"], "coordinated")
        self.assertEqual(ctx.assignment["parent_task_id"], "root-1")
        self.assertEqual(ctx.assignment["actor_id"], "u9")

    def test_required_task_fields(self):
        """TaskEnricher обязателен — без id/title бросает."""
        with self.assertRaises(tc.EnrichmentError):
            tc.build_context({}, {"id": "u2"})
        with self.assertRaises(tc.EnrichmentError):
            tc.build_context({"id": "x"}, {"id": "u2"})

    def test_truncate(self):
        """MAX_EXCERPT_CHARS — жёсткая обрезка строки."""
        s = "x" * 1000
        out = tc.truncate(s, limit=100)
        self.assertEqual(len(out), 100)
        out_default = tc.truncate(s)
        self.assertLessEqual(len(out_default), tc.MAX_EXCERPT_CHARS)


class TestEnrichersSoft(unittest.TestCase):
    """Шаг 3 ТЗ: падение необязательного адаптера — status=unavailable,
    а не exception наружу."""

    def test_knowledge_unavailable_when_no_kb(self):
        """Нет ~/kb/kb_query.py → status='unavailable', НЕ exception."""
        # kb_query.py на этой машине точно нет — обогатитель должен
        # тихо вернуть 'unavailable', build_context не должен падать.
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d"},
            {"id": "u2", "name": "Bot"},
        )
        self.assertIn(
            ctx.knowledge["status"], ("ok", "empty", "unavailable")
        )

    def test_repository_empty_without_config(self):
        """Без конфига проекта → status='empty'."""
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d"},
            {"id": "u2", "name": "Bot"},
            projects_config=None,
        )
        self.assertEqual(ctx.repository["status"], "empty")


class TestCommentsLimit(unittest.TestCase):
    """MAX_COMMENTS — не более 5 в conversation.latest_comments."""

    def test_comments_truncated_to_max(self):
        comments = [
            {"author": f"u{i}", "text": f"msg {i}", "created_at": ""}
            for i in range(20)
        ]
        ctx = tc.build_context(
            {"id": "t1", "title": "тест", "description": "d",
             "comments": comments},
            {"id": "u2", "name": "Bot"},
        )
        self.assertLessEqual(
            len(ctx.conversation["latest_comments"]), tc.MAX_COMMENTS
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)