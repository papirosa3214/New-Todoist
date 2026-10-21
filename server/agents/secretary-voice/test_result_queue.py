"""Очередь результатов: тесты с настоящим SpeechHandle LiveKit, без сети."""
import asyncio
import unittest
from livekit.agents.voice.speech_handle import SpeechHandle
from worker import BackgroundRunner


class Session:
    def __init__(self):
        self.idle = asyncio.Event()
        self.idle.set()
        self.user_state = "listening"
        self.agent_state = "listening"
        self.calls = []
        self.handles = []

    async def wait_for_idle(self):
        await self.idle.wait()

    def generate_reply(self, **kwargs):
        self.calls.append(kwargs["instructions"])
        handle = SpeechHandle.create(allow_interruptions=True)
        self.handles.append(handle)
        return handle


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0.001)


class ResultQueueTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runner = BackgroundRunner(quick_seconds=0.001)
        self.session = Session()
        self.runner.session = self.session

    async def complete(self, text):
        gate = asyncio.Event()
        async def work():
            await gate.wait()
            return text
        await self.runner.run(text, work)
        gate.set()
        await asyncio.sleep(0.01)

    async def test_result_waits_for_user_pause(self):
        self.session.idle.clear()
        self.session.user_state = "speaking"
        await self.complete("результат")
        self.assertEqual(self.session.calls, [])
        self.session.user_state = "listening"
        self.session.idle.set()
        await until(lambda: len(self.session.calls) == 1)
        self.session.handles[0]._mark_done()

    async def test_results_are_serialized_until_playout(self):
        await self.complete("первый")
        await self.complete("второй")
        self.assertEqual(len(self.session.calls), 1)
        self.session.handles[0]._mark_done()
        await until(lambda: len(self.session.calls) == 2)
        self.assertIn("первый", self.session.calls[0])
        self.assertIn("второй", self.session.calls[1])
        self.session.handles[1]._mark_done()

    async def test_interrupted_result_is_retained_and_retried(self):
        await self.complete("не потерять")
        await until(lambda: len(self.session.calls) == 1)
        self.session.idle.clear()
        self.session.user_state = "speaking"
        handle = self.session.handles[0]
        handle.interrupt()
        handle._mark_done()
        await asyncio.sleep(0.02)
        self.assertEqual(len(self.session.calls), 1)
        self.session.user_state = "listening"
        self.session.idle.set()
        await until(lambda: len(self.session.calls) == 2)
        self.assertIn("не потерять", self.session.calls[1])
        self.session.handles[1]._mark_done()

    async def test_async_generation_failure_is_retried(self):
        await self.complete("повторить после ошибки")
        await until(lambda: len(self.session.calls) == 1)
        self.session.handles[0]._mark_done(error=RuntimeError("generation failed"))
        await until(lambda: len(self.session.calls) == 2)
        self.assertIn("повторить после ошибки", self.session.calls[1])
        self.session.handles[1]._mark_done()

    async def test_cancelled_tool_wait_still_reports_completed_work(self):
        gate = asyncio.Event()
        async def work():
            await gate.wait()
            return "сохранено после перебивания"
        self.runner.quick_seconds = 1
        call = asyncio.create_task(self.runner.run("поручение", work))
        await asyncio.sleep(0)
        call.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await call
        gate.set()
        await until(lambda: len(self.session.calls) == 1)
        self.assertIn("сохранено после перебивания", self.session.calls[0])
        self.session.handles[0]._mark_done()

    async def test_close_stops_delivery_without_cancelling_work(self):
        gate = asyncio.Event()
        async def work():
            await gate.wait()
            return "итог после закрытия"
        await self.runner.run("долгое", work)
        await self.runner.close()
        gate.set()
        await until(lambda: not self.runner.jobs)
        self.assertEqual(self.session.calls, [])
        self.assertEqual(list(self.runner.pending), [("долгое", "итог после закрытия")])

    async def test_close_cancels_wait_for_idle(self):
        self.session.idle.clear()
        await self.complete("ждёт паузы")
        await self.runner.close()
        self.assertTrue(self.runner._delivery.done())
        self.assertEqual(self.session.calls, [])
        self.assertEqual(len(self.runner.pending), 1)

    async def test_retry_never_reexecutes_operation(self):
        calls = 0
        gate = asyncio.Event()
        async def work():
            nonlocal calls
            calls += 1
            await gate.wait()
            return "единственное выполнение"
        await self.runner.run("операция", work)
        gate.set()
        await until(lambda: len(self.session.calls) == 1)
        self.session.handles[0].interrupt()
        self.session.handles[0]._mark_done()
        await until(lambda: len(self.session.calls) == 2)
        self.session.handles[1]._mark_done()
        await until(lambda: not self.runner.pending)
        self.assertEqual(calls, 1)

    async def test_sdk_closed_activity_leaves_no_unhandled_task_error(self):
        from livekit.agents.voice.agent_activity import ActivityClosedError
        async def closed():
            raise ActivityClosedError("session is closing")
        self.session.wait_for_idle = closed
        await self.complete("неозвученный итог")
        await until(lambda: self.runner._delivery.done())
        self.assertIsNone(self.runner._delivery.exception())
        self.assertEqual(len(self.runner.pending), 1)
