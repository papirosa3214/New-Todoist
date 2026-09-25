"""Запуск: python3 -m unittest test_worker (из server/agents/secretary-voice)."""
import os
import unittest
from unittest.mock import patch

import worker


class LoadConfigTests(unittest.TestCase):
    def test_missing_gemini_key_raises(self):
        env = {
            "LIVEKIT_URL": "wss://x.livekit.cloud",
            "LIVEKIT_API_KEY": "k",
            "LIVEKIT_API_SECRET": "s",
            "TASKFLOW_API_BASE": "http://127.0.0.1:3001",
            "TASKFLOW_AGENT_TOKEN": "t",
        }
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(worker.ConfigError):
                worker.load_config()

    def test_complete_env_loads(self):
        env = {
            "LIVEKIT_URL": "wss://x.livekit.cloud",
            "LIVEKIT_API_KEY": "k",
            "LIVEKIT_API_SECRET": "s",
            "GEMINI_API_KEY": "g",
            "TASKFLOW_API_BASE": "http://127.0.0.1:3001",
            "TASKFLOW_AGENT_TOKEN": "t",
        }
        with patch.dict(os.environ, env, clear=True):
            cfg = worker.load_config()
        self.assertEqual(cfg.gemini_api_key, "g")
        self.assertEqual(cfg.taskflow_api_base, "http://127.0.0.1:3001")


if __name__ == "__main__":
    unittest.main()
