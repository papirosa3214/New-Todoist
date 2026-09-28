"""Запуск: python3 -m unittest test_create_task_tool."""
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

from worker import create_task_via_api, summary_via_api, Assistant


class CreateTaskViaApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_posts_title_and_returns_task_id(self):
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"task": {"id": "task-123", "title": "Купить молоко"}})

        mock_post_cm = AsyncMock()
        mock_post_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_post_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("worker.aiohttp.ClientSession.post", return_value=mock_post_cm) as mock_post:
            result = await create_task_via_api(
                "Купить молоко", socket_path="/tmp/test-voice.sock", owner_id="u1"
            )

        mock_post.assert_called_once_with(
            "http://localhost/secretary/tasks",
            json={"text": "Купить молоко", "owner_id": "u1"},
        )
        self.assertEqual(result["task"]["id"], "task-123")
        self.assertEqual(result["task"]["title"], "Купить молоко")

    async def test_voice_tool_uses_room_owner_and_local_socket(self):
        agent = Assistant(owner_id="u1")
        task = {"task":{"id": "voice-1", "title": "Создать задачу голосом"}}
        with patch("worker.load_config", return_value=SimpleNamespace(taskflow_socket_path="/tmp/voice.sock")), \
             patch("worker.create_task_via_api", new_callable=AsyncMock, return_value=task) as create:
            answer = await agent.create_task(None, text="Позвонить завтра к десяти, высокий приоритет, на меня")
        create.assert_awaited_once_with("Позвонить завтра к десяти, высокий приоритет, на меня", "/tmp/voice.sock", "u1")
        self.assertIn(task["task"]["title"], answer)

    async def test_server_error_raises(self):
        mock_response = AsyncMock()
        mock_response.status = 400
        mock_response.json = AsyncMock(return_value={"error": "название задачи не может быть пустым"})

        mock_post_cm = AsyncMock()
        mock_post_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_post_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("worker.aiohttp.ClientSession.post", return_value=mock_post_cm):
            with self.assertRaises(RuntimeError):
                await create_task_via_api("", socket_path="/tmp/test-voice.sock", owner_id="u1")


class SummaryToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_passes_full_query_and_explicit_chat_delivery(self):
        agent = Assistant(owner_id="u1")
        with patch("worker.load_config", return_value=SimpleNamespace(taskflow_socket_path="/tmp/voice.sock")), \
             patch("worker.summary_via_api", new_callable=AsyncMock, return_value={"spoken_text": "Зависших две", "message_id": "msg-1"}) as summary:
            answer = await agent.task_summary(None, text="Пришли зависшие у QA на следующую неделю", send_to_chat=True)
        summary.assert_awaited_once_with("Пришли зависшие у QA на следующую неделю", "/tmp/voice.sock", "u1", True)
        self.assertIn("msg-1", answer)

    async def test_summary_posts_to_closed_socket_without_task_creation(self):
        response = AsyncMock()
        response.status = 200
        response.json = AsyncMock(return_value={"sections": [], "message_id": None})
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=response)
        cm.__aexit__ = AsyncMock(return_value=False)
        with patch("worker.aiohttp.ClientSession.post", return_value=cm) as post:
            result = await summary_via_api("Что у всех ролей?", "/tmp/voice.sock", "u1")
        post.assert_called_once_with("http://localhost/secretary/summary", json={"text": "Что у всех ролей?", "owner_id": "u1", "send_to_chat": False})
        self.assertIsNone(result["message_id"])

    async def test_tool_reports_error_without_claiming_delivery(self):
        agent = Assistant(owner_id="u1")
        with patch("worker.load_config", return_value=SimpleNamespace(taskflow_socket_path="/tmp/voice.sock")), \
             patch("worker.summary_via_api", new_callable=AsyncMock, side_effect=RuntimeError("отказ")):
            answer = await agent.task_summary(None, text="Сводка", send_to_chat=True)
        self.assertIn("Не удалось", answer)
        self.assertNotIn("отправлена", answer)


if __name__ == "__main__":
    unittest.main()
