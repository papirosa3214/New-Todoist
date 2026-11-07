"""Тесты для next_step_for (спек 1.2, 1.2.2). Запуск: python3 -m unittest scripts/test_next_step_for.py."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import trigger  # noqa: E402


LADDER = ["haiku", "sonnet", "opus"]


class NextStepForTests(unittest.TestCase):
    def test_insufficient_capability_haiku_returns_sonnet(self):
        self.assertEqual(
            trigger.next_step_for(
                "insufficient_capability", "haiku", 1, ladder=LADDER,
            ),
            "sonnet",
        )

    def test_insufficient_capability_sonnet_returns_opus(self):
        self.assertEqual(
            trigger.next_step_for(
                "insufficient_capability", "sonnet", 2, ladder=LADDER,
            ),
            "opus",
        )

    def test_insufficient_capability_opus_returns_none(self):
        self.assertIsNone(
            trigger.next_step_for(
                "insufficient_capability", "opus", 1, ladder=LADDER,
            )
        )

    def test_insufficient_capability_at_cap_returns_none(self):
        # attempts_count == 3 — потолок лесенки (max_attempts=3 в default).
        self.assertIsNone(
            trigger.next_step_for(
                "insufficient_capability", "sonnet", 3, ladder=LADDER,
            )
        )

    def test_insufficient_capability_above_cap_returns_none(self):
        self.assertIsNone(
            trigger.next_step_for(
                "insufficient_capability", "sonnet", 5, ladder=LADDER,
            )
        )

    def test_lease_expired_returns_none(self):
        # lease_expired не идёт по лесенке — R4: сразу в blocked.
        self.assertIsNone(
            trigger.next_step_for(
                "lease_expired", "sonnet", 1, ladder=LADDER,
            )
        )

    def test_unknown_reason_returns_none(self):
        for r in ("provider_limit", "technical_failure", "out_of_scope", ""):
            with self.subTest(reason=r):
                self.assertIsNone(
                    trigger.next_step_for(r, "haiku", 1, ladder=LADDER)
                )

    def test_unknown_model_returns_none(self):
        self.assertIsNone(
            trigger.next_step_for(
                "insufficient_capability", "gpt-99", 1, ladder=LADDER,
            )
        )

    def test_empty_ladder_returns_none(self):
        self.assertIsNone(
            trigger.next_step_for(
                "insufficient_capability", "haiku", 1, ladder=[],
            )
        )


if __name__ == "__main__":
    unittest.main()
