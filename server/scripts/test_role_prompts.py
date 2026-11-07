import sys
import unittest

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import trigger


class TestRolePrompts(unittest.TestCase):
    def test_all_roles_have_distinct_prompt_sections(self):
        for role in sorted(trigger.ROLE_NAMES):
            with self.subTest(role=role):
                task = {
                    "id": "role-prompt-test",
                    "role": role,
                    "title": "Проверка системного prompt",
                    "subtasks": [],
                    "comments": [],
                }
                prompt = trigger.build_prompt(task, "тест")
                self.assertIn(f"СИСТЕМНЫЙ ПРОМПТ РОЛИ {role}", prompt)
                self.assertIn(f"КОНЕЦ СИСТЕМНОГО ПРОМПТА РОЛИ", prompt)
                self.assertIn(f"# {trigger.ROLE_PROMPTS_DIR.joinpath(role + '.md').read_text(encoding='utf-8').splitlines()[0][2:]}", prompt)

    def test_claude_receives_role_prompt_as_system_argument(self):
        task = {
            "id": "role-prompt-command-test",
            "role": "architect",
            "title": "Проверка команды",
            "description": "d",
            "status": "active",
            "agent_state": None,
            "parent_id": None,
            "assignee_id": trigger.ME,
            "subtasks": [],
            "comments": [],
        }
        class Proc:
            returncode = 0

            def communicate(self, timeout=None):  # noqa: ARG002
                return "", ""

        captured = []
        ctx = type("Ctx", (), {
            "schema_version": "task-context/v1",
            "knowledge": {"status": "ok"},
            "repository": {"status": "ok"},
            "warnings": [],
        })()

        from unittest.mock import patch
        import task_context

        with patch.object(trigger, "inbox_consume", return_value=([], True)), \
                patch.object(trigger, "resume_target", return_value=("", "", False)), \
                patch.object(trigger, "api", return_value={}), \
                patch.object(trigger, "note", return_value=None), \
                patch.object(trigger, "activity_mark", return_value=("", "")), \
                patch.object(trigger, "should_continue", return_value=(False, "стоп")), \
                patch.object(task_context, "build_context", return_value=ctx), \
                patch.object(trigger.subprocess, "Popen", side_effect=lambda cmd, **kwargs: (captured.append(cmd) or Proc())), \
                patch.object(trigger.threading, "Thread"):
            trigger.run_external(task, "тест", {
                "name": "Claude_Bot",
                "claude_cli": True,
                "cmd": ["/bin/claude", "-p"],
                "token": "token",
                "resident": False,
            })

        self.assertEqual(len(captured), 1)
        command = captured[0]
        index = command.index("--append-system-prompt")
        self.assertIn("# Architect", command[index + 1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
