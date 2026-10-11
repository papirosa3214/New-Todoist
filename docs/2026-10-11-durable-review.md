# Durable review statistics

Owner contract: count completion when submitted for review; deleting cards must not subtract history. Historical facts must never be restored as active tasks.

Migration132_review_history creates task_review_history without a task FK. Triggers capture review transitions and task_events atomically; first submission per task is retained. Permanent purge still deletes cards and detailed journals but leaves statistical facts. Existing events are backfilled. Owner-authenticated GET /api/stats/review-history supplies iOS in one request.

Recovery inspected82 SQLite backups including NAS daily snapshots. Found565 deleted task IDs across snapshots;247 have an evidenced first-review date. Imported only those facts, never task rows. Ledger increased33 to280. Date range2026-08-15 to2026-10-10. Other deleted tasks without review evidence were not assigned invented dates. Recovery is idempotent and keeps earlier evidenced first dates. Full evidence: server/backups/durable-review-20261011/recovery-applied.json.

Validation:5 server tests passed (permanent purge, repeated submission, rollback, watcher probe, owner-only API). TypeScript build passed. Migration rehearsed on a live SQLite snapshot; pre-deploy hot backup saved separately. Exact113 pre-existing task IDs/statuses/agent_state/archive flags unchanged after migration and recovery. Live probe ok; live authenticated API HTTP200 entries280. Queue empty before restart; only taskflow-server restarted. Running nonarchived tasks0 afterward. An unrelated existing webhook watcher raised a new alert after restart for a missing encryption key; no historic tasks were reopened.

Watcher: startup/every15min transactional write, duplicate and purge probe, rolled back. Failures raise a daily alert in Server notifications; registered in docs/watchers.md.

Rollback: revert source commit and rebuild/restart; retain task_review_history as historical data. Do not restore the old database over newer task activity. iOS device build passed; physical installation blocked because device unavailable.
