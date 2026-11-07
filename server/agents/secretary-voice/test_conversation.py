import asyncio
import unittest
from livekit.agents import llm
from worker import VoiceConversationRecorder, context_from_messages


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_records_final_user_and_assistant_once_in_event_order(self):
        rows = []
        async def write(item_id, role, text):
            await asyncio.sleep(0)
            rows.append((item_id, role, text))
        recorder = VoiceConversationRecorder(write)
        user = llm.ChatMessage(id="user-1", role="user", content=["Привет"])
        assistant = llm.ChatMessage(id="answer-1", role="assistant", content=["Отвечаю"])
        recorder.record(user)
        recorder.record(user)
        recorder.record(assistant)
        self.assertTrue(await recorder.flush())
        self.assertEqual(rows, [("user-1","user","Привет"),("answer-1","assistant","Отвечаю")])
        await recorder.close()

    async def test_retries_same_event_after_write_failure(self):
        attempts = []
        async def write(item_id, role, text):
            attempts.append(item_id)
            if len(attempts)==1:
                raise RuntimeError("temporary disconnect")
        recorder = VoiceConversationRecorder(write)
        recorder.record(llm.ChatMessage(id="stable",role="user",content=["Текст"]))
        self.assertTrue(await recorder.flush())
        self.assertEqual(attempts,["stable","stable"])
        await recorder.close()

    async def test_context_preserves_roles_and_order(self):
        context = context_from_messages([{"role":"user","text":"Первый вопрос"},{"role":"assistant","text":"Первый ответ"}])
        self.assertEqual([(i.role,i.text_content) for i in context.items],[("user","Первый вопрос"),("assistant","Первый ответ")])

    async def test_system_and_empty_events_are_not_persisted(self):
        rows=[]
        async def write(*item): rows.append(item)
        recorder = VoiceConversationRecorder(write)
        recorder.record(llm.ChatMessage(role="system",content=["secret instructions"]))
        recorder.record(llm.ChatMessage(role="user",content=[]))
        self.assertTrue(await recorder.flush())
        self.assertEqual(rows,[])
        await recorder.close()
