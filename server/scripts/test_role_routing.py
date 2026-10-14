import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, "/home/maksim/Проекты/New-Todoist/server/scripts")

import trigger


class TestRoleRouting(unittest.TestCase):
    def test_valid_matrix_loads_all_roles(self):
        routing = trigger.load_role_routing()
        self.assertEqual(set(routing), {"defaults", "fallbacks", "models"})
        self.assertEqual(set(routing["defaults"]), trigger.ROLE_NAMES)
        self.assertEqual(set(routing["fallbacks"]), trigger.ROLE_NAMES)
        self.assertEqual(set(routing["models"]), trigger.ROLE_NAMES)

    def test_missing_role_fails_at_load(self):
        valid = trigger.ROLE_ROUTING_FILE.read_text(encoding="utf-8")
        # 18.09.2026 (карточка f3108dcc): qa → pi_runtime в role-routing.yaml.
        invalid = valid.replace("  qa: pi_runtime\n", "", 1)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "role-routing.yaml"
            path.write_text(invalid, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "defaults: нужны все роли"):
                trigger.load_role_routing(path)

    def test_no_fallback_chains_are_configured(self):
        routing = trigger.load_role_routing()
        for role, fallbacks in routing["fallbacks"].items():
            with self.subTest(role=role):
                self.assertEqual(fallbacks, [])

    def test_pi_role_profiles_are_explicit_and_complete(self):
        trigger.validate_pi_mcp_profiles()
        for role in trigger.ROLE_NAMES:
            with self.subTest(role=role):
                profile = trigger.pi_mcp_profile_for_role(role)
                self.assertEqual(profile.name, f"{role}.json")
        self.assertIsNone(trigger.pi_mcp_profile_for_role(""))

    def test_architect_uses_pi_by_default(self):
        selected = trigger.resolve_agent_for_role("architect")
        self.assertIsNotNone(selected)
        self.assertEqual(selected["id"], trigger.PI_AGENT_ID)
        self.assertEqual(selected["routing_reason"], "дефолт")
        self.assertEqual(trigger.model_of({"role": "architect", "labels": []}), "MiniMax-M3")

    def test_builder_uses_pi_and_minimax_by_default(self):
        selected = trigger.resolve_agent_for_role("builder")
        self.assertIsNotNone(selected)
        self.assertEqual(selected["id"], trigger.PI_AGENT_ID)
        self.assertEqual(trigger.model_of({"role": "builder", "labels": []}), "MiniMax-M3")

        thread_factory = MagicMock(return_value=MagicMock())
        task = {"id": "builder-route", "assignee_id": trigger.ME,
                "role": "builder", "agent_state": None}
        with patch.object(trigger, "get_task", return_value=task), \
                patch.object(trigger, "decide", return_value=(True, "ok")), \
                patch.object(trigger.threading, "Thread", thread_factory):
            trigger.handle_task("builder-route", "event")
        routed = thread_factory.call_args.kwargs["args"][2]
        self.assertEqual(routed["id"], trigger.PI_AGENT_ID)
        self.assertEqual(trigger.model_of(task), "MiniMax-M3")

    def test_explicit_model_label_still_overrides_metadata(self):
        task = {"role": "architect", "labels": [{"name": "haiku"}]}
        self.assertEqual(trigger.model_of(task), "haiku")

    def test_task_without_role_keeps_assignee_routing(self):
        task = {"id": "t1", "assignee_id": trigger.ME, "role": None, "agent_state": None}
        thread_factory = MagicMock(return_value=MagicMock())
        with patch.object(trigger, "get_task", return_value=task), \
                patch.object(trigger, "decide", return_value=(True, "ok")), \
                patch.object(trigger.threading, "Thread", thread_factory):
            trigger.handle_task("t1", "event")
        self.assertIs(thread_factory.call_args.kwargs["args"][2], trigger.EXTERNAL_AGENTS[trigger.ME])

    def test_task_role_routes_to_pi(self):
        task = {"id": "t2", "assignee_id": trigger.ME, "role": "architect", "agent_state": None}
        thread_factory = MagicMock(return_value=MagicMock())
        with patch.object(trigger, "get_task", return_value=task), \
                patch.object(trigger, "decide", return_value=(True, "ok")), \
                patch.object(trigger.threading, "Thread", thread_factory):
            trigger.handle_task("t2", "event")
        selected = thread_factory.call_args.kwargs["args"][2]
        self.assertEqual(selected["id"], trigger.PI_AGENT_ID)
        self.assertEqual(thread_factory.call_args.kwargs["target"], trigger.run_external)


if __name__ == "__main__":
    unittest.main(verbosity=2)
