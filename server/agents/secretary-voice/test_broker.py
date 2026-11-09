import asyncio
import json
import os
import tempfile
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch
from secret_broker import broker_voice_options

class BrokerVoiceTest(unittest.TestCase):
    def test_disabled_does_not_require_a_credential(self):
        self.assertIsNone(broker_voice_options({}))

    def test_sdk_keeps_proxy_prefix_and_sends_only_connection_token(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = os.path.join(directory, "token")
            with open(token_path, "w") as f:
                f.write("connection-fixture")
            os.chmod(token_path, 0o600)
            env = {"TASKFLOW_SECRET_BROKER_BINDINGS": json.dumps([{
                "provider": "secretary-voice", "alias": "GEMINI_API_KEY",
                "brokerUrl": "http://127.0.0.1:28443", "tokenPath": token_path,
                "authKind": "api_key"
            }])}
            options = broker_voice_options(env)
            self.assertEqual(options["api_key"], "connection-fixture")
            from google import genai
            from google.genai import types
            captured = {}
            class FakeSocket:
                async def send(self, data):
                    captured["setup"] = data
                async def recv(self):
                    return json.dumps({"setupComplete": {}})
            @asynccontextmanager
            async def connect(uri, **kwargs):
                captured["uri"] = uri
                captured["headers"] = kwargs.get("additional_headers", {})
                yield FakeSocket()
            async def run():
                client = genai.Client(api_key=options["api_key"],
                    http_options=types.HttpOptions(base_url=options["base_url"]))
                async with client.aio.live.connect(model="gemini-3.8-live"):
                    pass
                await client.aio.aclose()
            with patch("google.genai.live.ws_connect", connect):
                asyncio.run(run())
            self.assertIn("/proxy/GEMINI_API_KEY/ws/google.ai.generativelanguage.", captured["uri"])
            self.assertEqual(captured["headers"]["x-goog-api-key"], "connection-fixture")
            self.assertIn("gemini-3.8-live", captured["setup"])

    def test_missing_token_never_uses_gemini_env_fallback(self):
        env = {"GEMINI_API_KEY": "must-not-use", "TASKFLOW_SECRET_BROKER_BINDINGS": json.dumps([{
            "provider": "secretary-voice", "alias": "GEMINI_API_KEY",
            "brokerUrl": "http://127.0.0.1:28443", "tokenPath": "/nonexistent", "authKind": "api_key"
        }])}
        with self.assertRaises(ValueError):
            broker_voice_options(env)

if __name__ == "__main__":
    unittest.main()
