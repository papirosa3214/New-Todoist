"""Запуск: python3 -m unittest test_create_task_tool."""
import unittest
from unittest.mock import AsyncMock, patch

from worker import create_task_via_api


class CreateTaskViaApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_posts_title_and_returns_task_id(self):
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={"id": "task-123", "title": "Купить молоко"})

        mock_post_cm = AsyncMock()
        mock_post_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_post_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("worker.aiohttp.ClientSession.post", return_value=mock_post_cm) as mock_post:
            result = await create_task_via_api(
                "Купить молоко", base_url="http://127.0.0.1:3001", token="tok"
            )

        mock_post.assert_called_once_with(
            "http://127.0.0.1:3001/api/tasks",
            json={"title": "Купить молоко"},
            headers={"Authorization": "Bearer tok"},
        )
        self.assertEqual(result["id"], "task-123")

    async def test_server_error_raises(self):
        mock_response = AsyncMock()
        mock_response.status = 400
        mock_response.json = AsyncMock(return_value={"error": "название задачи не может быть пустым"})

        mock_post_cm = AsyncMock()
        mock_post_cm.__aenter__ = AsyncMock(return_value=mock_response)
        mock_post_cm.__aexit__ = AsyncMock(return_value=False)

        with patch("worker.aiohttp.ClientSession.post", return_value=mock_post_cm):
            with self.assertRaises(RuntimeError):
                await create_task_via_api("", base_url="http://127.0.0.1:3001", token="tok")


if __name__ == "__main__":
    unittest.main()
