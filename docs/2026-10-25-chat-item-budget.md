# Per-item action budget
2026-10-25. Owner approved 10 actions per checklist item and an editable setting.
- Registry: chat_item_max_actions, default 10, range 1..1000, owner-only API, reset and audit use existing server-settings infrastructure.
- Each action reads the current setting. Migration 178 persists counts/call IDs per current item; turn restart, branch changes and future-plan edits do not reset usage. Accepted item submission gives the next item a fresh budget; a replacement plan resets counts.
- Control tools (plan, submit, chat reply, loader) are exempt. Reservation occurs before effects; stale and duplicate calls are rejected.
- RED before changes: 7 budget tests failed; GREEN: 65 tests in 8 files passed, npm run build passed. iOS companion: 7 unit tests and simulator build passed.
- No production restart, database migration on production, push or iPhone installation. New setting becomes available after deployment. Previous TASKFLOW_CHAT_MAX_ACTIONS environment-only/run-scoped setting has been replaced.
