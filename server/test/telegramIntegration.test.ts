import { beforeEach, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { acceptTelegramInbound, captureTelegramFinal, captureTelegramProgress, markTelegramSending, settleTelegramDelivery, telegramOutbox } from "../src/integrations/telegram.js";

const owner = "telegram-test-owner";
const env = () => {
  process.env.TASKFLOW_TELEGRAM_INTEGRATION_SECRET = "integration-secret";
  process.env.TASKFLOW_TELEGRAM_BOT_ID = "42";
  process.env.TASKFLOW_TELEGRAM_OWNER_USER_ID = "100";
  process.env.TASKFLOW_TELEGRAM_OWNER_CHAT_ID = "100";
  // Поток — правкой: режим «черновик» статус-пузырь не заводит (этап 4).
  process.env.TASKFLOW_TELEGRAM_STREAM = "edit";
  delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
  // По умолчанию авто-пересылка финала выключена; старые тесты проверяют
  // включённое поведение — им нужен явный "on". Выключенное проверяется ниже.
  process.env.TASKFLOW_TELEGRAM_FINAL = "on";
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

  it("deduplicates update_id and creates one TaskFlow message and one role delivery", async () => {
    const input = { bot_id: "42", update_id: 7, chat_id: 100, user_id: 100, chat_type: "private", message_id: 55, text: "Привет" };
    const first = await acceptTelegramInbound(input);
    const second = await acceptTelegramInbound(input);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, ledger_id: first.ledger_id, message_id: first.message_id, ack_delivery_id: null });
    expect((db.prepare("SELECT COUNT(*) n FROM chat_messages WHERE id=?").get(first.message_id) as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM chat_message_queue WHERE delivery_id='tg:42:7'").get() as any).n).toBe(1);
    // Немедленного «Принял.» больше нет: приём не создаёт доставок.
    expect(telegramOutbox(5).length).toBe(0);
  });

  it("sends a single status message only after the run gets slow, and skips it once answered", async () => {
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 11, chat_id: 100, user_id: 100, chat_type: "private", message_id: 61, text: "Долгий вопрос" });
    expect(captureTelegramProgress(first.message_id as string)).toBe(1);
    expect(telegramOutbox(5).filter((row: any) => row.kind === "progress").length).toBe(1);
    expect(captureTelegramProgress(first.message_id as string)).toBe(0);
    const reply = "reply-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)").run(reply, "u-secretary", "Ответ", "chat-secretary", first.message_id);
    expect(captureTelegramProgress(first.message_id as string)).toBe(0);
    expect(captureTelegramFinal(reply)).toBe(1);
    const final = db.prepare("SELECT chat_id,payload_json FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply) as any;
    expect(JSON.parse(final.payload_json)).toMatchObject({ text: "Ответ", reply_to_message_id: 61 });
    expect(final.chat_id).toBe("100");
  });

  it("rejects non-allowlisted principals before posting", async () => {
    await expect(acceptTelegramInbound({ bot_id: "42", update_id: 8, chat_id: 101, user_id: 101, chat_type: "private", message_id: 56, text: "Нет" })).rejects.toThrow("principal_not_allowed");
    expect((db.prepare("SELECT state FROM telegram_inbound_ledger WHERE update_id=8").get() as any).state).toBe("rejected");
  });

  it("moves delivery through retry and delivered without recreating execution", async () => {
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 9, chat_id: 100, user_id: 100, chat_type: "private", message_id: 57, text: "Проверка" });
    expect(captureTelegramProgress(first.message_id as string)).toBe(1);
    const delivery = telegramOutbox(5).find((row: any) => row.kind === "progress") as any;
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

  it("treats kind as policy and payload.method as transport without a schema migration", async () => {
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 21, chat_id: 100, user_id: 100, chat_type: "private", message_id: 71, text: "Контракт" });
    const reply = "reply-contract-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)").run(reply, "u-secretary", "Итог", "chat-secretary", first.message_id);
    expect(captureTelegramFinal(reply)).toBe(1);
    const row = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply) as any;
    expect(row.kind).toBe("final");
    expect(JSON.parse(row.payload_json)).toMatchObject({ method: "sendMessage", text: "Итог", reply_to_message_id: 71 });
    // Финал идёт со звуком: disable_notification в payload финала нет.
    expect(JSON.parse(row.payload_json).disable_notification).toBeUndefined();
  });

  it("puts a thumbs-up on the final answer only when reactions are switched on", async () => {
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 22, chat_id: 100, user_id: 100, chat_type: "private", message_id: 72, text: "Реакции" });
    const reply = "reply-reaction-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)").run(reply, "u-secretary", "Готово", "chat-secretary", first.message_id);
    expect(captureTelegramFinal(reply)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM telegram_delivery_outbox WHERE payload_json LIKE '%setMessageReaction%'").get() as any).toEqual({ n: 0 });

    process.env.TASKFLOW_TELEGRAM_REACTIONS = "on";
    const second = await acceptTelegramInbound({ bot_id: "42", update_id: 23, chat_id: 100, user_id: 100, chat_type: "private", message_id: 73, text: "Реакции вкл" });
    const rows = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox WHERE payload_json LIKE '%setMessageReaction%'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("progress");
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({ method: "setMessageReaction", message_id: 73, reaction: [{ type: "emoji", emoji: "👀" }] });
    const reply2 = "reply-reaction2-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)").run(reply2, "u-secretary", "Готово", "chat-secretary", second.message_id);
    expect(captureTelegramFinal(reply2)).toBe(1);
    const mark = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox WHERE kind='final' AND payload_json LIKE '%setMessageReaction%' ORDER BY created_at DESC").get() as any;
    expect(mark.kind).toBe("final");
    expect(JSON.parse(mark.payload_json).reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
    delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
  });

  it("marks a stopped or failed reply with a thumbs-down", async () => {
    process.env.TASKFLOW_TELEGRAM_REACTIONS = "1";
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 24, chat_id: 100, user_id: 100, chat_type: "private", message_id: 74, text: "Ошибка" });
    const reply = "reply-failed-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id,stop_reason) VALUES(?,?,?,'chat',?,?,?)").run(reply, "u-secretary", "Сбой", "chat-secretary", first.message_id, "overflow");
    expect(captureTelegramFinal(reply)).toBe(1);
    const mark = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox WHERE kind='error' AND payload_json LIKE '%setMessageReaction%' ORDER BY created_at DESC").get() as any;
    expect(mark.kind).toBe("error");
    expect(JSON.parse(mark.payload_json).reaction).toEqual([{ type: "emoji", emoji: "👎" }]);
    delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
  });

  it("does not enqueue the final text while TASKFLOW_TELEGRAM_FINAL is off", async () => {
    delete process.env.TASKFLOW_TELEGRAM_FINAL;
    process.env.TASKFLOW_TELEGRAM_REACTIONS = "on";
    const first = await acceptTelegramInbound({ bot_id: "42", update_id: 41, chat_id: 100, user_id: 100, chat_type: "private", message_id: 91, text: "без дубля" });
    const reply = "reply-final-off-" + Date.now();
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)").run(reply, "u-secretary", "Ответ без Telegram", "chat-secretary", first.message_id);
    expect(captureTelegramFinal(reply)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM telegram_delivery_outbox WHERE source_message_id=? AND kind='final'").get(reply) as any).toEqual({ n: 0 });
    // Реакция 👍 на финале остаётся — выключатель касается только текста.
    const mark = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox WHERE kind='final' AND payload_json LIKE '%setMessageReaction%' ORDER BY created_at DESC").get() as any;
    expect(mark.kind).toBe("final");
    expect(JSON.parse(mark.payload_json).reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
    // Прогресс и typing выключатель не трогает: на чистом триггере статус ставится.
    const next = await acceptTelegramInbound({ bot_id: "42", update_id: 42, chat_id: 100, user_id: 100, chat_type: "private", message_id: 92, text: "Долгий" });
    expect(captureTelegramProgress(next.message_id as string)).toBe(1);
    delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
  });

  it("keeps dupe protection when the same update arrives twice", async () => {
    const input = { bot_id: "42", update_id: 31, chat_id: 100, user_id: 100, chat_type: "private", message_id: 81, text: "Дубль" };
    const first = await acceptTelegramInbound(input);
    const again = await acceptTelegramInbound(input);
    expect(again.duplicate).toBe(true);
    expect(again.message_id).toBe(first.message_id);
    expect((db.prepare("SELECT COUNT(*) n FROM chat_message_queue WHERE delivery_id='tg:42:31'").get() as any).n).toBe(1);
  });
});
