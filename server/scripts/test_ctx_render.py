# Тест: ctx попадает в prompt. Шаг 6 ТЗ (доработка по ревью).
# Прогон: python3 server/scripts/test_ctx_render.py

import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import task_context as tc  # noqa: E402
import trigger  # noqa: E402


class TestCtxRender(unittest.TestCase):
    """Шаг 4 ТЗ: TaskContext v1 попадает в prompt всех 4 builders."""

    def test_prompt_contains_ctx(self):
        ctx = tc.build_context(
            {"id": "t1", "title": "прямая", "description": "d"},
            {"id": "u2", "name": "Claude_Bot"},
        )
        prompt = trigger.build_prompt(
            {"id": "t1", "title": "прямая", "description": "d",
             "subtasks": [], "comments": []},
            reason="новая_задача",
            ctx=ctx,
        )
        self.assertIn("КОНТЕКСТ v1", prompt)
        self.assertIn("schema: task-context/v1", prompt)
        self.assertIn("assignment.mode: direct", prompt)
        self.assertIn("Проверь первоисточник", prompt)

    def test_orchestrator_prompt_contains_coordinated_mode(self):
        ctx = tc.build_context(
            {"id": "t9", "title": "составная", "description": "root"},
            {"id": "u9", "name": "Orchestrator"},
            mode="coordinated",
            parent_task_id="root-1",
        )
        prompt = trigger.build_orchestrator_prompt(
            {"id": "t9", "title": "составная", "description": "root",
             "subtasks": [], "comments": []},
            reason="новая_задача",
            is_claude=False,
            ctx=ctx,
        )
        self.assertIn("КОНТЕКСТ v1", prompt)
        self.assertIn("assignment.mode: coordinated", prompt)
        self.assertIn("parent_task_id: root-1", prompt)

    def test_reply_prompt_accepts_ctx(self):
        """Регрессия из ревью: build_reply_prompt должен принимать ctx."""
        ctx = tc.build_context(
            {"id": "t1", "title": "review", "description": "d"},
            {"id": "u2", "name": "Claude_Bot"},
        )
        # Не упадёт на сигнатуре — это и есть регрессия-фикс.
        prompt = trigger.build_reply_prompt(
            {"id": "t1", "title": "review", "description": "d",
             "comments": []},
            ctx=ctx,
        )
        self.assertIn("КОНТЕКСТ v1", prompt)

    def test_prompt_without_ctx_works(self):
        """Старый путь без ctx=None должен продолжать работать (back-compat)."""
        # build_prompt с ctx=None — не падает.
        prompt = trigger.build_prompt(
            {"id": "t1", "title": "x", "description": "d",
             "subtasks": [], "comments": []},
            reason="r",
        )
        self.assertNotIn("КОНТЕКСТ v1", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)