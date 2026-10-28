import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import worker

class ScreenShareSessionTests(unittest.IsolatedAsyncioTestCase):
    def test_installed_encoder_accepts_video_frames(self):
        from livekit import rtc
        from livekit.agents.utils import images
        frame = rtc.VideoFrame(16, 16, rtc.VideoBufferType.RGBA, bytes([255, 0, 0, 255]) * 256)
        self.assertTrue(images.encode(frame, images.EncodeOptions()).startswith(bytes.fromhex("ffd8")))

    async def test_video_and_audio_use_the_existing_owner_session(self):
        ctx = MagicMock()
        ctx.connect = AsyncMock()
        owner = SimpleNamespace(identity="owner", attributes={"chat_id": "origin-chat"})
        ctx.wait_for_participant = AsyncMock(return_value=owner)
        session = MagicMock()
        session.start = AsyncMock()
        assistant = MagicMock()
        assistant.update_tools = AsyncMock()
        with patch.object(worker, "load_config", return_value=SimpleNamespace(gemini_api_key="test", taskflow_socket_path="/tmp/test.sock")), \
             patch.object(worker, "RealtimeModel"), \
             patch.object(worker, "AgentSession", return_value=session), \
             patch.object(worker, "conversation_via_api", AsyncMock(return_value=[])), \
             patch.object(worker, "instructions_via_api", AsyncMock(return_value={"instructions": "test", "greeting": "test"})), \
             patch.object(worker, "shared_tools_via_api", AsyncMock(return_value=[])), \
             patch.object(worker, "Assistant", return_value=assistant):
            await worker.entrypoint(ctx)
        options = session.start.call_args.kwargs.get("room_options")
        self.assertIsNotNone(options, "Video input must be explicitly enabled")
        self.assertIsNotNone(options.get_video_input_options())
        self.assertIsNotNone(options.get_audio_input_options())
        self.assertEqual(options.participant_identity, owner.identity)
        self.assertIs(session.start.call_args.kwargs["room"], ctx.room)

if __name__ == "__main__":
    unittest.main()
