import tempfile
import unittest
from pathlib import Path
from aiohttp import web
from worker import instructions_via_api


class ExecutionModeInstructionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_voice_instruction_request_identifies_the_original_chat(self):
        seen = []
        async def instructions(request):
            seen.append(dict(request.query))
            return web.json_response({"instructions": "По карточке", "greeting": "Привет"})
        app = web.Application()
        app.router.add_get('/secretary/instructions', instructions)
        runner = web.AppRunner(app)
        await runner.setup()
        with tempfile.TemporaryDirectory() as folder:
            socket = str(Path(folder) / 'voice.sock')
            await web.UnixSite(runner, socket).start()
            try:
                result = await instructions_via_api(socket, 'owner', 'original-chat')
                self.assertEqual(seen, [{"owner_id": "owner", "chat_id": "original-chat"}])
                self.assertEqual(result['instructions'], 'По карточке')
            finally:
                await runner.cleanup()
