import tempfile
import unittest
from pathlib import Path
from aiohttp import web
from worker import Assistant, shared_tools_via_api

CORE = {"name":"taskflow_tools","description":"load","parameters":{"type":"object","properties":{"names":{"type":"array","items":{"type":"string"}}}}}
EXTRA = {"name":"taskflow_archive","description":"archive","parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}

class NativeToolsTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_exposes_only_the_shared_catalog(self):
        agent = Assistant(owner_id="u1")
        self.assertEqual(agent.tools, [])

    async def test_loader_updates_the_agent_before_returning_success(self):
        seen=[]
        async def manifest(request):
            seen.append(dict(request.query))
            return web.json_response({"tools":[CORE]})
        async def invoke(request):
            seen.append(await request.json())
            return web.json_response({"ok":True,"result":'{"activated":["taskflow_archive"]}',"tools":[CORE,EXTRA]})
        app=web.Application()
        app.router.add_get("/secretary/tools",manifest)
        app.router.add_post("/secretary/tool",invoke)
        runner=web.AppRunner(app)
        await runner.setup()
        with tempfile.TemporaryDirectory() as folder:
            socket=str(Path(folder)/"voice.sock")
            await web.UnixSite(runner,socket).start()
            try:
                agent=Assistant(owner_id="u1")
                tools=await shared_tools_via_api(socket,"u1",chat_id="chat",agent=agent,session_id="call")
                await agent.update_tools(tools)
                result=await tools[0]({"names":["taskflow_archive"]})
                self.assertIn("activated",result)
                self.assertEqual(len(agent.tools),2)
                self.assertEqual(seen[0],{"owner_id":"u1","chat_id":"chat","session_id":"call"})
                self.assertEqual(seen[1]["arguments"],{"names":["taskflow_archive"]})
                self.assertEqual(seen[1]["session_id"],"call")
            finally:
                await runner.cleanup()

    async def test_empty_catalog_does_not_start_a_silent_degraded_call(self):
        async def manifest(request):return web.json_response({"tools":[]})
        app=web.Application();app.router.add_get("/secretary/tools",manifest)
        runner=web.AppRunner(app);await runner.setup()
        with tempfile.TemporaryDirectory() as folder:
            socket=str(Path(folder)/"voice.sock");await web.UnixSite(runner,socket).start()
            try:
                with self.assertRaises(RuntimeError):await shared_tools_via_api(socket,"u1")
            finally:await runner.cleanup()
