import importlib.util
import sqlite3
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy-when-idle.py"
SPEC = importlib.util.spec_from_file_location("deploy_when_idle", SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPLOY)


class PendingChatDeliveriesTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE chat_message_queue (status TEXT NOT NULL)")

    def tearDown(self):
        self.db.close()

    def test_superseded_and_completed_rows_do_not_block_deploy(self):
        self.db.executemany(
            "INSERT INTO chat_message_queue(status) VALUES (?)",
            [("done",), ("failed",), ("superseded",)],
        )
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 0)

    def test_pending_and_picked_rows_block_deploy(self):
        self.db.executemany(
            "INSERT INTO chat_message_queue(status) VALUES (?)",
            [("pending",), ("picked",), ("superseded",)],
        )
        self.assertEqual(DEPLOY.pending_chat_deliveries(self.db), 2)


if __name__ == "__main__":
    unittest.main()
