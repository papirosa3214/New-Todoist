import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import {
  captureQuestionWidget,
  captureTelegramFinal,
  foldQuestionWidget,
  markTelegramSending,
  settleTelegramDelivery,
  telegramOutbox,
} from "../src/integrations/telegram.js";
import { answerQuestionRow, createQuestionRow } from "../src/lib/chatQuestions.js";

const owner = "tg-question-owner";

function env() {
  process.env.TASKFLOW_TELEGRAM_INTEGRATION_SECRET = "integration-secret";
  process.env.TASKFLOW_TELEGRAM_BOT_ID = "42";
  process.env.TASKFLOW_TELEGRAM_OWNER_USER_ID = "100";
  process.env.TASKFLOW_TELEGRAM_OWNER_CHAT_ID = "100";
  process.env.TASKFLOW_TELEGRAM_STREAM = "edit";
  process.env.TASKFLOW_TELEGRAM_FINAL = "on";
  delete process.env.TASKFLOW_TELEGRAM_REACTIONS;
}

/** Входящее из Telegram → сообщение чата → вопрос, как в живом ходе роли. */
function askedQuestion() {
  const incoming = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id) VALUES(?,?,'Вопрос от владельца','chat','chat-secretary')`)
    .run(incoming, owner);
  db.prepare(`INSERT INTO telegram_inbound_ledger(id,bot_id,update_id,chat_id,user_id,message_id,payload_hash,state,taskflow_message_id)
    VALUES(?,?,?,?,?,?,'hash','posted',?)`)
    .run(crypto.randomUUID(), "42", 900, "100", "100", 500, incoming);
  const payload = {
    questions: [{ question: "Чинить things3?", header: "Things3", options: [{ label: "Да" }, { label: "Нет" }] }],
  };
  const question = createQuestionRow({ chatId: "chat-secretary", roleId: "u-secretary", payload });
  const messageId = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id)
    VALUES(?,?,'1. Чинить things3?','chat','chat-secretary',?)`).run(messageId, "u-secretary", incoming);
  db.prepare("UPDATE chat_questions SET message_id=? WHERE id=?").run(messageId, question.id);
  return { questionId: question.id, messageId, payload };
}

describe("telegram question widget", () => {
  beforeEach(() => {
    env();
    migrate();
    runMigrations();
    db.prepare("DELETE FROM telegram_delivery_outbox").run();
    db.prepare("DELETE FROM telegram_inbound_ledger").run();
    db.prepare("DELETE FROM chat_questions").run();
    db.prepare("DELETE FROM chat_messages WHERE from_user_id IN (?,?)").run(owner, "u-secretary");
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type) VALUES(?,?,?,'x','owner','human')")
      .run(owner, "Owner", "tg-question@test.local");
    db.prepare("INSERT OR IGNORE INTO users(id,name,email,password_hash,role,type,is_system_bot) VALUES('u-secretary','Secretary','s@test.local','x','agent','ai',1)").run();
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by,room_kind) VALUES('chat-secretary','Secretary','direct',?,'personal')").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES('chat-secretary',?)").run(owner);
    db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES('chat-secretary','u-secretary')").run();
  });

  it("sends the question as exactly one widget delivery and no text duplicate", () => {
    const { questionId, messageId } = askedQuestion();
    expect(captureQuestionWidget(questionId)).toBe(1);
    const rows = db.prepare("SELECT kind,payload_json FROM telegram_delivery_outbox").all() as Array<{ kind: string; payload_json: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("ack");
    const payload = JSON.parse(rows[0].payload_json);
    expect(payload.method).toBe("sendWidget");
    expect(payload.html).toContain("Чинить things3?");
    expect(payload.allow_queries).toBe(false);
    // Текст вопроса не уходит отдельным сообщением.
    expect(rows.some((row) => JSON.parse(row.payload_json).method === "sendMessage")).toBe(false);
    // Авто-финал с тем же текстом вопроса тоже не ставится.
    expect(captureTelegramFinal(messageId)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM telegram_delivery_outbox WHERE kind='final'").get()).toMatchObject({ n: 0 });
    // Повторный вызов не плодит второе сообщение.
    expect(captureQuestionWidget(questionId)).toBe(0);
  });

  it("folds the question widget into a short answered line once the owner answers", () => {
    const { questionId } = askedQuestion();
    captureQuestionWidget(questionId);
    const delivery = telegramOutbox(5)[0] as { delivery_id: string };
    expect(markTelegramSending(delivery.delivery_id)).toBe(true);
    settleTelegramDelivery(delivery.delivery_id, { ok: true, telegramMessageId: 777 });
    answerQuestionRow(questionId, { answers: [{ questionIndex: 0, selected: ["Да"] }] });
    expect(foldQuestionWidget(questionId)).toBe(1);
    const edit = db
      .prepare("SELECT payload_json FROM telegram_delivery_outbox WHERE payload_json LIKE '%editMessageWidgetData%'")
      .get() as { payload_json: string };
    const payload = JSON.parse(edit.payload_json);
    expect(payload.method).toBe("editMessageWidgetData");
    expect(payload.message_id).toBe(777);
    expect(payload.html).toContain("Вопрос: Чинить things3?");
    expect(payload.html).toContain("Ответ: Да");
    // Живого виджета со списком кнопок больше нет.
    expect(payload.html).not.toContain("<ul>");
    expect(foldQuestionWidget(questionId)).toBe(0);
  });

  it("does not fold anything when the widget never reached Telegram", () => {
    const { questionId } = askedQuestion();
    captureQuestionWidget(questionId);
    answerQuestionRow(questionId, { answers: [{ questionIndex: 0, selected: ["Нет"] }] });
    expect(foldQuestionWidget(questionId)).toBe(0);
  });
});
