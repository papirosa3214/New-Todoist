import { beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { acceptTelegramInbound, markTelegramSending, settleTelegramDelivery, telegramOutbox } from "../src/integrations/telegram.js";

const owner = "telegram-test-owner";
const env = () => {
  process.env.TASKFLOW_TELEGRAM_INTEGRATION_SECRET = "integration-secret";
  process.env.TASKFLOW_TELEGRAM_BOT_ID = "42";
  process.env.TASKFLOW_TELEGRAM_OWNER_USER_ID = "100";
  process.env.TASKFLOW_TELEGRAM_OWNER_CHAT_ID = "100";
};

describe("telegram secretary integration", () => {
  beforeEach(() => {
    env();
    migrate();
    runMigrations();
    db.prepare("DELETE FROM telegram_delivery_outbox").run();
    db.prepare("DELETE FROM telegram_inbound_ledger").run();
    db.prepare("DELETE FROM chat_message_queue WHERE delivery_id LIKE 'tg:%'").run();
    db.prepare("DELETE FROM chat_messages WHERE from_user_id=?").run(owner);
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'x','owner','human')").run(owner, "Owner", "telegram-owner@test.local");
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,is_system_bot) VALUES('u-secretary','Secretary','secretary@test.local','x','agent','ai',1)").run();
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by,room_kind) VALUES('chat-secretary','Secretary','direct',?,'personal')").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES('chat-secretary',?)").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES('chat-secretary','u-secretary')").run();
  });

  it("deduplicates update_id and creates one TaskFlow message and one role delivery", () => {
    const input = { bot_id: "42", update_id: 7, chat_id: 100, user_id: 100, chat_type: "private", message_id: 55, text: "Привет" };
    const first = acceptTelegramInbound(input);
    const second = acceptTelegramInbound(input);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ duplicate: true, ledger_id: first.ledger_id, message_id: first.message_id, ack_delivery_id: first.ack_delivery_id });
    expect((db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE id=?").get(first.message_id) as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM chat_message_queue WHERE delivery_id='tg:42:7'").get() as any).n).toBe(1);
  });

  it("rejects non-allowlisted principals before posting", () => {
    expect(() => acceptTelegramInbound({ bot_id: "42", update_id: 8, chat_id: 101, user_id: 101, chat_type: "private", message_id: 56, text: "Нет" })).toThrow("principal_not_allowed");
    expect((db.prepare("SELECT state FROM telegram_inbound_ledger WHERE update_id=8").get() as any).state).toBe("rejected");
  });

  it("moves delivery through retry and delivered without recreating execution", () => {
    const first = acceptTelegramInbound({ bot_id: "42", update_id: 9, chat_id: 100, user_id: 100, chat_type: "private", message_id: 57, text: "Проверка" });
    const delivery = telegramOutbox(5).find((row: any) => row.delivery_id === first.ack_delivery_id) as any;
    expect(markTelegramSending(delivery.delivery_id)).toBe(true);
    settleTelegramDelivery(delivery.delivery_id, { ok: false, error: "timeout" });
    const state = db.prepare("SELECT state,attempts FROM telegram_delivery_outbox WHERE delivery_id=?").get(delivery.delivery_id) as any;
    expect(state).toEqual({ state: "retry_wait", attempts: 1 });
    db.prepare("UPDATE telegram_delivery_outbox SET next_attempt_at=datetime('now','-1 second') WHERE delivery_id=?").run(delivery.delivery_id);
    expect(markTelegramSending(delivery.delivery_id)).toBe(true);
    settleTelegramDelivery(delivery.delivery_id, { ok: true, telegramMessageId: 999 });
    expect(db.prepare("SELECT state,telegram_message_id FROM telegram_delivery_outbox WHERE delivery_id=?").get(delivery.delivery_id)).toEqual({ state: "delivered", telegram_message_id: 999 });
    expect((db.prepare("SELECT COUNT(*) n FROM chat_message_queue WHERE delivery_id='tg:42:9'").get() as any).n).toBe(1);
  });
});
