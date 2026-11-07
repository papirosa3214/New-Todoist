import unittest
from unittest.mock import patch
import mcp_server


class TaskPreparationMcpTests(unittest.TestCase):
    def test_question_remains_without_card(self):
        result = {"intent": "informational_question", "card": None, "question": "Почему?"}
        with patch.object(mcp_server, "api", return_value=result) as api:
            self.assertEqual(mcp_server.t_structure_dictation({"text": "Почему?"}), result)
            api.assert_called_once_with("POST", "/api/task-preparation/prepare", {"text": "Почему?"})

    def test_preparation_preserves_graph_and_source(self):
        preparation = {"representation": "role_plan", "workstreams": [{"key": "build"}]}
        card = {"title": "Результат", "description": "Описание", "subtasks": ["Реализация"], "dueDate": None, "priority": 4, "preparation": preparation}
        with patch.object(mcp_server, "api", return_value={"card": card}) as api:
            result = mcp_server.t_structure_dictation({"text": "Сделай", "context": "Уточнение", "source_record_id": "msg-1"})
            self.assertEqual(result["preparation"], preparation)
            self.assertEqual(result["card"], card)
            self.assertEqual(api.call_args.args[2]["source_record_id"], "msg-1")

    def test_create_forwards_plan_without_extra_analysis(self):
        preparation = {"representation": "role_plan"}
        with patch.object(mcp_server, "api", return_value={"task": {"id": "task-1", "title": "Результат"}}) as api:
            mcp_server.t_create_task({"title": "Результат", "subtasks": ["Шаг"], "preparation": preparation})
            self.assertEqual(api.call_args.args[1], "/api/tasks")
            self.assertEqual(api.call_args.args[2]["preparation"], preparation)
            self.assertEqual(api.call_count, 1)

    def test_empty_input_never_calls_api(self):
        with patch.object(mcp_server, "api") as api:
            with self.assertRaises(mcp_server.TaskFlowError):
                mcp_server.t_structure_dictation({"text": " "})
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
