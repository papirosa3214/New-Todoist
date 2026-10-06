// Снимок рабочего состояния слота: роль пишет только при блокировке, всё
// остальное сервер делает сам (владелец 04.10.2026, LOCK-SLOT-SNAPSHOT-20261004).
//
// Здесь проверяем серверную половину: пока слот идёт, технический снимок
// появляется по таймеру аренды, одинаковые подряд не дублируются, история
// ограничена, а блокировка без снимка роли оставляет техснимок с пометкой.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import {
  SNAPSHOT_KEEP,
  periodicSlotSnapshot,
  saveSlotSnapshot,
  slotSnapshotDto,
  slotSnapshotHistory,
  technicalSlotSnapshot,
} from "../src/runtime/slotWorkSnapshot.js";

describe("периодический техснимок слота", () => {
  let app: FastifyInstance;
  let ownerToken: string;
  let ownerId: string;
  let taskId: string;
  let planId: string;

  beforeAll(async () => {
    app = await buildApp();
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "Snapshot owner", email: `snap-${Date.now()}@test`, password: "password123" },
    });
    ownerToken = reg.json().token;
    ownerId = reg.json().user.id;
    db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerId);
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { title: "Снимки слота" },
    });
    taskId = task.json().task.id;
    planId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'full_cycle', ?)",
    ).run(planId, taskId, ownerId);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Шаг-узел плана «в работе» с открытой попыткой — так он выглядит, пока
   *  роль жива и продлевает аренду. */
  function makeNode(slot: string): { subtaskId: string; attemptId: string } {
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, required, expected_result, output_artifact_json, source_subtask_id) VALUES (?, ?, ?, 'builder', 1, 'x', '{}', NULL)",
    ).run(crypto.randomUUID(), planId, slot);
    const subtaskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    db.prepare("INSERT INTO attempts (id, task_id, executor_id, started_at) VALUES (?, ?, ?, datetime('now'))").run(
      attemptId,
      taskId,
      ownerId,
    );
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, agent_state, current_attempt_id, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, 0, 0, 'in_progress', ?, ?, ?)",
    ).run(subtaskId, taskId, `шаг ${slot}`, attemptId, planId, slot);
    db.prepare("UPDATE attempts SET subtask_id = ? WHERE id = ?").run(subtaskId, attemptId);
    return { subtaskId, attemptId };
  }

  const rows = (subtaskId: string) =>
    db
      .prepare("SELECT * FROM slot_work_snapshots WHERE subtask_id = ? ORDER BY created_at, rowid")
      .all(subtaskId) as Array<{ id: string; reason: string; is_complete: number; attempt_id: string | null; last_action: string | null }>;

  const backdate = (subtaskId: string, minutes: number) =>
    db.prepare("UPDATE slot_work_snapshots SET created_at = datetime('now', ?) WHERE subtask_id = ?").run(`-${minutes} minutes`, subtaskId);

  it("идущий слот получает техснимок, повторный тик в окне аренды пропускается", () => {
    const { subtaskId, attemptId } = makeNode("periodic1");
    const first = periodicSlotSnapshot(subtaskId);
    expect(first.written).toBe(true);
    if (!first.written) return;
    expect(first.snapshot.reason).toBe("progress");
    expect(first.snapshot.is_complete).toBe(0);
    expect(first.snapshot.attempt_id).toBe(attemptId);

    const second = periodicSlotSnapshot(subtaskId);
    expect(second).toEqual({ written: false, skipped: "fresh" });
    expect(rows(subtaskId)).toHaveLength(1);
  });

  it("после окна аренды одинаковый снимок не дублируется", () => {
    const { subtaskId } = makeNode("periodic2");
    periodicSlotSnapshot(subtaskId);
    backdate(subtaskId, 6);
    const again = periodicSlotSnapshot(subtaskId);
    expect(again).toEqual({ written: false, skipped: "unchanged" });
    expect(rows(subtaskId)).toHaveLength(1);
  });

  it("изменилось последнее действие — пишется новый снимок", () => {
    const { subtaskId } = makeNode("periodic3");
    periodicSlotSnapshot(subtaskId);
    backdate(subtaskId, 6);
    db.prepare("INSERT INTO task_events (id, task_id, kind, field, to_value) VALUES (?, ?, 'subtask_started', ?, ?)").run(
      crypto.randomUUID(),
      taskId,
      subtaskId,
      "шаг periodic3",
    );
    const next = periodicSlotSnapshot(subtaskId);
    expect(next.written).toBe(true);
    if (!next.written) return;
    expect(next.snapshot.last_action).toContain("subtask_started");
    expect(rows(subtaskId)).toHaveLength(2);
  });

  it("сданный или отпущенный слот техснимок не получает", () => {
    const { subtaskId } = makeNode("periodic4");
    db.prepare("UPDATE subtasks SET agent_state = 'blocked' WHERE id = ?").run(subtaskId);
    expect(periodicSlotSnapshot(subtaskId)).toEqual({ written: false, skipped: "not-working" });
    expect(rows(subtaskId)).toHaveLength(0);
  });

  it("история слота ограничена последними SNAPSHOT_KEEP", () => {
    const { subtaskId } = makeNode("periodic5");
    for (let i = 0; i < SNAPSHOT_KEEP + 5; i += 1) {
      saveSlotSnapshot({ subtaskId, reason: "progress", complete: true, done: `шаг ${i}` });
    }
    expect(slotSnapshotHistory(subtaskId, 100)).toHaveLength(SNAPSHOT_KEEP);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM slot_work_snapshots WHERE subtask_id = ?")
      .get(subtaskId) as { n: number };
    expect(count.n).toBe(SNAPSHOT_KEEP);
  });

  it("блокировка без снимка роли даёт техснимок с пометкой", () => {
    const { subtaskId } = makeNode("periodic6");
    const saved = technicalSlotSnapshot(subtaskId, "blocked", { blocker: "нужно решение владельца" });
    expect(saved).not.toBeNull();
    expect(saved!.snapshot.is_complete).toBe(0);
    expect(saved!.snapshot.blocker).toBe("нужно решение владельца");
  });

  it("потребитель снимка (интерфейс) видит последний техснимок", () => {
    const { subtaskId, attemptId } = makeNode("periodic8");
    periodicSlotSnapshot(subtaskId);
    const dto = slotSnapshotDto(subtaskId)!;
    expect(dto.latest).toMatchObject({ reason: "progress", is_complete: false, attempt_id: attemptId });
    expect(dto.latest_from_earlier_attempt).toBe(false);
    expect((dto.history as unknown[]).length).toBe(1);
  });

  it("продление аренды слота через API само пишет техснимок", async () => {
    const { subtaskId } = makeNode("periodic7");
    const beat = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(beat.statusCode).toBe(200);
    expect(rows(subtaskId)).toHaveLength(1);

    const beatAgain = await app.inject({
      method: "POST",
      url: `/api/subtasks/${subtaskId}/work`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(beatAgain.statusCode).toBe(200);
    expect(rows(subtaskId)).toHaveLength(1);
  });
});
