// Ответ адресата на межсессионное обращение будит спросившую роль
// (владелец 11.11.2026): Помощник спросил Инженера .110 через сессию,
// инженер ответил, карточка закрылась — а Помощник так и не проснулся.
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { postToRoleSession, setCrossSessionWakeLauncher } from "../src/runtime/roleCrossSessionMessage.js";
import { claimMessageDelivery, finishMessageDelivery } from "../src/runtime/chatQueue.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";

const SENDER = "role_qa";
const RECIPIENT = "role_architect";
const OWNER = "u1";

describe("ответ на межсессионное обращение будит спросившего", () => {
  let senderChatId: string;
  const launched: string[] = [];

  beforeAll(() => {
    migrate();
    runMigrations();
    seedRoleAccounts(db);
    setCrossSessionWakeLauncher((input) => { launched.push(input.queueRowId); });
    senderChatId = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO chats(id,title,kind,created_by) VALUES(?,'Сессия','direct',?)").run(senderChatId, OWNER);
    for (const m of [OWNER, SENDER]) db.prepare("INSERT OR IGNORE INTO chat_members(chat_id,member_id) VALUES(?,?)").run(senderChatId, m);
  });

  it("ответ ложится к спросившему и поднимает ему ход ровно один раз", () => {
    const posted = postToRoleSession({ senderId: SENDER, senderChatId, recipientId: RECIPIENT, text: "Сколько памяти занято?" });
    db.prepare("INSERT INTO chat_messages(id,from_user_id,text,channel,chat_id,reply_to_message_id) VALUES(?,?,?,'chat',?,?)")
      .run(crypto.randomUUID(), RECIPIENT, "Занято 20 ГБ", posted.roomId, posted.questionId);
    expect(claimMessageDelivery(posted.queueRowId)).toBe(true);
    expect(finishMessageDelivery(posted.queueRowId, true)).toBe(true);

    const wake = db.prepare("SELECT id,message_id FROM chat_message_queue WHERE chat_id=? AND role_id=? AND delivery_id=?")
      .all(senderChatId, SENDER, `cross-session-answer:${posted.questionId}`) as { id: string; message_id: string }[];
    expect(wake).toHaveLength(1);
    const msg = db.prepare("SELECT text FROM chat_messages WHERE id=?").get(wake[0].message_id) as { text: string };
    expect(msg.text).toContain("Занято 20 ГБ");
    expect(launched).toEqual([wake[0].id]);
  });
});
