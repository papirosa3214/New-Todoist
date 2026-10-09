# WebSocket invalidation for native iOS

MAK-114, 2026-10-09. Prepared, not deployed. Live service uses dist; 3 queued jobs, 0 running at verification. Project rule requires empty queue for integration/restart; owner decision required for an exception.

## Changes

ws.addClient installs connection-local TEMP triggers/outbox after migrations. Changes to tasks, subtasks, events/comments/reports, preparation jobs, plans/nodes/edges, roles and role-run jobs wake the affected native screen. Microtask delivery follows synchronous transaction commit; rolled-back rows never emit. A transaction coalesces each task ID, ancestor tasks receive invalidations, no-op and lease/heartbeat writes do not emit. No persistent schema migration or polling timer. External DB connections do not fire these TEMP triggers.

Activity throttling now delivers a trailing event for the final action of a burst, and clearing the buffer cancels it. Owner receives the event even for a task created by somebody else. This is required before removing native polling.

## Validation

34 Vitest PASS across realtimeInvalidation, activitySocketTail, activityScope, activity, activityKeepsLease, roleRunQueue. New helper passes isolated TypeScript checking. Full tsc has an unrelated existing src/lib/notesFolders.ts:43 TS2554; that file was not changed. Native counterpart: 24 XCTest + 1 XCUITest PASS, build succeeded on iPhone Air iOS 27. UI test verifies idle silence, WS update, reconnect and background/foreground. Detailed native report is docs/2026-10-09-websocket-energy.md in TaskFlowNativeBuild on Mac.

## Remaining

Review/integrate the four own server files and tests after queue drains or owner authorizes an exception; compile and activate only the changed server modules, preserving other uncommitted source work. Validate live event delivery before installing new native app. No service restart, queued job changes or iPhone installation were performed.
