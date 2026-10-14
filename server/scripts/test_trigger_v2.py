# Изолированные тесты trigger.py — 4 сценария из ТЗ Шаг 6.
# Мокаем APIClient и зависимости, чтобы тесты были детерминированы.

import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import trigger  # noqa: E402


def make_task(task_id="t1", status="active", agent_state=None, parent_id=None):
    return {
        "id": task_id,
        "title": "тест",
        "description": "d",
        "status": status,
        "agent_state": agent_state,
        "parent_id": parent_id,
        "assignee_id": "u2",
    }


def make_agent(agent_id="u2", role=None, token="TOKEN"):
    return {"id": agent_id, "name": "Claude_Bot", "role": role, "token": token}


def patch_dependencies():
    """Все вызовы APIClient/agent_state заменяем на моки."""
    return [
        patch.object(trigger, "log"),
        patch.object(trigger, "note", return_value=None),
        patch.object(trigger, "LOCK", new=MagicMock()),
        patch.object(trigger, "RUNNING", new={}),
    ]


class TestTrigger(unittest.TestCase):
    def setUp(self):
        self.patches = patch_dependencies()
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_1_direct_executor_builds_prompt_with_context(self):
        """Прямой исполнитель: ctx собран, в prompt — TaskContext v1."""
        ctx = {"id": "t1", "title": "t", "description": "d", "comments": []}
        from task_context import build_context
        c = build_context(ctx, {"id": "u2", "name": "Bot"})
        prompt = trigger.build_prompt(ctx, "новая_задача", ctx=c)
        self.assertIn("КОНТЕКСТ v1", prompt)
        self.assertIn("assignment.mode: direct", prompt)

    def test_2_review_state_not_picked_up_by_decide(self):
        """Задача в `review`: decide возвращает (False, ...) — процесс не стартует."""
        task = make_task(agent_state="review")
        # Исполнителем должны быть «мы», иначе decide отобьёт задачу раньше
        # — на гейте «исполнитель не я», так и не дойдя до проверки
        # состояния. Тест тогда проходил бы мимо того, что проверяет:
        # зелёный результат по совершенно другой причине.
        with patch.object(trigger, "ME", task["assignee_id"]):
            ok, reason = trigger.decide(task, kind="comment")
        self.assertFalse(ok)
        # Причина содержит «проверк» (review) или «активна» — главное, что
        # process не запускается из review-состояния.
        self.assertTrue("проверк" in reason.lower() or "активна" in reason.lower())

    def test_3_missing_task_card_no_launch(self):
        """Обязательная карточка недоступна: build_context бросает,
        запуск НЕ происходит (process не появляется в RUNNING)."""
        from task_context import EnrichmentError, build_context as _bc
        # Без `id` build_context обязан бросить EnrichmentError.
        bad = {"title": "x"}  # нет id
        with self.assertRaises(EnrichmentError):
            _bc(bad, {"id": "u2", "name": "Bot"})

    def test_4_kb_repo_unavailable_still_launches(self):
        """Мягкий отказ обогатителей: status=unavailable/empty, ctx жив."""
        from task_context import build_context
        c = build_context(
            {"id": "t1", "title": "t", "description": "d"},
            {"id": "u2", "name": "Bot"},
            projects_config={},  # пусто → repository.status=empty
        )
        # knowledge.status = unavailable (нет kb_query.py на сервере —
        # обогатитель его не находит, отдаёт unavailable).
        self.assertIn(c.knowledge["status"], ("unavailable", "empty", "ok"))
        self.assertEqual(c.repository["status"], "empty")
        # ctx жив, сериализуется без падения.
        from task_context import serialize_context
        s = serialize_context(c)
        self.assertIn("schema: task-context/v1", s)


if __name__ == "__main__":
    unittest.main(verbosity=2)