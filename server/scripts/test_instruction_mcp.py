"""Run with python3 -m unittest test_instruction_mcp from server/scripts."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import mcp_server


class InstructionSnapshotTests(unittest.TestCase):
    def test_initialize_and_tools_use_snapshot_without_changing_schema(self):
        original = mcp_server.public_tools()
        self.assertTrue(original)
        first = original[0]
        with tempfile.TemporaryDirectory() as folder:
            snapshot = os.path.join(folder, "instructions.json")
            with open(snapshot, "w", encoding="utf-8") as stream:
                json.dump({"texts": {
                    "mcp.initialize": "Инструкция из снимка",
                    "tool.mcp." + first["name"]: "Описание из снимка",
                }}, stream)
            with patch.dict(os.environ, {"TASKFLOW_INSTRUCTION_SNAPSHOT": snapshot}):
                init = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
                listed = mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            self.assertEqual(init["result"]["instructions"], "Инструкция из снимка")
            updated = listed["result"]["tools"]
            self.assertEqual(updated[0]["description"], "Описание из снимка")
            self.assertEqual(updated[0]["name"], first["name"])
            self.assertEqual(updated[0]["inputSchema"], first["inputSchema"])
        self.assertEqual(mcp_server.public_tools()[0]["description"], first["description"])


if __name__ == "__main__":
    unittest.main()
