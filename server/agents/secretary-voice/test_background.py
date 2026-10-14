"""Фон для долгих инструментов голосового Помощника владельца (14.10.2026)."""
import asyncio
import unittest
from unittest.mock import MagicMock

from worker import BackgroundRunner


class BackgroundRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def test_quick_tool_answers_directly(self):
        runner = BackgroundRunner(quick_seconds=0.5)
        runner.session = MagicMock()

        async def work():
            return "готово"

        self.assertEqual(await runner.run("быстрое", work), "готово")
        runner.session.generate_reply.assert_not_called()

    async def test_slow_tool_goes_background_and_reports(self):
        runner = BackgroundRunner(quick_seconds=0.05)
        runner.session = MagicMock()

        async def work():
            await asyncio.sleep(0.2)
            return "задача заведена"

        answer = await runner.run("постановка задачи", work)
        self.assertIn("принят и выполняется в фоне", answer)
        runner.session.generate_reply.assert_not_called()
        await asyncio.sleep(0.3)
        runner.session.generate_reply.assert_called_once()
        self.assertIn("задача заведена", runner.session.generate_reply.call_args.kwargs["instructions"])
        self.assertEqual(runner.jobs, set())

    async def test_closed_call_does_not_raise(self):
        runner = BackgroundRunner(quick_seconds=0.01)
        runner.session = MagicMock()
        runner.session.generate_reply.side_effect = RuntimeError("сессия закрыта")

        async def work():
            await asyncio.sleep(0.05)
            return "итог"

        await runner.run("сводка", work)
        await asyncio.sleep(0.1)
        runner.session.generate_reply.assert_called_once()


class GenderInstructionTest(unittest.TestCase):
    def test_voice_decides_gender(self):
        from worker import gender_instruction
        self.assertIn("мужском роде", gender_instruction("Puck"))
        self.assertIn("женском роде", gender_instruction("Kore"))


if __name__ == "__main__":
    unittest.main()
