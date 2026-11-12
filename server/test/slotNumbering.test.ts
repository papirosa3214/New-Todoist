// Номер слота постоянный (владелец 08.11.2026; спецификация
// docs/2026-11-08-role-slot-chat-branches-spec.md §6): «Разработчик 1» и
// «Разработчик 2» не перенумеровываются, когда в план добавляют слот раньше
// по порядку, и упоминание «@Разработчик 2» остаётся тем же слотом.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import db from "../src/db.js";
import { slotFromMention, slotLabels } from "../src/lib/slotResolution.js";
import { demoteSeededOwner } from "./helpers/seedOwner.js";

vi.mock("../src/lib/embeddingClient.js", () => ({
  getEmbeddings: vi.fn(async () => ({ embeddings: [], dim: 0, durationMs: 0 })),
}));
vi.mock("../src/ws.js", () => ({
  resetAllOffline: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), onUserGone: vi.fn(),
  broadcast: vi.fn(), broadcastTaskEvent: vi.fn(), broadcastToUsers: vi.fn(),
}));

const TASK = "slotnum-task";
const PLAN = "slotnum-plan";

describe("Постоянный номер слота", () => {
  beforeAll(async () => {
    await buildApp();
    demoteSeededOwner(db);
    db.prepare("INSERT OR IGNORE INTO roles (key, title, summary, enabled, position) VALUES ('builder','Разработчик','пишет код',1,10)").run();
    const owner = (db.prepare("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined)?.id;
    const ownerId = owner ?? "slotnum-owner";
    if (!owner)
      db.prepare(
        "INSERT INTO users (id, name, role, type, email, password_hash) VALUES (?, 'Владелец','owner','human','slotnum@test','!test')",
      ).run(ownerId);
    db.prepare("INSERT INTO tasks (id, title, creator_id, status) VALUES (?, 'Два слота одной роли', ?, 'active')").run(TASK, ownerId);
    db.prepare(
      "INSERT INTO task_collaboration_plans (id, task_id, revision, status, profile, created_by) VALUES (?, ?, 1, 'approved', 'manual', ?)",
    ).run(PLAN, TASK, ownerId);
    const node = db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES (?, ?, ?, 'builder', 'Работа')",
    );
    node.run("slotnum-node-1", PLAN, "impl");
    node.run("slotnum-node-2", PLAN, "qa");
    const sub = db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES (?, ?, ?, 0, ?, ?, ?)",
    );
    sub.run("slotnum-sub-1", TASK, "Сборка", 0, PLAN, "impl");
    sub.run("slotnum-sub-2", TASK, "Проверка", 1, PLAN, "qa");
  });

  afterAll(() => {
    db.prepare("DELETE FROM subtasks WHERE task_id = ?").run(TASK);
    db.prepare("DELETE FROM task_collaboration_plan_nodes WHERE plan_id = ?").run(PLAN);
    db.prepare("DELETE FROM task_collaboration_plans WHERE id = ?").run(PLAN);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(TASK);
  });

  it("подписи идут по номерам слотов", () => {
    const labels = slotLabels(TASK).map((slot) => slot.label);
    expect(labels).toEqual(["Разработчик 1", "Разработчик 2"]);
  });

  it("номер не меняется, когда в план добавляют слот раньше по порядку", () => {
    const before = slotLabels(TASK).map((slot) => ({ id: slot.subtask_id, label: slot.label }));
    // Новый слот встаёт в начало плана: порядок меняется, номера — нет.
    db.prepare(
      "INSERT INTO task_collaboration_plan_nodes (id, plan_id, slot_key, role_key, expected_result) VALUES ('slotnum-node-3', ?, 'prep', 'builder', 'Подготовка')",
    ).run(PLAN);
    db.prepare(
      "INSERT INTO subtasks (id, task_id, title, done, position, collaboration_plan_id, plan_node_key) VALUES ('slotnum-sub-3', ?, 'Подготовка', 0, ?, ?, 'prep')",
    ).run(TASK, 0, PLAN);

    const after = slotLabels(TASK);
    for (const slot of before) {
      expect(after.find((row) => row.subtask_id === slot.id)?.label).toBe(slot.label);
    }
    // Новый слот получил третий номер своей роли.
    expect(after.find((row) => row.subtask_id === "slotnum-sub-3")?.label).toBe("Разработчик 3");
  });

  it("упоминание «@Разработчик 2» указывает на прежний слот", () => {
    expect(slotFromMention(TASK, "@Разработчик 2 посмотри сборку")).toBe("slotnum-sub-2");
    expect(slotFromMention(TASK, "@Разработчик 3 начни с подготовки")).toBe("slotnum-sub-3");
    expect(slotFromMention(TASK, "@Разработчик 2")).toBe("slotnum-sub-2");
  });
});
