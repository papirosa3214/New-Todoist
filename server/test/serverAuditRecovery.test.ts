import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
vi.mock("../src/routes/chats.js", () => ({ recoverAgentDelivery: vi.fn() }));
import { recoverAgentDelivery } from "../src/routes/chats.js";
import { sweepRecoverableDeliveries } from "../src/runtime/chatQueueRecovery.js";

beforeAll(() => {
  migrate(); runMigrations();
  db.prepare("INSERT INTO chats(id,title) VALUES ('audit-recovery','fixture')").run();
});
beforeEach(() => {
  db.prepare("DELETE FROM chat_message_queue").run();
  vi.mocked(recoverAgentDelivery).mockReset();
  vi.mocked(recoverAgentDelivery).mockImplementation(async ({ queueRowId }) => {
    db.prepare("UPDATE chat_message_queue SET status='done' WHERE id=?").run(queueRowId);
    return { status: "done", replyId: null };
  });
});
function seed(n: number) {
  for (let i=0; i<n; i++) db.prepare(`INSERT INTO chat_message_queue
    (id,chat_id,role_id,delivery_id,payload_json) VALUES (?, 'audit-recovery', 'u1', ?, '{}')`)
    .run(`audit-${i}`, `audit-${i}`);
}
describe("server audit: recovery sweep completeness", () => {
  it("recovers a backlog beyond the default 50-row reader cap", async () => {
    seed(51);
    expect(await sweepRecoverableDeliveries()).toBe(51);
    expect(recoverAgentDelivery).toHaveBeenCalledTimes(51);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_message_queue WHERE status='pending'").get()).toEqual({n:0});
  });
  it("continues after one bad persisted delivery without dropping its pending state", async () => {
    seed(2);
    vi.mocked(recoverAgentDelivery).mockRejectedValueOnce(new Error("invalid persisted payload"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sweepRecoverableDeliveries()).toBe(1);
      expect(recoverAgentDelivery).toHaveBeenCalledTimes(2);
      expect(db.prepare("SELECT status FROM chat_message_queue WHERE id='audit-0'").get()).toEqual({status:"pending"});
    } finally { warn.mockRestore(); }
  });
});
